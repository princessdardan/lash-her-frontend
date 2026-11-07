# Recovery privilege and environment correction

The independent review of recovery commit716ea984 found inbound role membership and excess ACL/default privileges were accepted by the frontend/API current probes. The owned Python fixture also inherited the caller environment.

`before-postgres16.log` preserves an actual PostgreSQL16 reproduction against the original probes: all17 tested faults were accepted. Five frontend faults entered the restoration callback and passed continuous observation; six faults passed each API probe. The generated owned databases used all83/22/11 application migrations. Probe sequences are explicitly owned fixture instrumentation and included in the generated catalog baseline, so sequence faults cannot fail merely from schema drift.

The correction binds frontend memberships to the authenticated original operator and the exact existing frontend-role-preparation policy. A real non-superuser creator exercises PostgreSQL's two automatic ADMIN-only grants and the separate owner SET grant. Both initial and continuous checks reject rogue memberships, sequence UPDATE, excess table privileges, grant options and unexpected/global defaults before entering restoration; actual admission remains closed.

The API recovery observer requires the exact image's new read-only `verifyOperatorRoles` export with source policy context. Images lacking that export refuse. No duplicated weak SQL gate or executor fallback remains.

The fixture supplies a minimal allowlisted Node environment. An actual executable NODE_OPTIONS sentinel is first verified as a positive control, then the parent environment is poisoned and the actual child must leave that sentinel absent. No ambient database/provider value is accepted.

The corrected PostgreSQL16 run passed50 check groups with34 fixed named privilege faults:12 frontend faults refused at both initial and continuous observation,11 per API, and two additional missing-export refusals. Every mutation has a positive current-state baseline before and after repair; the failure must have the specific role-policy checkpoint (or missing-export checkpoint), rather than an unrelated schema/lineage mismatch. The five Node and13 host tests also passed. The final combined receipt is emitted only after both the database child and actual environment/sentinel checks succeed.

No live operations, provider mutations, SQL replay, historical LOGIN restoration or original receipt replacement were performed. PostgreSQL18 remains required in CI; local execution uses PostgreSQL16. Forward-build recovery remains open pending its separate implementation.
