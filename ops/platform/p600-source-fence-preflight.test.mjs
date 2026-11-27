import assert from "node:assert/strict";
import test from "node:test";
import { sourceConnection } from "./p600-source-fence-preflight.mjs";

test("the rescue session uses the same verified direct staging endpoint and protected role", () => {
  const uri = "postgresql://neondb_owner:example@ep-lingering-meadow-bc80gyj9.c-16.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
  const rescue = sourceConnection(uri, "postgres");
  assert.equal(rescue.ssl.servername, rescue.host);
  assert.equal(rescue.ssl.rejectUnauthorized, true);
  assert.equal(rescue.database, "postgres");
  assert.equal(rescue.enableChannelBinding, true);
  for (const candidate of [uri.replace("bc80gyj9.", "bc80gyj9-pooler."), uri.replace("/neondb?", "/another?"),
    uri.replace("neondb_owner:", "postgres:"), uri.replace("sslmode=require", "sslmode=disable"), uri+"&host=other",
    uri.replace("channel_binding=require", "sslmode=require")]) {
    assert.throws(() => sourceConnection(candidate, "postgres"), {message: "P600_SOURCE_CONNECTION_REFUSED"});
  }
  assert.throws(() => sourceConnection(uri, "other"), {message: "P600_SOURCE_CONNECTION_REFUSED"});
});
