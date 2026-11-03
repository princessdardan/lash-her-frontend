# Continue the stopped-host access recovery

The approved action `p1-recreate-access-20261103` stopped the original host normally and successfully requested its manual root snapshot. It then halted before any CloudFormation update or private configuration handoff. The validator wrongly required every snapshot operation to name the snapshot and wrongly expected its availability zone to match the source host. AWS returns paired source-instance/snapshot operations and a regional snapshot zone of `all`. The [official AWS response example](https://repost.aws/knowledge-center/lightsail-aws-cli-snapshots-backups) and actual read-only operation/snapshot observations confirm those shapes.

The original host remains stopped and attached to static IP 184.196.129.231. Snapshot `p1-recreate-access-20261103-original`, ARN `arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/a9d51e18-1494-4b6a-ab98-d8936f40c33d`, is now available. It belongs to the exact original instance in account 691588646557/us-east-1. Its private root-disk contents were not downloaded. No host deletion/replacement, SQL, frontend deployment, private input handoff, business schedules or write admission occurred.

## Narrow correction and scope

- Validate exactly the source-instance and snapshot operation pair, with correct resource types, operation type, unique resource names and successful/in-progress statuses. Unexpected/duplicate/failed operations still refuse before compute removal. Retain bounded technical operation fields before validating a future mutation response.
- Validate the snapshot's exact region, regional zone `all`, original source identity, name, manual status, bundle/blueprint, tags and creation time.
- Add one deliberate continuation, `p1-recreate-access-20261103-c1`, bound to the exact existing snapshot ARN and SHA-256 hashes of the original stop, snapshot-start and failure receipts. Revalidate the original stopped infrastructure and the available snapshot through read-only APIs. It cannot issue another stop or snapshot-create call.
- Then perform only the remaining scope of the [reviewed access recovery](operator-staging-access-recovery.md): inspect/execute detach-remove-create updates preserving the same allocation; independently verify the replacement key through authenticated Chrome AWS SSH; pin it before the 51 private input files cross from this Mac; bootstrap/cache the same six images; install maintenance disabled; check all three databases read-only; restore the same eight runtime services in maintenance.

The new private Mac receipt directory is `/Users/dardan/.local/share/lash-her/recreations/staging/p1-recreate-access-20261103-c1`. The browser proof uses `/Users/dardan/.local/share/lash-her/recreations/staging/incoming/browser-ssh-p1-recreate-access-20261103-c1.json`. Original failure receipts remain unchanged. Fixed allowlisted technical JSON receipts may return to the new private directory, mode 700 directories/mode 600 files, outside Git. The same credential/TLS/CA/ACME handoff categories and staging-only destination apply. No raw business rows, env/key export, database restore, migration application, synthetic fixture writes, frontend promotion, production change, business schedules or gateway write admission are added.

## Prepare and run

Use the exact clean committed correction with all ten current source CI jobs passing. Save this public-only settings file outside Git with mode 600:

```json
{
  "version": 2,
  "action": "p1-recreate-access-20261103-c1",
  "continuationOf": "p1-recreate-access-20261103",
  "sourceCommit": "REPLACE_WITH_REVIEWED_40_CHARACTER_SOURCE_COMMIT",
  "operatorIpv4Cidr": "99.239.187.88/32"
}
```

`node ops/platform/cold-recover-staging.mjs plan /absolute/private/settings.json` checks source/held inputs and the exact retained parent receipt bytes without `.env`, providers or mutations. Its plan explicitly excludes another stop or snapshot creation and names the existing snapshot. The snapshot ARN and parent hashes cannot be selected freely through settings.

After Dardan reviews the failure and starts this continuation explicitly under the [accepted release policy](release-policy.md), run `node ops/platform/cold-recover-staging.mjs apply /absolute/private/settings.json --confirm staging/p1-recreate-access-20261103-c1`. Recheck source/targets/producers at execution. No arbitrary approval expiry is imposed. A new failure stops for review without automatic retry.

The continuation does not complete the pending live P1 rollback/recreation/lease/native/external qualification. Gateway maintenance and disabled business schedules remain in force; retain the existing snapshot through qualification and deliberate cleanup.

## Validation

[Component checks](baselines/2026-11-03-stopped-snapshot-continuation-validation.json) pass all 166 Node tests, including 20 focused recovery checks; focused ESLint and diff checks pass. The [actual read-only preflight](baselines/2026-11-03-stopped-snapshot-continuation-readonly.json) validates the three retained parent receipt hashes, stopped original infrastructure and exact available snapshot with an API allowlist that cannot mutate resources. The CloudFormation template and Python host subtree are unchanged from the validated parent source. New exact-source CI and Dardan’s deliberate continuation start remain required.
