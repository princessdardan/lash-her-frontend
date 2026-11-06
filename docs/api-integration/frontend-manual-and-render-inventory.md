# Frontend manual and render producer inventory

The current candidate uses source inventory version 2. It enumerates every Next page/layout (including metadata/static generators and client/server classification) and every non-test script module, in addition to routes, server actions, inline actions, deferred sites, database constructors and schedules. Scripts without direct SQL constructors remain review surfaces because imported helpers and provider calls can write. The release coverage validator requires an explicit admitted/read-only/closed disposition and retained evidence for every surface. Version 1 inventories remain historical evidence and cannot qualify a new release.

The November 5 audit found 28 protected admin entries. Actor resolution, identity persistence, subsequent resource lookup and permission-denial audit now use a complete authorization boundary. This alone does not qualify later audit writes, Calendar refresh/discovery, Course requests or entire descendant renders. Those have separate semantic operation boundaries. Remaining read-only render classifications must be bound to the final released source; a source-manifest hash is not a deployed writer fence.

## Retired bypasses and covered maintenance

- `shipping:provision-package-profiles` retains a read-only historical box plan and opens no database/provider connection. Direct writes refuse. Real approval uses `/admin/shipping-packages`, including owner permission, recent authentication and actual evidence. The retired script's manufactured approval timestamps are no longer executable.
- `db:create-payment-reconciliation-indexes` refuses before connecting. Both indexes are already managed by `drizzle/0017_big_hulk.sql`. Local isolated databases use `db:migrate`; staging/production use the reviewed migration coordinator and locks.
- `stock:backfill --execute` opens new-work admission before reading the Sanity inventory and keeps it through the completed reconciliation. Dry runs remain read-only. Failed/uncertain runs require inspection rather than automatic replay.
- The commerce fixture seed accepts only explicitly enabled matching loopback fixture identities named `lash_her_browser_ci` or `lash_her_commerce_e2e[_suffix]`. It refuses business staging/production, arbitrary local names and connection-query target/role overrides before database access. CI's existing browser fixture name is preserved.

Source tests exercise actual retired commands with SQL/provider tripwires, real stock script refusal before inventory, isolated-target bypass attempts, and mandatory render/manual release coverage. They establish source behavior only. Historical deployments, private provider bindings, outstanding effects and final deployed certification remain separate release conditions.


## Owner manual grants: revised P2Q source

The new server render `/admin/courses/[courseId]/manual-grants` and explicit `GET`, `HEAD`, and `POST` handlers at `/api/admin/courses/[courseId]/manual-grants` are writer-admitted surfaces. Both the render and the complete request handler use `runCourseAdminOperation` before actor/identity persistence, customer/course checks, service requests, and receipt reconciliation. A client subrequest alone does not qualify either enclosing operation.

The operation requires the existing owner-only `courses:support` permission. A POST binds a published paid course and expected revision, uses the existing audited orderless grant API, and retains only semantically matched receipts. GET explicitly reads the same retained command after an unknown response; it does not replay POST. Known render denials/read failures settle admission before Next control flow, while unknown writes and marked identity uncertainty stay uncertain.

Source inventory v2 discovers the route's three methods, the new server render, and the changed parent course render independently. Each requires its own source-bound coverage row and evidence in the actual release inventory. They share the deployment's genuine configured runtime producer; no producer SHA or live role/OID is invented here. The new handler's server-only unit test is registered in the root runner. [Source and admission evidence](baselines/2026-11-06-p2q-owner-manual-grant/review-fixes.json) includes actual page control flow and PostgreSQL16/18 ledger checks; real isolated-target producer binding, Community delivery and live S10 remain open.
