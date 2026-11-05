// Exact intercepted effects for this fixture; never forwards provider traffic.
const calls = {
  service: [["GET", "/v2/payments/owned-service-payment"]],
  email: [["POST", "/emails"]],
  split: [
    ["GET", "/v2/payments/owned-split-card"],
    ["GET", "/v2/payments/owned-split-afterpay"],
    ["POST", "/v2/payments/owned-split-card/cancel"],
    ["POST", "/v2/payments/owned-split-afterpay/cancel"],
  ],
  capture: [
    ["GET", "/v2/payments/owned-capture-payment"],
    ["POST", "/v2/payments/owned-capture-payment/complete"],
  ],
  stock: [["GET", "/v2/payments"]],
  "refund-worker": [["POST", "/v2/refunds"]],
};

export function reconciliationProviderStage(request) {
  const url = new URL(request.url);
  if (url.origin === "https://connect.squareupsandbox.com" && request.method === "GET" && url.pathname === "/v2/payments") {
    const expected = new URLSearchParams({ location_id: "owned-location", begin_time: "2020-01-01T11:45:00.000Z",
      end_time: "2020-01-02T12:00:00.000Z", sort_order: "ASC", limit: "100" });
    if (url.searchParams.has("cursor")) expected.set("cursor", "owned-next");
    const normalized = params => JSON.stringify([...params].sort());
    if (normalized(url.searchParams) === normalized(expected)) return "stock";
    throw new Error("OWNED_UNEXPECTED_FETCH");
  }
  for (const [stage, expected] of Object.entries(calls)) {
    const origin = stage === "email" ? "https://api.resend.com" : "https://connect.squareupsandbox.com";
    if (url.origin === origin && !url.search && expected.some(([method, path]) => request.method === method && url.pathname === path)) return stage;
  }
  throw new Error("OWNED_UNEXPECTED_FETCH");
}

export function assertReconciliationProviderCalls(assert, actual, stages, failedStage) {
  const expected = stages.flatMap(stage => calls[stage]
    // Failed split lookups must not initiate either cancellation.
    .filter(([method]) => !(stage === "split" && failedStage === "split" && method === "POST"))
    .map(([method, path]) => ({ stage, method, path })));
  const key = call => `${call.stage} ${call.method} ${call.path}`;
  // Split legs run concurrently; their arrival order is not a contract.
  assert.deepEqual(actual.map(key).sort(), expected.map(key).sort(), "provider effects must match exactly once");
  const orderedStages = actual.map(call => call.stage).filter((stage, index) => index === 0 || stage !== actual[index - 1].stage);
  assert.deepEqual(orderedStages, stages, "batch order must survive failures and closure");
}
