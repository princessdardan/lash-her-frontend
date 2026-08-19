import assert from "node:assert/strict";
import test from "node:test";

import { mapChitChatsReturnReason } from "./return-rules";

test("Chit Chats returns use exact reason codes without free-text refusal inference", () => {
  assert.equal(mapChitChatsReturnReason("unclaimed").type, "unclaimed");
  assert.equal(mapChitChatsReturnReason("damaged").type, "damage");
  for (const reason of ["incomplete_address", "unknown", "other"]) {
    assert.equal(mapChitChatsReturnReason(reason).type, "return_to_sender");
  }
  const freeText = mapChitChatsReturnReason("customer refused delivery");
  assert.equal(freeText.type, "return_to_sender");
  assert.equal(
    freeText.cause,
    "provider_return_unrecognized_pending_local_inspection",
  );
});
