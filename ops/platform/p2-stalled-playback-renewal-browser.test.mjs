import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateP2StalledPlaybackRenewalReceipt, watchP2StalledPlaybackRenewal } from "./p2-lifecycle-browser-recorder.mjs";

const refused = /P2_STALLED_PLAYBACK_RENEWAL_BROWSER_REFUSED/u;
const playbackId = "ownedStalledPlayback";
const playbackIdSha256 = createHash("sha256").update(playbackId).digest("hex");
const target = { actorId: randomUUID(), courseId: randomUUID(), lessonId: randomUUID(), playbackIdSha256 };
const lessonPath = `/academy/courses/${target.courseId}/lessons/${target.lessonId}`;
const playbackPath = `/api/academy/lessons/${target.lessonId}/playback`;
const mediaHost = "stream.mux.com";
const privateCache = { "cache-control": "private, no-store" };
const permit = "__Host-lash-p2q-window";

function sourceReceipt() {
  const base = Date.parse("2026-11-09T20:00:00.000Z");
  const mark = elapsedMs => ({ elapsedMs, observedAt: new Date(base + elapsedMs).toISOString() });
  return { version: 1, status: "P2_STALLED_PLAYBACK_RENEWAL_BROWSER_OBSERVED", evidenceClass: "source-browser-observation", actorId: target.actorId,
    page: { pathname: lessonPath, status: 200 }, playback: { requestId: randomUUID(), playbackIdSha256,
      serverDate: new Date(base).toUTCString(), expiresAt: new Date(base + 600_000).toISOString(),
      thumbnailExpiresAt: new Date(base + 600_000).toISOString(), lifetimeMs: 600_000 },
    media: { manifestObserved: true, segmentObserved: true, nativeVideoObserved: true },
    observation: { initialRequest: mark(100), baseline: mark(1_100), fenceConfirmed: mark(2_100), renewalStarted: mark(569_200),
      playerLastPresent: mark(599_050), playerRemoved: mark(599_150), retryVisible: mark(599_151), expectedExpiryElapsedMs: 599_100,
      renewal: { pathname: playbackPath, method: "GET", count: 1, forwarded: false, responseObserved: false }, permitCookieAbsent: true } };
}

test("stalled renewal receipt binds the exact lesson, strict timing and no replay", () => {
  const receipt = sourceReceipt();
  assert.equal(validateP2StalledPlaybackRenewalReceipt(receipt, target), receipt);
  const variants = [
    row => { row.evidenceClass = "owned-https-fixture"; },
    row => { row.actorId = randomUUID(); },
    row => { row.playback.playbackIdSha256 = "a".repeat(64); },
    row => { row.playback.playbackToken = "synthetic"; },
    row => { row.playback.lifetimeMs = 5_000; },
    row => { row.media.segmentObserved = false; },
    row => { row.observation.fenceConfirmed = row.observation.renewalStarted; },
    row => { row.observation.playerRemoved = row.observation.renewalStarted; },
    row => { row.observation.playerRemoved.observedAt = row.observation.renewalStarted.observedAt; },
    row => { row.observation.permitCookieAbsent = false; },
    row => { row.observation.renewal.count = 2; },
    row => { row.observation.renewal.forwarded = true; },
    row => { row.observation.renewal.responseObserved = true; },
  ];
  for (const drift of variants) {
    const changed = structuredClone(receipt);
    drift(changed);
    assert.throws(() => validateP2StalledPlaybackRenewalReceipt(changed, target));
  }
});

test("owned Chromium holds one renewal of the real player until authorization expires", {
  skip: process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST !== "true",
}, async () => {
  const [{ chromium }, { build }] = await Promise.all([import("playwright"), import("esbuild")]);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const bundle = (await build({ bundle: true, write: false, jsx: "automatic", logLevel: "silent", absWorkingDir: repo,
    stdin: { resolveDir: repo, loader: "tsx", contents: `
      import {createRoot} from "react-dom/client";
      import {AuthorizedVideo} from "./src/components/learning/authorized-video";
      const lesson = {id: ${JSON.stringify(target.lessonId)}, title: "Owned stalled lesson", captions: []};
      createRoot(document.querySelector("main")).render(<AuthorizedVideo lesson={lesson} resume={0} onPosition={() => {}} />);
    ` }, define: { "process.env": '{"NODE_ENV":"production"}', "process.env.NODE_ENV": '"production"' } })).outputFiles[0].contents;
  const playlist = readFileSync(new URL("../../tests/fixtures/course-mux-long.m3u8", import.meta.url));
  const segment = readFileSync(new URL("../../tests/fixtures/course-mux-0.mpegts", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "owned-stalled-renewal-"));
  const key = join(root, "key.pem"), cert = join(root, "cert.pem"), sockets = new Set();
  let https, proxy, browser, origin, serve;
  const track = socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const bind = server => new Promise((done, fail) => {
    server.on("connection", track);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done(server.address().port));
  });
  const send = (response, status, type, value, headers = {}) => {
    const bytes = Buffer.from(value);
    response.writeHead(status, { "content-type": type, "content-length": bytes.length, ...headers }).end(bytes);
  };
  try {
    assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", `/CN=${mediaHost}`, "-keyout", key, "-out", cert], { stdio: "ignore" }).status, 0);
    https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => serve(request, response));
    const port = await bind(https);
    origin = `https://127.0.0.1:${port}`;
    proxy = createHttpServer((_request, response) => response.writeHead(403).end());
    proxy.on("connect", (request, socket, head) => {
      if (![`${mediaHost}:443`, "image.mux.com:443", `127.0.0.1:${port}`].includes(request.url)) { socket.destroy(); return; }
      const destination = connect(port, "127.0.0.1");
      track(destination);
      destination.once("error", () => socket.destroy());
      socket.once("error", () => destination.destroy());
      destination.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (head.length) destination.write(head);
        socket.pipe(destination).pipe(socket);
      });
    });
    const proxyPort = await bind(proxy);
    browser = await chromium.launch();
    for (const scenario of ["natural", "duplicate", "premature-removal", "permit-retained", "aborted"]) {
      let playbackRequests = 0, manifestRequests = 0, segmentRequests = 0, authorization;
      const token = (aud, exp) => [Buffer.from('{"alg":"RS256"}').toString("base64url"),
        Buffer.from(JSON.stringify({ aud, sub: playbackId, exp })).toString("base64url"),
        Buffer.from("owned-https-fixture-signature").toString("base64url")].join(".");
      serve = (request, response) => {
        const { host, cookie } = request.headers;
        const url = new URL(request.url, `https://${host}`);
        if (host === mediaHost) {
          const cors = { "access-control-allow-origin": origin };
          if (url.pathname === `/${playbackId}.m3u8` && url.searchParams.get("token") === authorization?.playbackToken) {
            manifestRequests++;
            return send(response, 200, "application/vnd.apple.mpegurl", playlist, cors);
          }
          if (url.pathname === "/course-mux-0.mpegts" && /^[0-3]$/u.test(url.searchParams.get("segment") ?? "")) {
            segmentRequests++;
            return send(response, 200, "video/mp2t", segment, cors);
          }
        }
        if (url.origin === origin) {
          if (url.pathname === "/bundle.js") return send(response, 200, "application/javascript", bundle);
          if (cookie?.includes("__Host-owned-stalled-learner=fixture")) {
            if (url.pathname === lessonPath) return send(response, 200, "text/html; charset=utf-8",
              '<!doctype html><main></main><script src="/bundle.js"></script>', privateCache);
            if (url.pathname === playbackPath) {
              playbackRequests++;
              const now = Math.floor(Date.now() / 1000), expiresAt = new Date((now + 5) * 1_000).toISOString();
              authorization = { expiresAt, thumbnailExpiresAt: expiresAt, playbackId, playbackToken: token("v", now + 5), thumbnailToken: token("t", now + 5) };
              return send(response, 200, "application/json", JSON.stringify(authorization), { ...privateCache,
                date: new Date(now * 1_000).toUTCString(), "x-request-id": randomUUID() });
            }
          }
        }
        return send(response, 404, "text/plain", "");
      };
      const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxyPort}` },
        ignoreHTTPSErrors: true, serviceWorkers: "block" });
      const page = await context.newPage(), controller = new AbortController();
      const watcher = watchP2StalledPlaybackRenewal(page, origin, target, { signal: controller.signal });
      try {
        await context.addCookies(["__Host-owned-stalled-learner", permit].map(name => ({ name, value: "fixture",
          url: origin, secure: true, httpOnly: true })));
        const baseline = await watcher.baseline(Math.floor(Date.now() / 1_000) + 10);
        assert.equal(baseline.playback.lifetimeMs, 5_000);
        assert.ok(manifestRequests >= 1 && segmentRequests >= 1);
        if (scenario !== "permit-retained") await context.clearCookies({ name: permit });
        if (scenario === "natural") {
          const receipt = await watcher.confirmFenced();
          assert.equal(receipt.evidenceClass, "owned-https-fixture");
          assert.equal(receipt.observation.renewal.count, 1);
          assert.equal(receipt.observation.renewal.forwarded, false);
          assert.equal(receipt.observation.renewal.responseObserved, false);
          assert.throws(() => validateP2StalledPlaybackRenewalReceipt(receipt, target));
          const output = JSON.stringify(receipt);
          assert.ok(!output.includes(authorization.playbackToken) && !output.includes(authorization.thumbnailToken) && !output.includes(`"${playbackId}"`));
        } else if (scenario === "permit-retained") {
          await assert.rejects(watcher.confirmFenced(), refused);
        } else {
          const renewal = page.waitForRequest(request => request.url() === origin + playbackPath, { timeout: 3_000 });
          const refusedObservation = assert.rejects(watcher.confirmFenced(), refused);
          await renewal;
          if (scenario === "duplicate") {
            await page.evaluate(path => { void fetch(path).catch(() => {}); }, playbackPath);
          } else if (scenario === "premature-removal") {
            await page.locator("mux-player").evaluate(element => element.dispatchEvent(new Event("error")));
          } else {
            controller.abort();
          }
          await refusedObservation;
        }
        assert.equal(playbackRequests, 1, scenario);
      } finally {
        await watcher.close();
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, https].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  }
});
