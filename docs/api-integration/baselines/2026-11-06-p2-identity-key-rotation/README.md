# P2 identity-key rotation source validation

This baseline covers the live-ineligible source package for rotating the four
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
- second-aligned capture scheduling after fractional signer cutoffs, preserving
  the full 330-second drain before the JWT issuer floors `iat` to seconds;
- source retention and reuse of the exact same unexpired old/new token bytes
  before and after previous-key removal;
- ordered phase windows that reject evidence outside its phase and require the
  token capture after the full 330-second overlap drain;
- a fixed controller with immutable mutation intents, split runtime/frontend
  state verification, GET-first reconciliation, one API recreation and one
  frontend build/promotion per phase, and restoration only to the last fully
  qualified phase;
- controller joins from each captured profile timestamp to the exact retained
  observation and actual capture/observation window, plus a final current-state
  boundary on both new completion and retained-result reads;
- a typed host adapter that compares all non-profile base environment values,
  keeps private credential-bearing byte hashes out of common evidence, admits
  only the existing fresh release-probe overlay, and passes child credentials
  over private stdin rather than process arguments;
- repeated reviewed private-configuration byte validation before and after
  copies, mutations, and observations. Actual runtime snapshots are joined to
  the reviewed runtime-only subset while `frontend.env` remains covered by the
  separately rechecked full private bundle;
- Vercel `decrypt=false` opaque secret values are discarded as non-authority;
  supported sensitive/encrypted response shapes do not imply secret readback;
- refusal of incomplete profiles, short drain, grace acceptance, configured
  previous keys, mutable parent claims, arbitrary commands, and malformed
  packets;
- nonsecret public receipts and `keyRemovalVerified: false` while the required
  config-only certification parent is absent.

The exact final test counts and source hashes are recorded in `validation.json`.
The Course observer test uses an owned loopback TLS server. No external network,
staging, provider, or live database request was made.

Live rotation remains open. The root-owned dispatch must compose the fixed
controller and host adapter with the actual host and frontend physical locks.
The current native certification parent does not authorize configuration
rollout. Until the dedicated source parent is integrated and independently
qualified, this package cannot set
`keyRemovalVerified: true` in a host receipt.
