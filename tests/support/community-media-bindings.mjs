import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const sessions = Object.fromEntries(
  ["api", "worker"].map((role) => [
    role,
    [1, 2].map((generation) => ({
      accessKey: `fixture-community-media-${role}-${generation}`,
      secretKey: `synthetic-media-${role}-session-key-${generation}`,
      sessionToken: `synthetic-media-${role}-session-token-${generation}`,
    })),
  ]),
);

export function createMediaBindingFixture({
  name,
  image,
  previousImage,
  storeContainer,
  databaseUrl,
  workerDatabaseUrl,
  bucket,
  memberKey,
  signedOrigin,
}) {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "lash-media-bindings-"),
  );
  const release = join(directory, "release");
  const bindings = join(directory, "bindings");
  const sessionRoot = join(directory, "sessions");
  const platform = resolve("ops/platform/compose.yaml");
  const overlay = resolve("ops/platform/compose.community-media.yaml");
  const fixture = join(directory, "fixture.json");
  const rollback = join(directory, "rollback.json");
  const networkOverride = join(directory, "network.yaml");
  const env = {
    ...process.env,
    APP_ENV: "staging",
    COMPOSE_PROFILES: "",
    RELEASE_DIR: release,
    COMMUNITY_MEDIA_BINDINGS_DIR: bindings,
    COMMUNITY_MEDIA_SESSIONS_DIR: sessionRoot,
    COMMUNITY_MEDIA_BUCKET: bucket,
    COMMUNITY_MEDIA_REGION: "us-east-1",
    COMMUNITY_MEDIA_DATABASE_NETWORK: name,
    COMMUNITY_RUNTIME_IMAGE: image,
    COMMUNITY_MIGRATION_IMAGE: image,
    COURSE_RUNTIME_IMAGE: image,
    COURSE_MIGRATION_IMAGE: image,
    GATEWAY_IMAGE: image,
  };

  function compose(files, ...args) {
    return execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "--project-name",
        name,
        ...files.flatMap((file) => ["-f", file]),
        ...args,
      ],
      {
        env,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  }

  function write(name, value) {
    writeFileSync(join(directory, name), value, { mode: 0o600 });
  }

  const database = `DATABASE_TARGET=test\nTEST_DATABASE_URL=${databaseUrl}\n`;
  const runtime = {
    NODE_ENV: "test",
    DOTENV_CONFIG_PATH: "/dev/null",
  };
  const removeFiles = () => rmSync(directory, { recursive: true, force: true });
  function publish(role, generation, minutes) {
    const identity = sessions[role][generation - 1];
    const target = join(sessionRoot, role, "session.json");
    const candidate = target + ".new";
    writeFileSync(
      candidate,
      JSON.stringify({
        Version: 1,
        AccessKeyId: identity.accessKey,
        SecretAccessKey: identity.secretKey,
        SessionToken: identity.sessionToken,
        Expiration: new Date(Date.now() + minutes * 60_000).toISOString(),
      }),
      { mode: 0o444, flag: "wx" },
    );
    renameSync(candidate, target);
  }

  try {
    mkdirSync(release, { mode: 0o700 });
    mkdirSync(bindings, { mode: 0o700 });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=postgres",
        "-addext",
        "subjectAltName=DNS:postgres",
        "-keyout",
        join(bindings, "synthetic-postgres.key"),
        "-out",
        join(bindings, "db-ca.pem"),
      ],
      { stdio: "pipe" },
    );
    write(
      "bindings/pg_hba.conf",
      `local all all trust
hostssl all lash_her_community_media_worker all scram-sha-256
host all lash_her_community_media_worker all reject
host all postgres all scram-sha-256
`,
    );
    // Compose validates every base service's env_file before selecting the
    // media fixture services. These files are placeholders for unstarted peers.
    for (const service of [
      "course-api",
      "course-publisher",
      "course-snapshot",
      "course-media",
      "course-export-cleanup",
      "community-worker",
    ]) {
      write(
        `release/${service}.env`,
        "# Synthetic Compose model only; this peer is not started.\n",
      );
    }
    write("release/community-api.env", database);
    write(
      "bindings/worker-db.env",
      `DATABASE_TARGET=test\nTEST_DATABASE_URL=${workerDatabaseUrl}\n`,
    );
    mkdirSync(sessionRoot, { mode: 0o700 });
    for (const role of Object.keys(sessions)) {
      mkdirSync(join(sessionRoot, role), { mode: 0o755 });
      // Put only the first synthetic session inside the SDK refresh window.
      publish(role, 1, 4);
    }
    const render = (...files) =>
      JSON.parse(
        compose(
          files,
          "--profile",
          "community-media",
          "config",
          "--format",
          "json",
        ),
      );
    const base = render(platform);
    const combined = render(platform, overlay);
    assert.equal(base.services["community-media-worker"], undefined);
    assert.deepEqual(
      combined.services["community-worker"],
      base.services["community-worker"],
    );
    const api = combined.services["community-api"];
    const media = combined.services["community-media-worker"];
    for (const service of [api, media]) {
      assert.equal(service.environment.COMMUNITY_MEDIA_BUCKET, bucket);
      assert.equal(service.environment.COMMUNITY_MEDIA_REGION, "us-east-1");
      assert.equal(
        service.environment.COMMUNITY_MEDIA_SESSION_FILE,
        "/run/media-session/session.json",
      );
    }
    assert.deepEqual(media.command, ["node", "dist/media/run-worker.js"]);
    assert.equal(media.image, api.image);
    assert.deepEqual(media.profiles, ["community-media"]);
    assert.equal(media.environment.HTTP_BIND_ADDRESS, "127.0.0.1");
    assert.equal(media.ports, undefined);
    assert.deepEqual(Object.keys(media.networks).sort(), [
      "community_media_database",
      "community_media_egress",
    ]);
    assert.equal(combined.networks.community_media_database.name, name);
    assert.equal(combined.networks.community_media_database.external, true);
    assert.equal(
      media.environment.NODE_EXTRA_CA_CERTS,
      "/run/media-db-ca/ca.pem",
    );
    assert.ok(
      media.volumes.some(
        (mount) =>
          mount.read_only &&
          mount.source === join(bindings, "db-ca.pem") &&
          mount.target === "/run/media-db-ca/ca.pem",
      ),
    );
    assert.equal(api.environment.DATABASE_TARGET, "test");
    assert.equal(api.environment.TEST_DATABASE_URL, databaseUrl);
    assert.equal(media.environment.DATABASE_TARGET, "test");
    assert.equal(media.environment.TEST_DATABASE_URL, workerDatabaseUrl);
    assert.notEqual(
      api.environment.TEST_DATABASE_URL,
      media.environment.TEST_DATABASE_URL,
    );
    for (const [role, service] of [
      ["api", api],
      ["worker", media],
    ]) {
      assert.deepEqual(
        service.volumes
          .filter((mount) => mount.target === "/run/media-session")
          .map((mount) => [mount.source, mount.read_only]),
        [[join(sessionRoot, role), true]],
      );
    }

    // The fixture shares the storage emulator's namespace because the API
    // permits test storage endpoints only on loopback.
    write(
      "fixture.json",
      JSON.stringify({
        services: {
          "community-api": {
            image,
            command: api.command,
            env_file: [
              { path: join(release, "community-api.env"), format: "raw" },
            ],
            network_mode: `container:${storeContainer}`,
            environment: {
              ...runtime,
              PORT: "4108",
              COURSE_API_BASE_URL: "http://127.0.0.1:4109",
              COMMUNITY_READER_JWT_CURRENT_SECRET:
                "synthetic-isolated-community-workload-reader-key",
              COMMUNITY_MEMBER_JWT_CURRENT_SECRET: memberKey,
            },
            init: true,
            read_only: true,
            cap_drop: ["ALL"],
            security_opt: ["no-new-privileges:true"],
            pids_limit: 128,
            tmpfs: ["/tmp:size=32m"],
            mem_limit: "512m",
            cpus: 0.6,
          },
        },
      }),
    );
    write(
      "network.yaml",
      `services:
  community-api:
    environment:
      COMMUNITY_MEDIA_TEST_ENDPOINT: ${signedOrigin}
  community-media-worker:
    restart: "no"
    networks: !reset []
    network_mode: container:${storeContainer}
    environment:
      NODE_ENV: test
      DOTENV_CONFIG_PATH: /dev/null
      COMMUNITY_MEDIA_TEST_ENDPOINT: ${signedOrigin}
      WORKER_PORT: "4111"
      WORKER_POLL_INTERVAL_MS: "500"
`,
    );
    if (previousImage) {
      write(
        "rollback.json",
        JSON.stringify({
          services: { "community-api": { image: previousImage } },
        }),
      );
    }
  } catch (error) {
    removeFiles();
    throw error;
  }

  return {
    fixtureSessions: JSON.stringify(sessions),
    renew(role) {
      publish(role, 2, 30);
      return sessions[role][1].accessKey;
    },
    expireWorkerSession() {
      publish("worker", 1, -1);
    },
    postgresArgs(image) {
      return [
        ...["synthetic-postgres.key", "db-ca.pem", "pg_hba.conf"].flatMap(
          (file) => [
            "--mount",
            `type=bind,source=${join(bindings, file)},target=/tmp/input-${file},readonly`,
          ],
        ),
        "--entrypoint",
        "/bin/bash",
        image,
        "-ec",
        [
          "install -o postgres -g postgres -m 0600 /tmp/input-synthetic-postgres.key /tmp/fixture-server.key",
          "install -o postgres -g postgres -m 0644 /tmp/input-db-ca.pem /tmp/fixture-server.pem",
          "install -o postgres -g postgres -m 0600 /tmp/input-pg_hba.conf /tmp/fixture-pg_hba.conf",
          "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/fixture-server.pem -c ssl_key_file=/tmp/fixture-server.key -c hba_file=/tmp/fixture-pg_hba.conf",
        ].join("\n"),
      ];
    },
    start(container, service, mediaEnabled = true) {
      const files = [fixture];
      if (mediaEnabled) files.push(overlay, networkOverride);
      else if (previousImage) files.push(rollback);
      return compose(
        files,
        "--profile",
        "community-media",
        "run",
        "--no-deps",
        "--pull",
        "never",
        "-d",
        "--name",
        container,
        service,
      );
    },
    close() {
      try {
        compose(
          [fixture, overlay, networkOverride],
          "--profile",
          "community-media",
          "down",
          "--remove-orphans",
        );
      } finally {
        removeFiles();
      }
    },
  };
}
