import assert from "node:assert/strict";
import { createServer } from "node:http";

let outage = false;
const server = createServer(async (request, response) => {
  try {
    if (
      request.method === "PUT" &&
      ["/fixture/online", "/fixture/offline"].includes(request.url)
    ) {
      outage = request.url.endsWith("/offline");
      response.writeHead(204).end();
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/internal/community/entitlements/check");
    assert.match(
      request.headers.authorization ?? "",
      /^Bearer [A-Za-z0-9._-]+$/u,
    );
    if (outage) {
      // Let Community hit its own 1.5-second deadline.
      request.resume();
      const timer = setTimeout(() => response.writeHead(503).end(), 5_000);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await fetch("http://127.0.0.1:4107" + request.url, {
      method: "POST",
      headers: {
        authorization: request.headers.authorization,
        "content-type": "application/json",
        "x-request-id": request.headers["x-request-id"],
      },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(2_000),
    });
    response.writeHead(result.status, {
      "content-type": result.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(502).end();
  }
});
server.listen(4109, "127.0.0.1", () =>
  console.log("Community authority fixture on 127.0.0.1:4109"),
);
