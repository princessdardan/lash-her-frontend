import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const mediaFixtureStorage = {
  endpoint: "http://127.0.0.1:4110",
  bucket: "community-media-fixture",
  accessKey: "community-media-test",
  secretKey: "synthetic-private-media-object-storage-key",
};

const mediaFixtureSessions = process.env.COMMUNITY_MEDIA_FIXTURE_SESSIONS
  ? JSON.parse(process.env.COMMUNITY_MEDIA_FIXTURE_SESSIONS)
  : undefined;

const origin = "http://127.0.0.1:3120";
const objects = new Map();
const sessionUses = new Map();
let failDeleteKey;
let holdWriteKey;
const { accessKey, secretKey, bucket, endpoint } = mediaFixtureStorage;
const sha256 = (value, encoding = "hex") =>
  createHash("sha256").update(value).digest(encoding);
const digest = (secret, value) =>
  createHmac("sha256", secret).update(value).digest();
const escape = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
let offset = 0;
let failedReadsRemaining = 0;

function verify(request, url, raw) {
  const header = request.headers.authorization;
  const bearer =
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)$/u.exec(
      header ?? "",
    );
  const direct = !!bearer;
  if (header && !direct) return false;
  const credential =
    bearer?.[1] ?? url.searchParams.get("X-Amz-Credential") ?? "";
  const signedHeaders =
    bearer?.[2] ?? url.searchParams.get("X-Amz-SignedHeaders") ?? "";
  const signature =
    bearer?.[3] ?? url.searchParams.get("X-Amz-Signature") ?? "";
  const date = direct
    ? request.headers["x-amz-date"]
    : url.searchParams.get("X-Amz-Date");
  if (
    !date ||
    !/^\d{8}T\d{6}Z$/u.test(date) ||
    !/^[a-f0-9]{64}$/u.test(signature)
  )
    return false;
  const expires = direct ? 60 : Number(url.searchParams.get("X-Amz-Expires"));
  const timestamp = Date.parse(
    date.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u,
      "$1-$2-$3T$4:$5:$6Z",
    ),
  );
  if (
    !Number.isFinite(timestamp) ||
    !Number.isSafeInteger(expires) ||
    expires < 1 ||
    Date.now() + offset > timestamp + expires * 1000 ||
    timestamp > Date.now() + 10_000
  )
    return false;
  const scope = date.slice(0, 8) + "/us-east-1/s3/aws4_request";
  let signingKey = secretKey;
  let sessionKey;
  if (mediaFixtureSessions) {
    const allows = {
      api: raw ? ["PUT", "HEAD", "GET"] : ["HEAD", "GET"],
      worker: raw ? ["HEAD", "GET", "DELETE"] : ["PUT", "DELETE"],
    };
    const role = Object.keys(allows).find((name) =>
      mediaFixtureSessions[name].some(
        (session) => credential === session.accessKey + "/" + scope,
      ),
    );
    const session =
      role &&
      mediaFixtureSessions[role].find(
        (item) => credential === item.accessKey + "/" + scope,
      );
    const token = direct
      ? request.headers["x-amz-security-token"]
      : url.searchParams.get("X-Amz-Security-Token");
    if (
      !role ||
      !allows[role].includes(request.method) ||
      token !== session.sessionToken
    )
      return false;
    signingKey = session.secretKey;
    sessionKey = session.accessKey;
  } else if (credential !== accessKey + "/" + scope) {
    return false;
  }
  if (!direct && url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256")
    return false;
  const names = signedHeaders.split(";");
  if (
    !names.includes("host") ||
    names.some((name) => typeof request.headers[name] !== "string")
  )
    return false;
  if (
    !direct &&
    request.method === "PUT" &&
    [
      "content-length",
      "content-type",
      "if-none-match",
      "x-amz-checksum-sha256",
    ].some((name) => !names.includes(name))
  )
    return false;
  const query = [...url.searchParams]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [escape(name), escape(value)])
    .sort(([oneKey, oneValue], [twoKey, twoValue]) =>
      oneKey === twoKey
        ? oneValue < twoValue
          ? -1
          : oneValue > twoValue
            ? 1
            : 0
        : oneKey < twoKey
          ? -1
          : 1,
    )
    .map(([name, value]) => name + "=" + value)
    .join("&");
  const headers = names
    .map(
      (name) =>
        name + ":" + request.headers[name].trim().replace(/\s+/gu, " ") + "\n",
    )
    .join("");
  const payload =
    request.headers["x-amz-content-sha256"] ??
    url.searchParams.get("X-Amz-Content-Sha256") ??
    "UNSIGNED-PAYLOAD";
  const hash = sha256(
    [request.method, url.pathname, query, headers, signedHeaders, payload].join(
      "\n",
    ),
  );
  const key = ["us-east-1", "s3", "aws4_request"].reduce(
    digest,
    digest("AWS4" + signingKey, date.slice(0, 8)),
  );
  const expected = digest(
    key,
    ["AWS4-HMAC-SHA256", date, scope, hash].join("\n"),
  );
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return false;
  if (sessionKey)
    sessionUses.set(sessionKey, (sessionUses.get(sessionKey) ?? 0) + 1);
  return direct ? "service" : "signed";
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, endpoint);
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "PUT, GET, OPTIONS",
    "access-control-allow-headers":
      "content-type,if-none-match,x-amz-checksum-sha256",
  };
  const send = (status, body, headers = {}) =>
    response.writeHead(status, { ...cors, ...headers }).end(body);
  try {
    if (url.pathname === "/fixture/session-uses" && request.method === "GET") {
      return send(200, JSON.stringify(Object.fromEntries(sessionUses)), {
        "content-type": "application/json",
      });
    }
    if (url.pathname === "/fixture/objects" && request.method === "GET") {
      return send(
        200,
        JSON.stringify(
          [...objects].map(([key, obj]) => ({ key, bytes: obj.bytes.length })),
        ),
        {
          "content-type": "application/json",
        },
      );
    }
    if (url.pathname === "/fixture/time" && request.method === "PUT") {
      offset = url.searchParams.get("advance") === "yes" ? 31_000 : 0;
      return send(204);
    }
    if (url.pathname === "/fixture/fail-read" && request.method === "PUT") {
      const count = Number(url.searchParams.get("count") ?? 1);
      assert.ok(Number.isInteger(count) && count >= 1 && count <= 4);
      failedReadsRemaining = count;
      return send(204);
    }
    if (url.pathname === "/fixture/hold-write" && request.method === "PUT") {
      holdWriteKey = url.searchParams.get("key");
      return send(204);
    }
    if (url.pathname === "/fixture/fail-delete" && request.method === "PUT") {
      failDeleteKey = url.searchParams.get("key");
      return send(204);
    }

    const match = new RegExp(
      `^/${bucket}/(quarantine/[a-f0-9-]{36}|processed/[a-f0-9-]{36}\\.webp)$`,
      "u",
    ).exec(url.pathname);
    if (!match) return send(404);
    if (request.method === "OPTIONS") return send(204);
    const [, key] = match;
    const raw = key.startsWith("quarantine/");
    const authorization = verify(request, url, raw);
    if (!authorization) return send(403);

    if (request.method === "PUT") {
      if (raw !== (authorization === "signed")) return send(403);
      if (raw && objects.has(key)) return send(412);
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 10 * 1024 * 1024) return send(413);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (
        length !== Number(request.headers["content-length"]) ||
        sha256(bytes, "base64") !== request.headers["x-amz-checksum-sha256"]
      )
        return send(400);
      const etag = '"' + createHash("md5").update(bytes).digest("hex") + '"';
      objects.set(key, {
        bytes,
        etag,
        mime: request.headers["content-type"],
        checksum: request.headers["x-amz-checksum-sha256"],
        cacheControl: request.headers["cache-control"],
      });
      // Simulate a crash after S3 stored a derivative but before the worker
      // could observe the response and commit its ready state.
      if (!raw && key === holdWriteKey) {
        holdWriteKey = undefined;
        return;
      }
      return send(200, undefined, { etag });
    }
    if (request.method === "DELETE" && authorization === "service") {
      if (key === failDeleteKey) {
        failDeleteKey = undefined;
        return send(503);
      }
      objects.delete(key);
      return send(204);
    }
    if (
      !["HEAD", "GET"].includes(request.method) ||
      (raw && authorization !== "service")
    )
      return send(403);
    const object = objects.get(key);
    if (!object) return send(404);
    if (
      request.headers["if-match"] &&
      request.headers["if-match"] !== object.etag
    )
      return send(412);
    if (failedReadsRemaining > 0 && raw && request.method === "GET") {
      failedReadsRemaining--;
      return send(
        503,
        "<Error><Code>SlowDown</Code><Message>Fixture backoff</Message></Error>",
        {
          "content-type": "application/xml",
        },
      );
    }
    const headers = {
      "content-type": object.mime,
      "content-length": object.bytes.length,
      "x-amz-checksum-sha256": object.checksum,
      etag: object.etag,
      ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
    };
    return send(
      200,
      request.method === "HEAD" ? undefined : object.bytes,
      headers,
    );
  } catch (error) {
    console.error(
      "Synthetic S3 request failed:",
      error instanceof Error ? error.name : "Error",
    );
    return send(500);
  }
});

assert.equal(process.env.COMMUNITY_MEDIA_E2E, "1");
const bind = process.env.COMMUNITY_MEDIA_FIXTURE_BIND ?? "127.0.0.1";
assert.ok(bind === "127.0.0.1" || bind === "0.0.0.0");
server.listen(4110, bind, () =>
  console.log("Signed Community S3 fixture listening on port 4110"),
);
