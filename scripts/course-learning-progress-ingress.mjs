import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const profiles = ["chromium", "mobile"];
const lessonUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const bodyLimit = 1024;
const requestLimit = 64;
const errors = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"]);

async function exitMarker(browserDirectory, directories, profile) {
  const markers = await Promise.all(directories
    .filter(entry => entry.isDirectory() && entry.name.endsWith(`-${profile}`))
    .map(async entry => {
      try {
        const bytes = await readFile(join(browserDirectory, entry.name, "document-exit-outgoing.json"));
        const marker = bytes.length <= 256 && JSON.parse(bytes.toString("utf8"));
        if (Object.keys(marker ?? {}).length === 2 && Number.isSafeInteger(marker.bodyBytes)
          && marker.bodyBytes > 0 && marker.bodyBytes <= bodyLimit && typeof marker.bodySha256 === "string"
          && /^[0-9a-f]{64}$/u.test(marker.bodySha256)) return { bodyBytes: marker.bodyBytes, bodySha256: marker.bodySha256 };
      } catch (error) {
        if (error.code === "ENOENT") return null;
      }
      return false;
    }));
  const present = markers.filter(marker => marker !== null);
  if (!present.length) return { state: "absent" };
  if (present.length > 1) return { state: "ambiguous" };
  if (!present[0]) return { state: "invalid" };
  return { state: "captured", ...present[0] };
}

export function createOwnedProgressIngressObserver() {
  const routes = new Map(), started = performance.now();
  const records = Object.fromEntries(profiles.map(profile => [profile, { capped: false, requests: [] }]));
  let sequence = 0;
  return {
    selectLessons(lessons) {
      if (routes.size || profiles.some(profile => typeof lessons[profile] !== "string" || !lessonUuid.test(lessons[profile]))
        || lessons.chromium === lessons.mobile) throw new Error("Expected distinct owned resume lessons");
      for (const profile of profiles) routes.set(`/api/academy/lessons/${lessons[profile]}/progress`, profile);
    },
    observe(request, upstream, response) {
      const profile = request.method === "POST" && routes.get(request.url);
      if (!profile) return;
      const record = records[profile];
      if (record.requests.length >= requestLimit) {
        record.capped = true;
        return;
      }
      const row = { ordinal: record.requests.length + 1, receivedBytes: 0, bodySha256: null, events: [] };
      record.requests.push(row);
      const event = (type, fields = {}) => row.events.push({
        sequence: ++sequence, elapsedMicros: Math.round((performance.now() - started) * 1000),
        type, requestComplete: request.complete, ...fields,
      });
      event("accepted");
      let hash = createHash("sha256");
      const observeBytes = chunk => {
        row.receivedBytes = Math.min(bodyLimit + 1, row.receivedBytes + chunk.length);
        if (row.receivedBytes > bodyLimit) hash = null;
        else hash.update(chunk);
      };
      // Observe after the existing pipe is attached. Stop observing bytes if
      // the proxy unpipes early so the observer never keeps the stream flowing.
      request.on("data", observeBytes);
      upstream.once("unpipe", source => {
        if (source === request) request.off("data", observeBytes);
      });
      request.once("end", () => {
        if (request.complete && row.receivedBytes && hash) row.bodySha256 = hash.digest("hex");
        event("client-request-end");
      });
      request.once("close", () => event("client-request-close"));
      upstream.once("finish", () => event("upstream-finish"));
      upstream.prependOnceListener("response", reply => event("upstream-response", {
        status: Number.isInteger(reply.statusCode) && reply.statusCode >= 100 && reply.statusCode <= 599 ? reply.statusCode : null,
      }));
      upstream.prependOnceListener("error", error => event("upstream-error", {
        errorCode: errors.has(error.code) ? error.code : "other",
      }));
      upstream.once("close", () => event("upstream-close", { writableFinished: upstream.writableFinished }));
      response.prependOnceListener("close", () => event("client-response-close", { writableFinished: response.writableFinished }));
    },
    async report(resultDirectory) {
      const browserDirectory = join(resultDirectory, "browser");
      const directories = await readdir(browserDirectory, { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const observations = await Promise.all(profiles.map(async profile => {
        const record = records[profile], outgoing = await exitMarker(browserDirectory, directories, profile);
        const matchedIngressOrdinals = outgoing.state === "captured" ? record.requests.filter(row =>
          row.receivedBytes === outgoing.bodyBytes && row.bodySha256 === outgoing.bodySha256).map(row => row.ordinal) : [];
        return [profile, { ...record, documentExit: { ...outgoing, matchedIngressOrdinals } }];
      }));
      return { version: 1, maximumDigestBytes: bodyLimit, profiles: Object.fromEntries(observations) };
    },
  };
}
