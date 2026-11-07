import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const root = '/Users/dardan/workspace/lash-her-frontend/.worktrees/p2q-buy-now-response';
const require = createRequire(root + '/package.json');
const { firefox, expect } = require('@playwright/test');
const source = fs.readFileSync(root + '/tests/product-detail.spec.ts', 'utf8');
const snippet = source.slice(source.indexOf('    const checkoutResponse = page.waitForResponse('), source.indexOf('    expect(checkoutPayload).toBeDefined();'));
assert(snippet.includes('await pay.click()'));
assert(snippet.includes('response.request().method() === "POST"'));
const runSourceWaiter = new Function('page', 'pay', 'expect', `return (async () => {${snippet}})()`);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><button>Pay securely</button><script>document.querySelector("button").onclick=()=>fetch("/api/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fulfillmentMode:"manual_pickup",items:[{productId:"commerce-e2e-manual",quantity:1}]})});</script>');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
let context;
try {
  browser = await firefox.launch({ headless: true });
  context = await browser.newContext();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await context.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  let checkoutPayload;
  let entered;
  const handlerEntered = new Promise(resolve => { entered = resolve; });
  let release;
  const handlerGate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/checkout', async route => {
    entered();
    await handlerGate;
    checkoutPayload = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orderId: 'owned-order', status: 'paid' }) });
  });
  await page.goto(origin);
  const request = page.waitForRequest('**/api/checkout');
  let sourceFinished = false;
  const corrected = runSourceWaiter(page, page.getByRole('button', { name: 'Pay securely' }), expect).then(() => { sourceFinished = true; });
  await request;
  await handlerEntered;
  assert.equal(checkoutPayload, undefined);
  assert.equal(sourceFinished, false);
  release();
  await corrected;
  assert.deepEqual(checkoutPayload, { fulfillmentMode: 'manual_pickup', items: [{ productId: 'commerce-e2e-manual', quantity: 1 }] });
  const result = {
    version: 1,
    status: 'OWNED_FIREFOX_RESPONSE_ORDERING_PASS',
    nodeVersion: process.version,
    playwrightVersion: require('@playwright/test/package.json').version,
    browserVersion: browser.version(),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    actualBrowser: true,
    loopbackOnly: true,
    handlerDelayControlled: true,
    requestEventBeforePayloadCapture: true,
    responseWaitPendingUntilHandlerReleased: true,
    sourceResponseWaiterUsed: true,
    payloadCapturedBeforeResponseAssertions: true,
    providerTouched: false,
    fullApplicationCaseQualified: false,
    historicalFailureTimingProved: false,
  };
  fs.writeFileSync('/private/tmp/p2q-buy-now-response-20261106/firefox-ordering.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  await context?.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
