#!/usr/bin/env node
// Fetch an SSO-protected Vercel preview/staging URL using the project's
// Protection Bypass for Automation secret.
//
// The secret is never printed and never hardcoded: it is read from the
// VERCEL_AUTOMATION_BYPASS_SECRET env var, falling back to the gitignored
// .codex/config.toml. Every request carries the `x-vercel-protection-bypass`
// header (so protection is bypassed without a redirect loop) and reuses the
// `_vercel_jwt` cookie once Vercel issues it. Redirects are followed manually
// and only on the same host, so the secret never leaks to an off-host SSO page
// and we never hit "redirect count exceeded".
//
// Usage:
//   node bypass-fetch.mjs <url> [options]
//
// Options:
//   --method <M>          HTTP method (default GET)
//   --data <BODY>         Request body (implies POST unless --method given)
//   --data-file <PATH>    Read request body from a file
//   --header "K: V"       Extra request header (repeatable)
//   --max-body <N>        Truncate printed body to N chars (default 100000, 0 = no limit)
//   --dump-headers        Print all response headers
//   --print-bypass-query  Print only the query string to append for a browser
//                         handshake URL, then exit (?x-vercel-protection-bypass=...)
//
// Exit code is 0 for a 2xx/3xx response, 1 for 4xx/5xx or transport errors.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function findConfigToml() {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = start;
    while (true) {
      const candidate = path.join(dir, '.codex', 'config.toml');
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function readSecret() {
  const fromEnv = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const configPath = findConfigToml();
  if (configPath) {
    const toml = readFileSync(configPath, 'utf8');
    const m = toml.match(
      /^\s*VERCEL_AUTOMATION_BYPASS_SECRET\s*=\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m,
    );
    if (m && m[1].trim()) return m[1].trim();
  }

  throw new Error(
    'VERCEL_AUTOMATION_BYPASS_SECRET not found. Set it in the environment or in ' +
      '.codex/config.toml under [mcp.servers.vercel.env]. Ask the owner if it is missing.',
  );
}

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function extractJwt(setCookies) {
  for (const sc of setCookies) {
    const m = sc.match(/_vercel_jwt=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

async function bypassFetch(targetUrl, { method, body, headers, secret }) {
  const originHost = new URL(targetUrl).host;
  let currentUrl = targetUrl;
  let currentMethod = method;
  let currentBody = body;
  let jwt = null;

  for (let hop = 0; hop <= 5; hop++) {
    const h = new Headers(headers);
    h.set('x-vercel-protection-bypass', secret);
    h.set('x-vercel-set-bypass-cookie', 'true');
    if (jwt) h.set('cookie', `_vercel_jwt=${jwt}`);

    const res = await fetch(currentUrl, {
      method: currentMethod,
      body: currentBody,
      headers: h,
      redirect: 'manual',
    });

    const freshJwt = extractJwt(getSetCookies(res));
    if (freshJwt) jwt = freshJwt;

    if (!REDIRECT_STATUS.has(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.host !== originHost) {
      // Redirected off-host (SSO login) — bypass did not take. Do not send the
      // secret to another host; surface this response to the caller.
      return res;
    }
    currentUrl = nextUrl.toString();
    if (res.status === 303) {
      currentMethod = 'GET';
      currentBody = undefined;
    }
  }
  throw new Error('Too many same-host redirects (5) — deployment protection may be misconfigured.');
}

function parseArgs(argv) {
  const opts = {
    url: null,
    method: null,
    body: undefined,
    headers: [],
    maxBody: 100000,
    dumpHeaders: false,
    printBypassQuery: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--method') opts.method = argv[++i];
    else if (a === '--data') opts.body = argv[++i];
    else if (a === '--data-file') opts.body = readFileSync(argv[++i], 'utf8');
    else if (a === '--header') opts.headers.push(argv[++i]);
    else if (a === '--max-body') opts.maxBody = Number(argv[++i]);
    else if (a === '--dump-headers') opts.dumpHeaders = true;
    else if (a === '--print-bypass-query') opts.printBypassQuery = true;
    else if (!a.startsWith('--') && !opts.url) opts.url = a;
    else throw new Error(`Unrecognized argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const secret = readSecret();

  if (opts.printBypassQuery) {
    // For a browser handshake: navigate to <preview-origin>/<path>?<this>
    process.stdout.write(
      `x-vercel-protection-bypass=${encodeURIComponent(secret)}&x-vercel-set-bypass-cookie=true\n`,
    );
    return;
  }

  if (!opts.url) throw new Error('Missing <url>. Usage: node bypass-fetch.mjs <url> [options]');

  const headers = {};
  for (const raw of opts.headers) {
    const idx = raw.indexOf(':');
    if (idx === -1) throw new Error(`Bad --header (expected "K: V"): ${raw}`);
    headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');

  const res = await bypassFetch(opts.url, { method, body: opts.body, headers, secret });

  process.stdout.write(`STATUS ${res.status} ${res.statusText}\n`);
  process.stdout.write(`content-type: ${res.headers.get('content-type') || '(none)'}\n`);
  const location = res.headers.get('location');
  if (location) process.stdout.write(`location: ${location}\n`);
  if (opts.dumpHeaders) {
    process.stdout.write('--- headers ---\n');
    for (const [k, v] of res.headers) process.stdout.write(`${k}: ${v}\n`);
  }
  process.stdout.write('--- body ---\n');

  let text = await res.text();
  if (opts.maxBody > 0 && text.length > opts.maxBody) {
    text = text.slice(0, opts.maxBody) + `\n… [truncated ${text.length - opts.maxBody} chars]`;
  }
  process.stdout.write(text + '\n');

  process.exit(res.status >= 400 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
