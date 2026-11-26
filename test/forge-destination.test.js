// Forge Ledger as the second destination: what postToForge sends, when it skips, and that a
// failure to reach Forge never fails the submission. Node's own test runner; fictional data only.
const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postToForge } = require('../submission-utils');

const SECRET = 'forge-destination-test-secret-0123456789';
const PAYLOAD = { submissionType: 'online_form', source: 'collette-intake-form-netlify', clientName: 'Test Fictional' };
let server;
let origin;
let received;
let answer;
const saved = {};

beforeEach(async () => {
  received = [];
  answer = { status: 202, delay: 0 };
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      setTimeout(() => {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end('{}');
      }, answer.delay);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['FORGE_INTAKE_WEBHOOK_URL', 'FORGE_INTAKE_WEBHOOK_SECRET', 'FORGE_INTAKE_TIMEOUT_MS']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('posts the payload as JSON with the secret as a bearer header', async () => {
  process.env.FORGE_INTAKE_WEBHOOK_URL = `${origin}/api/v1/crm/intake-submissions`;
  process.env.FORGE_INTAKE_WEBHOOK_SECRET = SECRET;
  const result = await postToForge(PAYLOAD);
  assert.deepEqual(result, { status: 202, skipped: false });
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/api/v1/crm/intake-submissions');
  assert.equal(received[0].headers['content-type'], 'application/json');
  assert.equal(received[0].headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(received[0].body), PAYLOAD);
});

test('skips, sending nothing, until both values are set', async () => {
  assert.deepEqual(await postToForge(PAYLOAD), { status: null, skipped: true });
  process.env.FORGE_INTAKE_WEBHOOK_URL = `${origin}/api/v1/crm/intake-submissions`;
  assert.deepEqual(await postToForge(PAYLOAD), { status: null, skipped: true });
  assert.equal(received.length, 0);
});

test('a refusal from Forge is reported, not thrown', async () => {
  process.env.FORGE_INTAKE_WEBHOOK_URL = `${origin}/api/v1/crm/intake-submissions`;
  process.env.FORGE_INTAKE_WEBHOOK_SECRET = SECRET;
  answer.status = 401;
  assert.deepEqual(await postToForge(PAYLOAD), { status: 401, skipped: false });
});

test('an unreachable or slow Forge never fails the submission', async () => {
  process.env.FORGE_INTAKE_WEBHOOK_SECRET = SECRET;
  process.env.FORGE_INTAKE_WEBHOOK_URL = 'http://127.0.0.1:9/api/v1/crm/intake-submissions';
  assert.deepEqual(await postToForge(PAYLOAD), { status: null, skipped: false });
  process.env.FORGE_INTAKE_WEBHOOK_URL = `${origin}/api/v1/crm/intake-submissions`;
  process.env.FORGE_INTAKE_TIMEOUT_MS = '50';
  answer.delay = 500;
  assert.deepEqual(await postToForge(PAYLOAD), { status: null, skipped: false });
});
