import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2InteractiveBrowserEntryPath, p2LessonDenialPaths, validateP2InteractiveBrowserInput, validateP2InteractiveBrowserPermit,
  validateP2LessonDenialReceipt, watchP2LessonDenial } from "./p2-lifecycle-browser-recorder.mjs";

const origin = "https://staging.lashher.com";
const heading = "Enrollment required", description = "Open the course page to enroll or check your access.";
const privateCache = { "cache-control": "private, no-store" };
const refusal = /P2_INTERACTIVE_LESSON_DENIAL_RESPONSE_REFUSED/u;

function selection() {
  const target = { actorId: randomUUID(), operation: "deny-cross-account", courseId: randomUUID(), lessonId: randomUUID(),
    enrolledActorId: randomUUID(), grantId: randomUUID() };
  const input = { version: 2, environment: "staging", actionId: "owned-lesson-denial", challenge: "b".repeat(64), bindingSha256: "c".repeat(64),
    sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app",
    browserOrigin: origin, stage: "lesson-denial", epoch: "11", windowSeconds: 60, lessonDenial: target };
  const paths = p2LessonDenialPaths(target);
  const receipt = { page: { pathname: paths.lessonPath, documentStatus: 200, flightStatus: 200,
    documentRequestId: randomUUID(), flightRequestId: randomUUID() },
    reads: paths.targets.map(target => ({ target, status: 403, requestId: randomUUID(), code: "access_required" })) };
  return { input, target, receipt, ...paths };
}

test("lesson denial scope and receipt bind distinct customers, exact request paths, statuses and request IDs", () => {
  const { input, target, receipt, lessonPath, flightPath } = selection();
  const issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const selector = (target.actorId + target.courseId + target.lessonId).replaceAll("-", "");
  const cookie = ["v2", input.epoch, input.stage, issued, expires, "a".repeat(32), selector, "b".repeat(64)].join(".");
  const permit = { stage: input.stage, epoch: input.epoch, expires, cookie };
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), lessonPath);
  assert.equal(flightPath, lessonPath + "?_rsc");
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  assert.throws(() => validateP2InteractiveBrowserInput({ ...input, lessonDenial: { ...target, enrolledActorId: target.actorId } }));
  for (const key of ["actorId", "courseId", "lessonId"]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, lessonDenial: { ...target, [key]: randomUUID() } }));
  }
  assert.equal(validateP2LessonDenialReceipt(receipt, target), receipt);
  const changeRead = update => [{ ...receipt.reads[0], ...update }, ...receipt.reads.slice(1)];
  for (const changed of [
    { ...receipt, page: { ...receipt.page, flightStatus: 307 } },
    { ...receipt, page: { ...receipt.page, documentRequestId: receipt.page.flightRequestId } },
    { ...receipt, page: { ...receipt.page, documentRequestId: "invalid" } },
    { ...receipt, page: { ...receipt.page, flightRequestId: receipt.reads[0].requestId } },
    { ...receipt, reads: [...receipt.reads].reverse() },
    { ...receipt, reads: changeRead({ requestId: receipt.reads[1].requestId }) },
    { ...receipt, reads: changeRead({ code: "sign_in_required" }) },
    { ...receipt, reads: changeRead({ status: 200 }) },
    { ...receipt, reads: changeRead({ body: { lesson: "private" } }) },
  ]) assert.throws(() => validateP2LessonDenialReceipt(changed, target));
});

test("owned Chromium observes the exact credentialed lesson denial and refuses private or redirected responses",
  { skip: process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST !== "true" }, async () => {
    const { chromium } = await import("playwright"), root = mkdtempSync(join(tmpdir(), "owned-p2-lesson-denial-"));
    const host = new URL(origin).hostname, key = join(root, "key.pem"), cert = join(root, "cert.pem"), sockets = new Set();
    let browser, https, proxy, serve;
    const track = socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
    const bind = server => new Promise((done, fail) => {
      server.on("connection", track);
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done(server.address().port));
    });
    try {
      assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", `/CN=${host}`, "-keyout", key, "-out", cert], { stdio: "ignore" }).status, 0);
      https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
        if (!serve || request.headers.host !== host) return response.writeHead(403).end();
        serve(request, response);
      });
      const tlsPort = await bind(https);
      proxy = createHttpServer((_request, response) => response.writeHead(403).end());
      proxy.on("connect", (request, socket, head) => {
        if (request.url !== `${host}:443`) { socket.destroy(); return; }
        const target = connect(tlsPort, "127.0.0.1");
        track(target);
        target.once("error", () => socket.destroy());
        socket.once("error", () => target.destroy());
        target.once("connect", () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head.length) target.write(head);
          socket.pipe(target).pipe(socket);
        });
      });
      const proxyPort = await bind(proxy);
      browser = await chromium.launch();
      const refusedAt = { "public-document": 1, "private-document": 1, "dom-reference-mismatch": 1, "raw-reference-missing": 1,
        "raw-content-canary": 1, "raw-transcript-canary": 1, "large-document": 1, "redirect-flight": 2, "wrong-flight-vary": 2,
        "public-flight": 2, "private-flight": 2, "flight-quiz-canary": 2, "wrong-flight": 2, "flight-reference-reused": 2,
        "flight-reference-other-row": 2, "flight-reference-other-section": 2,
        "public-api": 3, "wrong-api-error": 3, "success-playback": 4, "flight-bff-reference": 7 };
      for (const scenario of ["success", ...Object.keys(refusedAt)]) {
        const { input, receipt, lessonPath, flightPath, targets } = selection(), effects = [];
        const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true });
        await context.addCookies([{ name: "owned-customer", value: "fixture-session", url: origin + "/" }]);
        serve = (request, response) => {
          const send = (status, headers, body = "") =>
            response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) }).end(body);
          const index = targets.indexOf(request.url);
          if (request.url === lessonPath || request.url === flightPath || index !== -1) {
            effects.push({ target: request.url, method: request.method, rsc: request.headers.rsc ?? null,
              session: request.headers.cookie?.includes("owned-customer=fixture-session") === true });
          }
          if (request.url === lessonPath) {
            const domReference = scenario === "dom-reference-mismatch" ? randomUUID() : receipt.page.documentRequestId;
            const rawReference = scenario === "raw-reference-missing" ? "" : `Reference: <!-- -->${receipt.page.documentRequestId}`;
            const html = `<!doctype html><main><section aria-labelledby="learning-unavailable-title"><h1 id="learning-unavailable-title">${heading}</h1>
              <p>${description}</p><p id="owned-reference">${rawReference}</p></section></main>
              ${scenario === "private-document" ? '<script type="application/json">{"quizState":"private"}</script>' : ""}
              ${scenario === "raw-content-canary" ? '<!-- raw P2Q-S07-PRIVATE-CONTENT -->' : ""}
              ${scenario === "raw-transcript-canary" ? '<!-- raw p2q-s07-private-transcript -->' : ""}
              ${scenario === "large-document" ? "<!--" + "x".repeat(1024 * 1024) + "-->" : ""}
              <script>void fetch('/courses?_rsc=fixture',{headers:{RSC:'1','Next-Router-Prefetch':'1'}});
                document.querySelector('#owned-reference').textContent = ${JSON.stringify("Reference: " + domReference)};
                window.fetch = () => { throw new Error('Owned page-world fetch override'); };</script>`;
            return send(200, { "content-type": "text/html", ...(scenario === "public-document" ? { "cache-control": "public" } : privateCache) }, html);
          }
          if (request.url === flightPath) {
            if (scenario === "redirect-flight") return send(307, { location: lessonPath + "?_rsc=redirect" });
            const flightId = scenario === "flight-reference-reused" ? receipt.page.documentRequestId
              : scenario === "flight-bff-reference" ? receipt.reads[0].requestId : receipt.page.flightRequestId;
            const reference = ["$", "p", null, { children: ["Reference: ", flightId] }];
            const outside = ["flight-reference-other-row", "flight-reference-other-section"].includes(scenario);
            const denial = ["$", "section", null, { "aria-labelledby": "learning-unavailable-title",
              children: [["$", "h1", null, { id: "learning-unavailable-title", children: heading }],
                ["$", "p", null, { children: description }], ...(outside ? [] : [reference])] }];
            const flight = scenario === "wrong-flight" ? '1:"Sign in to continue"\n'
              : "1:" + JSON.stringify(scenario === "flight-reference-other-section" ? [denial, reference] : denial) + "\n";
            return send(200, { "content-type": "text/x-component", vary: scenario === "wrong-flight-vary" ? "Accept-Encoding" : "RSC",
              ...(scenario === "public-flight" ? { "cache-control": "public" } : privateCache) },
              flight + (scenario === "private-flight" ? '2:{"playbackToken":"private"}\n' : "")
              + (scenario === "flight-quiz-canary" ? '2:"plain p2q-s07-private-quiz"\n' : "")
              + (scenario === "flight-reference-other-row" ? "2:" + JSON.stringify(reference) + "\n" : ""));
          }
          if (index === -1) return send(404, { "content-type": "text/plain" });
          const requestId = receipt.reads[index].requestId;
          const headers = { "content-type": "application/json", "x-request-id": requestId,
            ...(scenario === "public-api" ? { "cache-control": "public" } : privateCache) };
          if (scenario === "success-playback" && index === 1) return send(200, headers, '{"playbackToken":"private"}');
          const body = { error: { code: scenario === "wrong-api-error" ? "sign_in_required" : "access_required",
            message: "Course access is required." }, requestId };
          return send(403, headers, JSON.stringify(body));
        };
        const page = await context.newPage(), watch = watchP2LessonDenial(context, page, input);
        const expires = Math.floor(Date.now() / 1000) + 60;
        try {
          if (scenario === "success") {
            await watch.open(expires);
            await watch.wait(expires);
            assert.deepEqual(watch.finish(), receipt);
            assert.deepEqual(effects, [lessonPath, flightPath, ...targets].map(target =>
              ({ target, method: "GET", rsc: target === flightPath ? "1" : null, session: true })));
            assert.doesNotMatch(JSON.stringify(watch.finish()), /fixture-session|playbackToken|Enrollment required/u);
            await Promise.all([
              page.waitForRequest(request => request.method() === "POST" && request.url() === origin + "/api/academy/progress"),
              page.evaluate(() => {
                const form = document.createElement("form");
                form.method = "POST";
                form.action = "/api/academy/progress";
                document.body.append(form);
                form.submit();
              }),
            ]);
            assert.throws(() => watch.finish(), refusal);
          } else {
            await assert.rejects(async () => { await watch.open(expires); await watch.wait(expires); }, refusal);
            assert.deepEqual(effects.map(effect => effect.target), [lessonPath, flightPath, ...targets].slice(0, refusedAt[scenario]));
            assert.throws(() => watch.finish(), refusal);
          }
        } finally { watch.close(); await context.close(); }
      }
    } finally {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, https].filter(server => server?.listening).map(server => new Promise(done => server.close(done))));
      rmSync(root, { recursive: true, force: true });
    }
  });
