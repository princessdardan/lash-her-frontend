# Staging gateway certification transport

The fixed staging-only module is authored at `ecc9b8ab3809a679f33a80c0f896806a30689393` and integrated at `7beaf80a`. Root's transport wiring is `030d1cf7`, integrated at `508158a1`. The module source SHA256 is `bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52`. PR91's `ops/gateway/runtime/` sources remain unchanged.

Selection occurs after the actual gateway host/route, workload/application authentication, admission and bounded raw-body checks. A fixed one-record lease can return 503 before upstream I/O or drop a complete typed 200 ACK before any downstream status, headers or body. The existing response-close accounting retains the dropped mutation as uncertain. Ordinary exact replay passes through; neither the module nor the wiring clears counters, restarts containers or authorizes a release.

The Mux profile checks the selected managed track/asset/attempt/environment metadata and actual managed Course 200 response. Its observation still requires the host's actual managed-row/source/generation join. A verified ingress observation alone does not establish final publication, ordering, duplicate recovery or live case completion.

## Verification

The isolated `phase2-gateway-fault-wiring` checkout at `030d1cf7` passed all 38 gateway tests with Node 24.18.0, zero skips. Four new actual loopback HTTPS cases cover:

- Invalid authentication and closed admission cannot spend the one-shot fault;503 occurs before any upstream request.
- A complete typed ACK is dropped before response bytes, actual recovery uncertainty becomes 1, and exact replay returns the normal duplicate response without clearing that uncertainty.
- Untyped 200 and unsuccessful replies pass through without ACK-loss proof.
- Mux raw bytes/signature reach the owned TLS upstream unchanged; only the matching managed 200 is dropped once, without logging the signature or raw body.

Focused ESLint and `git diff --check` pass. The source constructor test seam projects owned filesystem/process readers; production has no new CLI, environment, configuration or public HTTP activation switch. Real gateway authentication, admission, TLS and upstream handling remain active in these tests.

Independent review separately cleared the 10-test module and three-file wiring; the wiring reviewer independently repeated all 38 tests after an initial sandbox loopback refusal. Docker COPY closure was inspected statically. No local Docker image build, actual provider request, staging operation or business database call is claimed.

The original wiring review is retained privately under `/Users/dardan/.local/share/lash-her/phase2-goal-evidence/2026-11-06/independent-certification-reviews/`, SHA256 `cd354ab95ee287ee35fe9362b2c6bd192306dec3bdde8e670564f80a1c3290be`. Its temporary original remains unchanged.

## Open gates

The source-owned host lease issuer, actual frontend physical-session/host-lock certification parent, complete configuration/source/runtime joins, explicit known-operation reconciliation and deliberate runtime recovery still require their own independent qualification. Unexplained uncertainty must stay closed; generic runtime replacement must not erase it as evidence. Required final-source CI/image checks and Dardan-started deployed certification remain open. No live capability was enabled by this source integration.
