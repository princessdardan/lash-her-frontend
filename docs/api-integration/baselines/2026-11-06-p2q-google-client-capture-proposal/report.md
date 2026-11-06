# Google OAuth client creation capture contract

Date: 2026-11-06

Status: design only. No source implementation, browser transport, provider call,
credential access, resource creation, allocation, deployment, or live action was
performed. The Google Console DOM and download transport have not been
implemented or validated.

## Decision

The next bounded provider-provenance package should be one source-owned Google
OAuth web-client Console capture session. It is not a generic allocation
authority factory and does not extend `verifyP2qAllocationForInstall`.

Google documents creating a web OAuth client in Google Auth Platform > Clients
with exact JavaScript origins and redirect URIs, and separately documents
downloading the client JSON. No supported ordinary OAuth web-client creation API
was established by this review. A fixed interactive Console recorder is therefore
the smallest honest mechanism for capturing the actual client creation action,
settings, and downloaded credential artifact.

Primary sources:

- [Create access credentials](https://developers.google.com/workspace/guides/create-credentials)
- [Create and download OAuth client credentials](https://developers.google.com/workspace/chat/authenticate-authorize-chat-user)
- [Resource Manager projects.get](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/get)
- [Resource Manager projects.getIamPolicy](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/getIamPolicy)
- [Mux fundamentals](https://www.mux.com/docs/core/mux-fundamentals)
- [Mux environment access restrictions](https://www.mux.com/docs/guides/dashboard-environment-restrictions)
- [Mux API authentication and token scope](https://www.mux.com/docs/core/make-api-requests)

Cloud Resource Manager project and IAM reads are current control observations.
They are not OAuth-client creation, complete ancestor control history, or proof
that an account or credential was historically secret.

## Fixed contract

The package supports exactly one action class:
`google.oauth-web-client-capture-v1`. It accepts no generic provider, URL,
command, callback, facts map, or caller-selected evidence path.

Before a live action, root selects a nonsecret `GoogleOAuthClientCapturePlanV1`
with:

- exact `actionId`, `allocationPlanSha256`, source/operator/browser program
  hashes, and fixed expiry;
- literal client role `admin` or `customer`;
- actual Google project ID and project number;
- exact action-bound client display name;
- sorted exact JavaScript origins and redirect URIs; and
- the fixed private case-directory identity.

The plan deliberately has no qualification-target profile reference. Actual
client and project IDs are joined to a future registered profile by a separate
`ProfileAllocationJoin`; original capture records are never restamped.

The production parent may mint only an opaque in-process handle after checking
the source closure, pinned browser program, empty browser profile, and root-owned
case directory. Caller JSON, screenshots, downloaded files, booleans, fixture
objects, or matching hashes cannot construct that handle.

## Transport

1. The fixed parent creates a root-owned mode-0700 case directory and a fresh
   private browser user-data directory. It launches the pinned browser child
   without extensions, caller proxy settings, caller URLs, or a public debugging
   endpoint.
2. The child accepts only fixed state transitions: `INITIALIZED`,
   `AUTHENTICATED_PROJECT_OBSERVED`, `CLIENT_FORM_READY`, `CREATE_SUBMITTED`,
   `DOWNLOAD_CAPTURED`, `POST_READBACK_OBSERVED`, `COMMIT`, and `ABORT`.
3. The owner authenticates interactively. Password, MFA, recovery values,
   cookies, request bodies, screenshots, traces, and Console logs are not
   recorded. Source fills and validates the exact client name, origins, and
   redirects. The owner performs the reviewed Create and Download JSON actions.
4. The recorder verifies the selected Console project, observes the unique
   action-bound client absent before creation and present afterward, captures the
   browser download directly into the fixed private directory, validates the
   bounded documented `web` credential shape, and reopens the client detail page
   for exact settings readback. DOM or source drift refuses. Undocumented Console
   network endpoints are not treated as supported APIs.
5. One action captures one client. Administrator and customer clients use
   distinct action IDs and records.
6. Browser death, lost download, post-click timeout, or uncertain readback
   produces `UNKNOWN_AFTER_MUTATION`. Original private evidence is retained and
   Create is not repeated. A later fixed readback may reconcile an existing
   client but cannot fabricate missing original observations.
7. Ephemeral browser state is removed only after committed capture. Cleanup
   uncertainty remains private and leaves custody incomplete.

The browser parent, DOM selectors, private download handling, and all of these
state transitions are proposed interfaces only. They have not been implemented,
run, or validated against Google Console.

## Evidence boundaries

The private record contains the exact downloaded JSON bytes, source-controlled
browser/download observations, action-plan binding, and custody transitions. It
uses mode-0600 exclusive files, descriptor-relative no-follow bounded reads, and
file/directory fsync. Secret-bearing bytes and any digest derived from the raw
secret record never enter common output.

The common receipt permits only the action/plan/source hashes, role, project ID
and number, client ID, exact origin/redirect projection, observation times, and
a digest of that sanitized projection. It always states
`observationOnly:true` and `allocationAuthorityIssued:false`.

A successful action may cover only:

- `google.oauth-client.creation-action` for that one bounded session;
- `google.oauth-client.settings`; and
- `google.oauth-client.download-custody` from browser download onward.

It does not cover:

- Google account or project creation history;
- independent-principal or recovery-channel control;
- complete project, ancestor, integration, session, or token administration;
- universal non-copy or historical credential secrecy;
- the complete client inventory until both fixed client actions finish;
- runtime delivery or accepted-effect start;
- target-profile registration; or
- first-install or allocation authority.

Downloaded JSON is private evidence, not an importable authority object. A file,
its hash, or a caller claim that it was downloaded cannot activate the recorder
or construct an allocation handle.

## Inputs that remain blocked

No live owner action is safe until all of these exist:

1. Separate provider/resource mutation approval. Existing source-implementation
   approval is insufficient.
2. A genuinely independent Google principal and recovery path. Provider metadata
   cannot prove absolute historical secrecy; unresolved control remains explicit.
3. Actual Google project ID, number, parent, and supported current IAM read access.
4. A final separately controlled browser origin and exact administrator/customer
   callbacks.
5. A reviewed private case/storage destination and exact source/browser closure.
6. A root-selected action sheet for exactly one client role.

The independent principal, project, origin, storage, and mutation approval are
currently missing. The recorder can be implemented and reviewed in source, but
its safe live path cannot be finalized before those inputs exist.

## Future owner handoff

After the source package and exact action sheet are reviewed, Dardan starts the
fixed capture action under the existing single-operator policy, authenticates
only in the recorder-created browser, confirms the exact project, permits source
to populate the fixed fields, clicks Create once, clicks Download JSON once, and
waits for `COMMIT`. The operator must not copy the secret, use another browser,
or retry after an uncertain result. The second client is a separate reviewed
action.

Project and principal creation require their own retained control evidence. This
client capture cannot relabel either as proved.

## Why Mux is not the first slice

Mux documents environment-scoped access tokens and Dashboard-managed environment
access. Organization administrators can access all environments. A new
environment token therefore cannot establish organization-level control or
exclude old administrators. No supported public organization/environment
creation plus complete member/control inventory API was established. A future
Mux-specific Dashboard recorder must begin with an independently controlled
organization and principal; it must not reuse a generic Google recorder or infer
control from token success.

Current connected-provider inventories, including the connected Vercel view,
remain current caller-scoped metadata. They do not prove absolute historical
absence, account recovery control, or all prior credentials.
