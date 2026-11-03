# Staging operator-access recovery

This is a one-time recovery from the original host's SSH lockout. It does not complete the pending P1 live rollback, durable-work recovery, host recreation qualification or traffic admission. Dardan remains the sole operator. The [single-operator release policy](release-policy.md) applies: review the complete action once, start it explicitly, then review any failure before a deliberate retry.

## Cause and proposed access policy

Dardan confirmed the Mac is on `munimas-apt` without a VPN. Its public address changed from `99.239.200.211` to `99.239.187.88`. Both Lightsail and the original host's UFW permit only the original `/32`. Changing the AWS rule alone cannot restore access through UFW. AWS browser SSH is also disabled on that host, and the account has no registered SSM recovery node. The original host remains running; its current container health cannot be freshly inspected over SSH.

The replacement keeps direct SSH limited at the Lightsail edge to the reviewed current operator `/32`. It also retains the explicitly approved `lightsail-connect` source alias for authenticated AWS browser SSH. UFW denies SSH from RFC1918 networks, permits IPv4 SSH subject to that independent provider filter, and keeps IPv6 closed. Password authentication, keyboard-interactive authentication and root SSH login remain disabled. This avoids requiring an already-working SSH connection to update a changed home address. Browser access is retained after verification, not temporarily removed.

AWS documents the [OS-firewall recovery limitation](https://repost.aws/knowledge-center/lightsail-resolve-ssh-console-errors), the [independent Lightsail and host firewalls](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html), and the CloudFormation [`lightsail-connect` source alias](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lightsail-instance-port.html).

## Fixed targets and boundaries

- Account `691588646557`, region `us-east-1`, stack `lash-her-api-staging`.
- Original instance `arn:aws:lightsail:us-east-1:691588646557:Instance/2e608d2c-a88f-416f-a23f-209d20e042f4`; machine `ec265c34b9fbf4d051aecfa185362c0a`.
- Retain static IPv4 `184.196.129.231` and allocation `arn:aws:lightsail:us-east-1:691588646557:StaticIp/dfdce3fc-150b-47c0-87df-2bffeb81e963`.
- Replacement: Ubuntu 24.04 AMD64, `medium_3_0`, 4 GB RAM, 2 vCPU, 80 GB, existing regional key pair `Dardan`. No second concurrently running application host.
- Reuse candidate `p1-41541683416-1`, SHA-256 `b086558ed575cbdd0ceea8a3267e178e7ac390b77db9d2361cb721f750792900`, its six exact images and eight runtime containers.
- Keep frontend deployment `dpl_CdhFqwVANweysVe9cCTNpmHfduiy`, source `74ca26736e5834fce639407278b4575bf4d05670`, at `staging.lashher.com`. Native schedules stay disabled.
- No SQL migration application, database restore, synthetic fixture DML, frontend build/promotion, business-job activation, gateway write admission or production change.

## Prepare the reviewable action

1. Use the clean committed recovery checkout. Verify its canonical remote, exact source revision, current branch head and all ten required exact-source CI jobs. Publication is source-only and does not authorize the live action.
2. Save a mode-600 settings file outside Git containing only:

   ```json
   {
     "version": 1,
     "action": "p1-recreate-access-20261103",
     "sourceCommit": "REPLACE_WITH_THE_REVIEWED_40_CHARACTER_SOURCE_COMMIT",
     "operatorIpv4Cidr": "99.239.187.88/32"
   }
   ```

3. Run `node ops/platform/cold-recover-staging.mjs plan /absolute/private/settings.json`. Planning verifies the committed source and existing 51 protected input files. It does not read `.env`, connect to databases, call providers or change resources. Retain the displayed source, template, candidate and input-manifest hashes for approval.
4. Verify the seven existing injected bindings without displaying values: `PLATFORM_SOURCE_READ_TOKEN`, `VERCEL_TOKEN`, `GHCR_USERNAME`, `GHCR_READ_TOKEN`, `FRONTEND_STAGING_MIGRATION_DATABASE_URL`, `COURSE_STAGING_DATABASE_URL`, `COMMUNITY_STAGING_DATABASE_URL`. All three database bindings must match the recorded direct host/database/role and exactly `?sslmode=verify-full`. No new passwords are required.
5. Refresh the authenticated Mux Dev dashboard inventory. It must be complete, at most five minutes old, and contain only the existing enabled `http://localhost:4000/v1/webhooks/mux` callback, with no staging-gateway callback. Save its existing bounded, masked evidence format at `/Users/dardan/.local/share/lash-her/recreations/staging/incoming/mux-inventory.json`, mode 600. Do not fetch signing secrets.
6. Review and approve the complete action below, including compute/root-disk replacement, private snapshot, persistent browser SSH and private transfers. Earlier release approvals do not cover these new operations.

## Execute the one reviewed action

Run `node ops/platform/cold-recover-staging.mjs apply /absolute/private/settings.json --confirm staging/p1-recreate-access-20261103` from that exact clean checkout. The controller performs these steps without automatic mutation retries:

1. Recheck exact source/CI, held input hashes, the current public operator address, fixed AWS identities, the current frontend/alias and disabled native schedules, and fresh Mux inventory. Persist each intent before its mutation.
2. Request a normal AWS instance stop, without `force`, and observe the exact original instance stopped. This is provider-observed shutdown. It does not claim observed graceful exits for the eight individual containers.
3. Create one manual snapshot, `p1-recreate-access-20261103-original`, of that stopped instance. Verify its source ARN, region/AZ, blueprint/bundle, creation time, tags and available state before compute removal. This snapshot includes the entire private root disk, credentials and TLS material in the same AWS account/region; its contents are not downloaded. Retain it through recovery and successful P1 qualification. Snapshot cleanup is a later reviewed operation; this action cannot delete it.
4. Create, inspect and execute three CloudFormation updates in order: detach the static address, remove the original compute/root disk, create the reviewed replacement and reattach the same allocation. Refuse unexpected resources, replacement of the allocation, changed targets, incomplete pages or unreviewed property changes. Disable automatic rollback so an uncertain result requires inspection.
5. Pause for independent key verification through authenticated **Chrome AWS Lightsail browser SSH**. Verify the expected account and the new instance ARN/address in AWS. Run these public-information commands in that browser terminal:

   ```sh
   cat /etc/machine-id
   cat /etc/ssh/ssh_host_ed25519_key.pub
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
   ```

   Record the actual observations, never a private key, in `/Users/dardan/.local/share/lash-her/recreations/staging/incoming/browser-ssh-p1-recreate-access-20261103.json`, mode 600:

   ```json
   {
     "version": 1,
     "action": "p1-recreate-access-20261103",
     "method": "authenticated-aws-browser",
     "accountId": "691588646557",
     "browserAccountVerified": true,
     "instanceArn": "ACTUAL_NEW_INSTANCE_ARN",
     "address": "184.196.129.231",
     "hostMachineId": "ACTUAL_NEW_MACHINE_ID",
     "hostPublicKey": "ssh-ed25519 ACTUAL_BASE64_PUBLIC_KEY_WITHOUT_COMMENT",
     "fingerprint": "SHA256:ACTUAL_FINGERPRINT"
   }
   ```

   The controller verifies the key encoding/fingerprint and different machine identity, writes a separate exact `known_hosts` pin, and then verifies SSH against it. There is no first-use fallback or relaxation of host-key checking. No private application material crosses to the new host before this check.
6. Install the exact committed public operator source. Restore only the reviewed 51 private input files to the fresh host, bootstrap the locked Docker/forwarding configuration, fetch only the six pinned images using temporary GHCR authentication, and install the existing maintenance units **disabled**. Fresh bootstrap verifies Linux/root/machine identity before Docker installation.
7. Under the release lock, verify the fresh host, current provider state, configuration hashes and three database current-state checks read-only. Rebind only the machine/maintenance metadata, preserve the original configuration, and start receivers before workers using the existing pinned candidate. Verify eight new container IDs and five actual TLS/auth boundary probes. The shared Docker inspection handles containers with and without healthchecks.
8. Retain fixed JSON results and recheck the provider/infrastructure state. The only success status is `STAGING_OPERATOR_ACCESS_AND_RUNTIME_RECOVERED_AWAITING_P1_QUALIFICATION`. It explicitly leaves live rollback/recreation qualification and release acceptance false.

## Private transfers and failure handling

The complete action approval includes these destinations and contents:

- Existing protected inputs on this Mac to the replacement staging host only: the bounded 51-file manifest, including runtime/database credentials, signing material, TLS keys/certificates, internal CA and ACME recovery material. Existing GHCR, Vercel and database check bindings pass only through scoped child processes/private SSH stdin. No values appear in the public plan.
- Replacement host to `/Users/dardan/.local/share/lash-her/recreations/staging/p1-recreate-access-20261103` on this Mac: only fixed allowlisted preparation/runtime/configuration-binding/read-only database JSON receipts. `runtime-binding.json` contains only six allowlisted metadata fields. No raw business rows, keyed row fingerprints, database dumps, env files, TLS keys, credential values or arbitrary directories are exported by this action. Directories use mode 700; files use mode 600, outside Git.
- Original private root disk to one manual Lightsail snapshot in the same account/region, retained until qualification and deliberate cleanup. This is additional chargeable storage; no billing access or headroom gate is introduced.

Any uncertain stop, snapshot, CloudFormation, bootstrap or runtime result stops the action for review. Intent/outcome records and the original snapshot are retained. There is no automatic retry, snapshot restore, migration replay, frontend promotion, timer activation or traffic admission. A failure after removal can leave staging unavailable. Inspect actual AWS/host state before preparing a deliberately reviewed recovery. A lost SSH result may leave the remote phase running; retained receipts distinguish this uncertainty rather than claiming it stopped.

After access recovery, prepare the remaining live P1 qualification against the new machine and exact retained receipts. The old original-host recreation proposal is held; it cannot be reused unchanged for a different machine/access policy.
