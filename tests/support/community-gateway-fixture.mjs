import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateTlsProxy } from "../../ops/gateway/private-tls.mjs";
import { createGateway } from "../../ops/gateway/server.mjs";

assert.equal(process.env.COMMUNITY_E2E, "1");
assert.equal(process.env.VERCEL_OIDC_TOKEN?.split(".").at(-1), "fixture");
const fixture = process.env.COMMUNITY_E2E_FIXTURE_DIRECTORY;
assert.match(
  fixture ?? "",
  /^\/(?:private\/)?tmp\/lash-p506-browser\.[A-Za-z0-9]+$/u,
);
const keyFile = join(fixture, "tls-key.pem");
const certFile = join(fixture, "tls-cert.pem");
const admission = {
  file: join(fixture, "admission.json"),
  candidateSha256: "a".repeat(64),
  releaseId: "p5-06-browser-fixture",
};
writeFileSync(
  admission.file,
  JSON.stringify({
    version: 1,
    environment: "staging",
    candidateSha256: admission.candidateSha256,
    releaseId: admission.releaseId,
    actionId: "p5-06-browser-fixture",
    newWork: true,
    recovery: false,
  }),
  { mode: 0o600 },
);

const routes = JSON.parse(
  readFileSync(
    new URL("../../ops/gateway/routes.json", import.meta.url),
    "utf8",
  ),
);
const upstream = (service, port) =>
  createPrivateTlsProxy({
    keyFile,
    certFile,
    upstream: `http://127.0.0.1:${port}`,
    peers: [
      {
        address: "127.0.0.1",
        routes: routes.filter(
          (route) => (route.service ?? "course") === service,
        ),
      },
    ],
  });
const { server: gateway } = createGateway(
  {
    issuer: "https://oidc.vercel.com/p506-fixture",
    audience: "https://vercel.com/p506-fixture",
    subject: "owner:p506-fixture:project:p506-fixture:environment:production",
    ownerId: "team_fixture",
    projectId: "prj_fixture",
    environment: "production",
    appEnv: "staging",
    publicHost: "127.0.0.1:4113",
    courseOrigin: "https://127.0.0.1:4111",
    communityOrigin: "https://127.0.0.1:4112",
    tlsKeyFile: keyFile,
    tlsCertFile: certFile,
    upstreamCaFile: certFile,
    admission,
  },
  {
    verify: async (proof) => assert.equal(proof, process.env.VERCEL_OIDC_TOKEN),
  },
);

const listeners = [
  upstream("course", 4107),
  upstream("community", 4108),
  gateway,
];
await Promise.all(
  listeners.map(async (listener, index) => {
    listener.listen(4111 + index, "127.0.0.1");
    await once(listener, "listening");
  }),
);
console.log("P5-06 gateway and private TLS listeners ready on loopback");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () =>
    listeners.forEach((listener) => {
      listener.close();
      listener.closeAllConnections();
    }),
  );
}
