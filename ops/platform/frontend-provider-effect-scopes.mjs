// Fixed source modules supply their own literal query plans and safe snapshot
// normalization. No caller SQL, module path, credential or live CLI is accepted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const host = fileURLToPath(new URL("./host", import.meta.url));
const providers = new Set(["square", "resend", "highlevel", "chitchats"]);
const demand = ok => { if (!ok) throw new Error("FRONTEND_PROVIDER_EFFECT_SCOPE_REFUSED"); };
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const program = `import hashlib,importlib,json,pathlib,sys
sys.path.insert(0,sys.argv[1])
modules={'square':'frontend_square_financial_scope','resend':'frontend_resend_marketing_scope','highlevel':'frontend_highlevel_history','chitchats':'frontend_chitchats_transient_effects'}
try:
 value=json.loads(sys.stdin.buffer.read(2000001))
 module=importlib.import_module(modules[value['provider']])
 digest=hashlib.sha256(pathlib.Path(module.__file__).read_bytes()).hexdigest()
 if value['task']=='queries':
  result={'queries':[{'name':name,'sql':sql,'params':params} for name,sql,params in module.database_queries(value['reviewed'])]}
 elif value['task']=='normalize':
  snapshot=module.normalize_snapshot(value['rows'])
  result={'snapshot':snapshot,'snapshotSha256':hashlib.sha256(json.dumps(snapshot,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()).hexdigest()}
 else: raise ValueError('FIXED_TASK_REQUIRED')
 print(json.dumps({'version':1,'moduleSha256':digest,**result},separators=(',',':'),ensure_ascii=True,allow_nan=False))
except BaseException:
 raise SystemExit(1) from None
`;

function invoke(provider, task, value, dependencies = {}) {
  try {
    demand(providers.has(provider));
    const input = JSON.stringify({ provider, task, ...value });
    demand(Buffer.byteLength(input) <= 2_000_000);
    const output = execFileSync("python3", ["-I", "-B", "-c", program, dependencies.hostDirectory ?? host], {
      input, maxBuffer: 2_000_000, timeout: 15000, stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const result = JSON.parse(output.toString("utf8"));
    demand(result?.version === 1 && /^[a-f0-9]{64}$/u.test(result.moduleSha256));
    return result;
  } catch { throw new Error("FRONTEND_PROVIDER_EFFECT_SCOPE_REFUSED"); }
}

export function frontendScopedProviderQueryPlan(provider, reviewed, dependencies = {}) {
  const result = invoke(provider, "queries", { reviewed }, dependencies), { queries } = result;
  demand(Array.isArray(queries) && queries.length > 0 && queries.length <= 32 && new Set(queries.map(row => row?.name)).size === queries.length);
  for (const row of queries) demand(typeof row.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(row.name) &&
    typeof row.sql === "string" && row.sql.length <= 20000 && /^\s*SELECT\b/iu.test(row.sql) && !/;|--|\/\*/u.test(row.sql) &&
    /\bLIMIT\s+4097\s*$/iu.test(row.sql) && Array.isArray(row.params) && row.params.length <= 32);
  return { ...result, queryPlanSha256: hash({ moduleSha256: result.moduleSha256, queries }) };
}

export function normalizeFrontendScopedProviderSnapshot(provider, rows, dependencies = {}) {
  const result = invoke(provider, "normalize", { rows }, dependencies);
  demand(result.snapshot && typeof result.snapshot === "object" && !Array.isArray(result.snapshot) &&
    /^[a-f0-9]{64}$/u.test(result.snapshotSha256));
  return result;
}

export async function observeFrontendScopedProviderDatabase(client, provider, reviewed, verifySession, dependencies = {}) {
  demand(client && typeof verifySession === "function");
  const plan = frontendScopedProviderQueryPlan(provider, reviewed, dependencies);
  const rows = {};
  await verifySession();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const query of plan.queries) {
      await verifySession();
      const result = await client.query(query.sql, query.params);
      demand(Array.isArray(result.rows) && result.rows.length <= 4096);
      rows[query.name] = result.rows;
    }
    await verifySession();
    const normalized = normalizeFrontendScopedProviderSnapshot(provider, rows, dependencies);
    demand(normalized.moduleSha256 === plan.moduleSha256);
    await client.query("ROLLBACK");
    await verifySession();
    return { actualRows: rows, normalizedSnapshot: normalized.snapshot, snapshotSha256: normalized.snapshotSha256,
      queryPlanSha256: plan.queryPlanSha256, moduleSha256: plan.moduleSha256 };
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* no partial observation authorizes SQL */ }
    throw new Error("FRONTEND_PROVIDER_EFFECT_SCOPE_REFUSED");
  }
}
