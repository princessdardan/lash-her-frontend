import { execFileSync, spawn } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const host = "127.0.0.1";
const owned = new WeakMap();
const demand = condition => { if (!condition) throw new Error("OWNED_FRONTEND_REPLACEMENT_CLUSTER_REFUSED"); };
const commandEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", LANG: "C" };
const run = (program, args) => execFileSync(program, args, {
  env: commandEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
});

async function loopbackPort() {
  const listener = createServer();
  await new Promise((done, fail) => listener.once("error", fail).listen(0, host, done));
  const { port } = listener.address();
  await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()));
  return port;
}

function verifyLease(lease) {
  const { active, exited, child, proof, port } = lease;
  demand(active && !exited && Number.isInteger(child.pid) && child.pid > 0);
  const [pid, dataDirectory, , observedPort] = readFileSync(join(proof.dataDirectory, "postmaster.pid"), "utf8").split("\n");
  demand(pid === String(child.pid) && dataDirectory === proof.dataDirectory && observedPort === String(port) &&
    realpathSync(proof.dataDirectory) === proof.dataDirectory);
  process.kill(child.pid, 0);
}

export function assertOwnedFrontendReplacementCluster(handle, target) {
  const lease = owned.get(handle);
  demand(lease && target?.host === host && target.port === lease.port && target.user === lease.user &&
    target.serverMajor === lease.serverMajor);
  verifyLease(lease);
  return lease.proof;
}

export async function openOwnedFrontendReplacementCluster(directory, pgBin, user, key, cert) {
  const info = lstatSync(directory);
  demand(resolve(directory) === directory && realpathSync(directory) === directory && info.isDirectory() &&
    info.uid === process.getuid() && (info.mode & 0o077) === 0 && readdirSync(directory).length === 0 &&
    /^owned_frontend_[a-z0-9_]{1,47}$/u.test(user) && resolve(pgBin) === pgBin);
  const workspace = dirname(directory);
  const workspaceInfo = lstatSync(workspace);
  demand(workspaceInfo.isDirectory() && workspaceInfo.uid === process.getuid() && (workspaceInfo.mode & 0o077) === 0 &&
    key === join(workspace, "server.key") && cert === join(workspace, "server.crt"));
  for (const file of [key, cert]) {
    const fileInfo = lstatSync(file);
    demand(fileInfo.isFile() && fileInfo.uid === process.getuid() && (fileInfo.mode & (file === key ? 0o077 : 0o022)) === 0);
  }
  const postgres = join(pgBin, "postgres");
  const serverMajor = Number(/PostgreSQL\) (16|18)\./u.exec(run(postgres, ["--version"]))?.[1]);
  demand([16, 18].includes(serverMajor));
  const dataDirectory = join(directory, "data"), port = await loopbackPort();
  run(join(pgBin, "initdb"), ["-D", dataDirectory, "-A", "trust", "-U", user, "-E", "UTF8", "--locale=C"]);
  demand(realpathSync(dataDirectory) === dataDirectory);
  const systemIdentifier = /^Database system identifier:\s+([1-9][0-9]*)\s*$/mu.exec(run(join(pgBin, "pg_controldata"), [dataDirectory]))?.[1];
  demand(systemIdentifier);
  // Only helper-owned copies are named in the generated configuration.
  writeFileSync(join(dataDirectory, "server.key"), readFileSync(key), { mode: 0o600, flag: "wx" });
  const certificate = readFileSync(cert, "utf8");
  writeFileSync(join(dataDirectory, "server.crt"), certificate, { mode: 0o600, flag: "wx" });
  writeFileSync(join(dataDirectory, "postgresql.conf"), `listen_addresses='${host}'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='server.crt'\nssl_key_file='server.key'\npassword_encryption='scram-sha-256'\n`);
  writeFileSync(join(dataDirectory, "pg_hba.conf"), `hostssl all ${user} ${host}/32 trust\nhostssl all all ${host}/32 scram-sha-256\n`);
  const fd = openSync(join(directory, "postgres.log"), "wx", 0o600);
  let child;
  try { child = spawn(postgres, ["-D", dataDirectory], { stdio: ["ignore", fd, fd], env: commandEnvironment }); }
  finally { closeSync(fd); }
  const proof = Object.freeze({ dataDirectory, systemIdentifier });
  const lease = { active: true, exited: false, child, proof, port, user, serverMajor };
  child.on("error", () => { lease.active = false; });
  const finished = new Promise(done => child.once("close", () => { lease.exited = true; done(); }));
  const stopOnExit = () => { if (!lease.exited) child.kill("SIGQUIT"); };
  process.once("exit", stopOnExit);
  const stop = async () => {
    lease.active = false;
    if (!lease.exited) child.kill("SIGQUIT");
    const timer = setTimeout(() => { if (!lease.exited) child.kill("SIGKILL"); }, 5000);
    try { await finished; }
    finally { clearTimeout(timer); process.removeListener("exit", stopOnExit); }
  };
  const connect = async (database, login = user, password) => {
    const client = new Client({ host, port, database, user: login, password, connectionTimeoutMillis: 1000,
      ssl: { rejectUnauthorized: true, ca: certificate } });
    try {
      await client.connect();
      demand(client.connection.stream.encrypted === true && client.connection.stream.authorized === true);
      return client;
    } catch (error) { await client.end(); throw error; }
  };
  try {
    let observer;
    const deadline = Date.now() + 15_000;
    while (!observer && lease.active && !lease.exited && Date.now() < deadline) {
      try { observer = await connect("postgres"); }
      catch { await delay(50); }
    }
    demand(observer);
    try {
      const rows = (await observer.query(`select pg_catalog.current_setting('data_directory') as data_directory,
        (pg_catalog.pg_control_system()).system_identifier::text as system_identifier, session_user as login,
        pg_catalog.current_setting('server_version_num')::int/10000 as major,
        pg_catalog.host(pg_catalog.inet_server_addr()) as host, pg_catalog.inet_server_port() as port`)).rows;
      const [identity] = rows;
      demand(rows.length === 1 && identity.data_directory === dataDirectory && identity.system_identifier === systemIdentifier &&
        identity.login === user && identity.major === serverMajor && identity.host === host && identity.port === port);
      verifyLease(lease);
    } finally { await observer.end(); }
    const handle = Object.freeze({ port, connect, stop });
    owned.set(handle, lease);
    return handle;
  } catch (error) { await stop(); throw error; }
}
