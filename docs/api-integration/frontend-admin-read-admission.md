# Administrative read operations with persistent effects

This candidate extends the authorization operation from `a9d03ef` at integration baseline `3fd9fc92cdb448e2b8f8f06db230e155b2b43147`. Admission remains disabled by default. It does not authorize SQL, activate a provider or establish complete deployed-producer fencing.

| Entry | Complete semantic boundary | Class |
| --- | --- | --- |
| Appointment detail page and direct `appointment-read.getAdminAppointmentDetail` | Authorization, parallel settings/appointment lookup, view audit, subsequent activity lookup and presentation | Recovery |
| Exported legacy `operations-read.getAdminAppointmentDetail` | Authorization, appointment lookup and view audit; currently no production page caller | Recovery |
| Marketing contact workspace/direct `listAdminMarketingContacts` | Authorization, settings/range lookup, counts/source queries, selected contacts and view audit | Recovery |
| Calendar connections page | Authorization, workspace queries, every started connection discovery and complete paginated results | Recovery |
| Contractor Calendar page | Authorization/role check, workspace queries, resource/ownership checks and every started connection discovery | Recovery |
| Direct owner/contractor discovery and `listConnectionGoogleCalendars` | Authorization/ownership when applicable, credential lookup/decryption, Google OAuth refresh and all CalendarList pages | Recovery |

These operations use recovery because they refresh existing identities/credentials or record existing-record access. First identity binding and owner bootstrap retain their independent new-work gates. Discovery does not grant a new credential or initiate an OAuth installation.

`runAdminReadOperation` reuses only a matching semantic parent. An appointment, marketing, generic writer or authorization context cannot stand in for a different operation. The Calendar page owns its child discoveries as one operation; directly invoked helpers still acquire admission before effects. Existing repository/audit writer gates remain intact.

Typed authorization denials settle before framework redirects. An unknown SQL/provider/audit outcome remains uncertain. The Calendar error presenter preserves its ordinary error state with admission disabled, marks unknown failures when admitted, and propagates authorization/admission denials. Calendar pages and affected concurrent query groups wait for every started sibling, including when another sibling rejects. JSX rendering and redirects occur after operation settlement.

## Verification

Node24 controlled tests execute the actual exported read helpers, SQL-building paths and Google SDK. Only actor identity, business query results and provider transport are intercepted; the admission runner uses the existing in-memory protocol peer. The provider interceptor refuses every unrecognized outbound request. No configured credential, database or live provider is used.

The exported-helper test contains 21 assertions/scenarios: closed-policy denial before effects for six direct entries; known denials; complete appointment/marketing read-and-audit chains; held post-audit lookup; failed-query sibling settlement; owner and contractor discovery through real SDK OAuth refresh and two CalendarList pages; and an actual SDK refresh failure retained as uncertain. Separate operation tests cover semantic reuse, recovery classification, generic-parent isolation, uncertain audit denial, sibling waiting and redirects after settlement.

Run focused verification from the repository root:

```sh
node --import ./scripts/register-server-only-test.mjs --import tsx --test \
  src/lib/admin/read-operation.test.ts \
  src/lib/admin/read-helpers-admission.test.ts \
  src/lib/admin/calendar-discovery-result.test.ts
```

The source test runner must classify `read-operation.test.ts` and the existing `calendar-discovery-result.test.ts` as server-only. `read-helpers-admission.test.ts` creates its own isolated child with the server-only test loader.

These checks do not establish actual PostgreSQL/TLS ledger qualification, browser/RSC dispatch, deployed provider behavior or historical/manual producer fencing. Those remain integration/release evidence requirements. The source inventory and manual-script changes are separately owned by the coordinator.
