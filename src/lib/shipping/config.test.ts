import assert from "node:assert/strict";
import test from "node:test";

import {
  CHITCHATS_REGIONS,
  getChitChatsOperationalIdentity,
  parseChitChatsRegion,
} from "./config";

test("accepts only the canonical Chit Chats regions", () => {
  for (const region of CHITCHATS_REGIONS) {
    assert.equal(parseChitChatsRegion(region), region);
  }
  assert.equal(
    parseChitChatsRegion("  ontario_manitoba  "),
    "ontario_manitoba",
  );
  assert.throws(() => parseChitChatsRegion("ontario"), /must be one of/);
});

test("operational identity keeps region out of provider credentials", () => {
  const previous = {
    clientId: process.env.CHITCHATS_CLIENT_ID,
    environment: process.env.CHITCHATS_ENVIRONMENT,
    region: process.env.CHITCHATS_REGION,
    vercelEnvironment: process.env.VERCEL_ENV,
  };
  try {
    process.env.CHITCHATS_CLIENT_ID = "123456";
    process.env.CHITCHATS_ENVIRONMENT = "staging";
    process.env.CHITCHATS_REGION = "ontario_manitoba";
    process.env.VERCEL_ENV = "preview";
    assert.deepEqual(getChitChatsOperationalIdentity(), {
      clientId: "123456",
      environment: "staging",
      region: "ontario_manitoba",
    });
  } finally {
    restore("CHITCHATS_CLIENT_ID", previous.clientId);
    restore("CHITCHATS_ENVIRONMENT", previous.environment);
    restore("CHITCHATS_REGION", previous.region);
    restore("VERCEL_ENV", previous.vercelEnvironment);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
