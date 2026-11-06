# P2 identity-key rotation source validation

This baseline covers the plan-only source package for rotating the four
application-user JWT profiles. It contains no signing key, JWT, credential
value, credential hash, customer identifier, provider response, deployment
mutation, or live receipt.

Owned validation covers:

- a closed staging-only reviewed action with exact source, candidate, host,
  container, private configuration-record, and restoration bindings;
- distinct old/new keys for the four fixed profiles;
- protected Course learner/admin HTTPS response semantics, including the
  course-support-only 403 capability boundary;
- an owned loopback TLS server proving the fixed Course hostname/path,
  authorization header, request-ID requirement, and redirect/429/5xx refusal;
- actual deployed Community member/admin verifier semantics and moderator
  capability enforcement without adding a Community route or feature;
- exact overlap/current-only evidence classes, previous-key configuration
  state, unexpired old-token rejection, new-token acceptance, and module,
  source, image, container, and configuration joins;
- the 330-second maximum token lifetime plus verifier-skew drain;
- refusal of incomplete profiles, short drain, grace acceptance, configured
  previous keys, mutable parent claims, arbitrary commands, and malformed
  packets;
- nonsecret public receipts and `keyRemovalVerified: false` while the required
  config-only certification parent is absent.

Node reported 6 passing tests and Python reported 5 passing tests, with no
skips. ESLint, JavaScript syntax, and Python compilation checks passed. No
loopback or external network was required.

Live rotation remains open. The root-owned dispatch must compose a fixed
config-only action with the actual host and frontend physical locks, exact API
runtime recreation, one build/promotion per phase, provider reconciliation,
continuous guards, and qualified containment/restoration. The current native
certification parent does not authorize configuration rollout. Until that
integration exists, this package is plan-only and cannot set
`keyRemovalVerified: true` in a host receipt.
