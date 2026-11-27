import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { createPostgresRelayStream } from "./postgres-relay-stream";

async function relayFixture(t: TestContext, refusedStatuses: number[]) {
  const server = createServer();
  const relay = new WebSocketServer({ noServer: true });
  const received: Buffer[] = [];
  let upgrades = 0;

  server.on("upgrade", (request, socket, head) => {
    const status = refusedStatuses[upgrades++];
    if (status !== undefined) {
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    relay.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (bytes) => {
        assert.ok(Buffer.isBuffer(bytes));
        received.push(bytes);
        client.send(bytes);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const client of relay.clients) client.terminate();
    relay.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = { endpoint: `ws://127.0.0.1:${address.port}`, proof: "a".repeat(64), host: "fixture.invalid", port: 5432 };
  return { config, relay, received, upgrades: () => upgrades };
}

test("P5-06 retries a pre-upgrade 503 and sends PostgreSQL bytes once", { timeout: 3000 }, async (t) => {
  const fixture = await relayFixture(t, [503, 503]);
  let tokenReads = 0;
  const stream = createPostgresRelayStream(fixture.config, "P5-06", async () => { tokenReads++; return "fixture.token"; });
  t.after(() => { stream.destroy(); });
  const connected = once(stream, "connect");
  stream.connect(fixture.config.port, fixture.config.host);
  await connected;
  assert.equal(tokenReads, 1);
  assert.equal(fixture.upgrades(), 3);
  assert.deepEqual(fixture.received, []);

  const wireBytes = Buffer.from("0000000804d2162f", "hex");
  const echoed = once(stream, "data");
  stream.write(wireBytes);
  assert.deepEqual(await echoed, [wireBytes]);
  assert.deepEqual(fixture.received, [wireBytes]);

  const closed = once(stream, "close");
  for (const client of fixture.relay.clients) client.close();
  await closed;
  assert.equal(fixture.upgrades(), 3);
});

test("only P5-06 pre-upgrade 503 is retried, with a fixed attempt limit", { timeout: 3000 }, async (t) => {
  for (const [qualification, status, attempts] of [
    ["P5-06", 401, 1],
    ["P4-07", 503, 1],
    ["P5-06", 503, 4],
  ] as const) {
    const fixture = await relayFixture(t, Array<number>(attempts).fill(status));
    const stream = createPostgresRelayStream(fixture.config, qualification, async () => "fixture.token");
    t.after(() => { stream.destroy(); });
    const failed = once(stream, "error");
    stream.connect(fixture.config.port, fixture.config.host);
    const [error] = await failed;
    assert.equal(error.message, `${qualification} PostgreSQL relay unavailable`);
    assert.equal(fixture.upgrades(), attempts);
    assert.deepEqual(fixture.received, []);
  }
});
