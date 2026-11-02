# Staging certificate maintenance

`ops/platform/host/certificates.py` maintains the existing public gateway certificate and the two private TLS peer certificates. The command is implemented and covered by owned tests; installation, timer execution and renewal on the actual deployment host still require live evidence. Its daily systemd timer is separate from deferred monitoring and sends no notification.

The gateway uses the existing Lego 4.9.1 Ubuntu security package and existing ACME account/state. Newer Lego v5 has a different CLI and state format. This implementation refuses an unreviewed package family rather than attempting a migration. It uses TLS-ALPN-01 on port443, with no DNS-provider credential or port80 requirement. Systemd supplies a randomized daily schedule; the bounded client call disables its own random sleep. [Lego CLI migration reference](https://go-acme.github.io/lego/migration/cli/).

## Maintained host inputs

Install the reviewed host tools in `/opt/lash-her/ops/platform/host`, owned by root. Keep release results under `/var/lib/lash-her/releases/staging`; the active containers must mount their three TLS directories from the same release snapshot. Preserve the existing ACME account in `/var/lib/lash-her/acme-staging`. Retain the staging private CA certificate and signing key as root-owned mode0600 files named `ca.pem` and `ca.key` under the root-owned mode0700 `/var/lib/lash-her/private-tls-staging` directory. This directory is never mounted into an application container. Keep its certificate identical to the active clients' `tls/ca.pem` and gateway `tls/gateway/ca.pem`.

Create root-owned mode0600 `/etc/lash-her/certificates-staging.json` with these fields, using the actual host identity and existing ACME account email:

```json
{
  "version": 1,
  "environment": "staging",
  "publicHost": "api-staging.lashher.com",
  "hostMachineId": "REPLACE_WITH_CURRENT_HOST_MACHINE_ID",
  "releaseRoot": "/var/lib/lash-her/releases/staging",
  "acmeState": "/var/lib/lash-her/acme-staging",
  "privateCaState": "/var/lib/lash-her/private-tls-staging",
  "accountEmail": "operator@example.invalid"
}
```

The placeholder configuration deliberately refuses execution. Host recreation must provision the new machine ID and restore the existing private account/CA state through the normal protected handoff. No secret belongs in this JSON, source control or an argument. Inspect the default plan before installing or enabling the timer:

```sh
python3 /opt/lash-her/ops/platform/host/certificates.py /etc/lash-her/certificates-staging.json
```

The plan reads only target configuration; it runs no command and reads no key. After the reviewed staging runtime is healthy, install `ops/platform/lash-her-certificates-staging.{service,timer}` under `/etc/systemd/system`, validate them with `systemd-analyze verify`, reload systemd, and enable the timer as part of the initial staging release action. Enabling a source file is not live qualification. Verify the first timer result on the actual host. Routine manual invocation uses the same action:

```sh
sudo python3 /opt/lash-her/ops/platform/host/certificates.py /etc/lash-her/certificates-staging.json --apply --confirm staging/certificate-renewal
```

## Renewal and failure behavior

The command requires the selected Linux AMD64 root host and its local Docker engine. It shares `/run/lock/lash-her-release.lock` with deployment, migrations and the watchdog; contention skips before reading keys. It discovers exactly the three selected TLS containers, checks their staging project/service identities, immutable gateway image references, read-only mounts and exact published-port policy. It refuses a different host, production, ambiguous inventory, symlink, unsafe key permissions or mixed release directories.

When all leaf certificates have more than thirty days remaining, it changes nothing. Otherwise it prepares ninety-day private leaf certificates using the existing staging CA. The CA must have enough remaining lifetime; root CA rotation is an explicit coordinated release, never a silent trust change. It stops only the affected TLS containers, performs any due public renewal, and verifies hostname, chain, key pair and replacement lifetime before installation. Public renewal temporarily occupies port443. Private-only renewal does not stop the gateway or contact ACME.

Replacement retains the existing key-file ownership and mode. After restarting each affected container, a real TLS handshake must verify the trust chain/hostname and the exact newly served leaf. The previous pairs and outcomes remain privately under `/var/lib/lash-her/certificate-renewals-staging/ATTEMPT`.

Failure restores previous live pairs where installation began, restarts affected containers and verifies their served TLS where possible. It retains `in-progress.json` and a failed outcome, including uncertain ACME issuance or incomplete recovery. A later timer refuses another mutation while that marker exists. Inspect the private outcome, actual running containers, served certificates and ACME state before deliberately reconciling it; do not delete the marker merely to retry. A killed process or host failure can leave selected TLS containers stopped and requires the same reconciliation. Old expired certificates cannot provide a successful recovery proof.

Check the timer and its journal during ordinary operator maintenance. Monitoring/alert delivery remains deferred. Preserve the private CA/account state and the latest working release off-host using existing protected storage. Before the CA becomes too old to issue another ninety-day leaf, prepare a new trust bundle and matching peer certificates, then verify and replace them together through the normal staging release. Never replace a CA certificate alone under running clients.

Owned coverage includes no-op/lock/target refusal, exact container/mount/port checks, private-only renewal, CA lifetime refusal, ambiguous stop and issuance, invalid replacement, partial key-pair replacement, failed restart, incorrect served leaf, rollback and retained review holds. Real OpenSSL/TLS tests check keys, hostnames, trust, served-leaf identity and preserved permissions. These tests do not contact a public CA or prove a live timer run.
