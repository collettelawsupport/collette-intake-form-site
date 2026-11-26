#!/usr/bin/env node
/*
 * Captures the exact request this site sends to Forge Ledger, for Forge's integration test to
 * replay. It runs the real Netlify functions (online-submission and manual-upload) on fictional
 * form data, with Power Automate and Forge both pointed at a local server that records what
 * arrives, and writes one gzipped JSON file per submission type:
 *
 *   { method, path, headers: { content-type, authorization, content-length }, body }
 *
 * `body` is the request body exactly as sent (a string). The bearer secret is the test secret
 * below, never a real one. Every answer is fictional.
 *
 *   node scripts/capture-forge-request.js <output directory>
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TEST_SECRET = 'forge-intake-fixture-test-secret-not-for-production';
const FORGE_PATH = '/api/v1/crm/intake-submissions';
// A 1×1 transparent PNG: the drawn signature.
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// The smallest PDF a reader opens: the manually uploaded form.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const ONLINE_FORM = {
  date: '11/26/2026',
  clientName: 'Riley Fixture Applicant',
  clientAddress: '1 Fictional Way',
  clientCity: 'Springfield',
  clientState: 'TX',
  clientZip: '75000',
  clientCounty: 'Example',
  residenceLength: '3 years',
  clientDob: '01/02/1990',
  clientDlLast3: '123',
  clientSsnLast3: '456',
  clientPhone: '555-0100',
  clientEmail: 'riley.fixture@example.test',
  employer: 'Example Employer',
  monthlyIncome: '3000',
  spouseName: 'Sam Fixture Spouse',
  children: [{ name: 'Child Example', dateOfBirth: '04/10/2015', sex: 'Female' }],
  caseTypes: ['Divorce with Children'],
  mainLegalIssue: 'Fictional example issue for the replay fixture',
  referralSource: 'Google',
  signatureMethod: 'draw',
  signature: SIGNATURE,
  signatureDate: '11/26/2026',
  timestamp: '2026-11-26T15:00:00.000Z',
};

const MANUAL_UPLOAD = {
  clientName: 'Morgan Fixture Uploader',
  matterType: 'Estate Planning',
  uploadedFileName: 'completed-form.pdf',
  fileBase64: PDF.toString('base64'),
  timestamp: '2026-11-26T15:05:00.000Z',
};

const captureOne = async (functionName, form) => {
  let captured = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === FORGE_PATH) {
        captured = {
          method: request.method,
          path: request.url,
          headers: {
            'content-type': request.headers['content-type'],
            authorization: request.headers.authorization,
            'content-length': request.headers['content-length'],
          },
          body: Buffer.concat(chunks).toString('utf8'),
        };
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end('{"received":true}');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.POWER_AUTOMATE_WEBHOOK_URL = `${origin}/power-automate`;
  process.env.FORGE_INTAKE_WEBHOOK_URL = `${origin}${FORGE_PATH}`;
  process.env.FORGE_INTAKE_WEBHOOK_SECRET = TEST_SECRET;
  try {
    const { handler } = require(`../netlify/functions/${functionName}`);
    const result = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
      isBase64Encoded: false,
    });
    if (result.statusCode !== 200) throw new Error(`${functionName} answered ${result.statusCode}: ${result.body}`);
    if (!captured) throw new Error(`${functionName} sent nothing to Forge`);
    return captured;
  } finally {
    server.close();
  }
};

const main = async () => {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node scripts/capture-forge-request.js <output directory>');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, functionName, form] of [
    ['netlify-online-submission', 'online-submission', ONLINE_FORM],
    ['netlify-manual-upload', 'manual-upload', MANUAL_UPLOAD],
  ]) {
    const captured = await captureOne(functionName, form);
    const file = path.join(out, `${name}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(captured, null, 2)));
    console.log(`${file}: ${captured.method} ${captured.path}, ${captured.headers['content-length']} bytes`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
