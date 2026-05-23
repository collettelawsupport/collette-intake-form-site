const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
loadEnvFile(path.join(ROOT_DIR, '.env'));

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const WEBHOOK_URL = process.env.POWER_AUTOMATE_WEBHOOK_URL || '';
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES || String(15 * 1024 * 1024), 10);
const MAX_JSON_BODY_BYTES = Number.parseInt(process.env.MAX_JSON_BODY_BYTES || String(30 * 1024 * 1024), 10);
const WEBHOOK_TIMEOUT_MS = Number.parseInt(process.env.POWER_AUTOMATE_TIMEOUT_MS || '20000', 10);
const INCLUDE_TEMPLATE_BASE64 = /^true$/i.test(process.env.INCLUDE_TEMPLATE_BASE64 || '');
const TEMPLATE_FILE_NAME = 'ClientIntakeForm_Automation_Template.docx';
const SOURCE_NAME = 'collette-intake-form-netlify';

const PUBLIC_FILES = new Set([
  'index.html',
  'collette-law-logo.png',
  'ClientIntakeForm_Blank_Download.docx',
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/api/online-submission') {
      await handleOnlineSubmission(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/manual-upload') {
      await handleManualUpload(req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url);
      return;
    }

    sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
  } catch (error) {
    handleError(res, error);
  }
});

server.listen(PORT, () => {
  console.log(`Collette intake form server listening on http://localhost:${PORT}`);
  if (!WEBHOOK_URL) {
    console.warn('POWER_AUTOMATE_WEBHOOK_URL is not set. Submissions will return a configuration error.');
  }
});

async function handleOnlineSubmission(req, res) {
  assertJsonRequest(req);
  const body = await readJson(req, MAX_JSON_BODY_BYTES);
  const requiredFields = [
    'date',
    'clientName',
    'clientAddress',
    'clientState',
    'clientZip',
    'clientPhone',
    'clientEmail',
    'mainLegalIssue',
    'signature',
    'signatureDate',
  ];

  const missingFields = requiredFields.filter((field) => !String(body[field] || '').trim());
  if (missingFields.length) {
    throw new HttpError(400, `Missing required field(s): ${missingFields.join(', ')}`);
  }

  if (!isPngDataUrl(body.signature)) {
    throw new HttpError(400, 'Signature must be a PNG data URL.');
  }

  const caseTypes = normalizeCaseTypes(body.caseTypes);
  const children = normalizeChildren(body.children, body);
  const clientNameForFile = sanitizeFilePart(body.clientName);
  const matterTypeForFile = sanitizeFilePart(caseTypes[0] || body.matterType || 'Intake');
  const generatedDocxFileName = `${clientNameForFile}_${matterTypeForFile}_Completed_Form.docx`;
  const generatedPdfFileName = `${clientNameForFile}_${matterTypeForFile}_Completed_Form.pdf`;

  const templateData = {
    ...body,
    submissionType: 'online_form',
    timestamp: body.timestamp || new Date().toISOString(),
    caseTypes,
    caseTypesText: caseTypes.join(', '),
    children,
    childrenText: buildChildrenText(children),
    clientNameForFile,
    matterTypeForFile,
    generatedDocxFileName,
    generatedPdfFileName,
  };

  const payload = {
    ...templateData,
    source: SOURCE_NAME,
    receivedAt: new Date().toISOString(),
    documentGeneration: {
      action: 'create_docx_and_pdf',
      templateFileName: TEMPLATE_FILE_NAME,
      outputDocxFileName: generatedDocxFileName,
      outputPdfFileName: generatedPdfFileName,
      templateData,
    },
  };

  await maybeAttachTemplate(payload);
  const webhookResult = await postToPowerAutomate(payload);
  sendJson(res, 200, {
    ok: true,
    message: 'Online form submitted successfully.',
    generatedDocxFileName,
    generatedPdfFileName,
    powerAutomateStatus: webhookResult.status,
  });
}

async function handleManualUpload(req, res) {
  assertJsonRequest(req);
  const body = await readJson(req, MAX_JSON_BODY_BYTES);
  const clientName = String(body.clientName || body.manualClientName || '').trim();
  const matterType = String(body.matterType || body.manualMatterType || '').trim();
  const uploadedFileName = String(body.uploadedFileName || body.fileName || '').trim();
  const fileBase64 = stripDataUrlPrefix(String(body.fileBase64 || body.fileContentBase64 || ''));

  if (!clientName) throw new HttpError(400, 'Client name is required for manual uploads.');
  if (!matterType) throw new HttpError(400, 'Matter type is required for manual uploads.');
  if (!uploadedFileName) throw new HttpError(400, 'Uploaded file name is required.');
  if (!fileBase64) throw new HttpError(400, 'Uploaded file content is required.');

  const extension = path.extname(uploadedFileName).toLowerCase();
  if (!['.docx', '.pdf'].includes(extension)) {
    throw new HttpError(400, 'Manual uploads must be DOCX or PDF files.');
  }

  if (!looksLikeBase64(fileBase64)) {
    throw new HttpError(400, 'Uploaded file content must be base64 encoded.');
  }

  const fileBuffer = Buffer.from(fileBase64, 'base64');
  if (!fileBuffer.length) throw new HttpError(400, 'Uploaded file is empty.');
  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `Uploaded file exceeds the ${MAX_UPLOAD_BYTES} byte limit.`);
  }

  validateFileSignature(extension, fileBuffer);

  const clientNameForFile = sanitizeFilePart(clientName);
  const matterTypeForFile = sanitizeFilePart(matterType);
  const normalizedUploadedFileName = `${clientNameForFile}_${matterTypeForFile}_Completed_Form${extension}`;
  const contentType = extension === '.pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const payload = {
    submissionType: 'manual_upload',
    source: SOURCE_NAME,
    timestamp: body.timestamp || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    clientName,
    matterType,
    clientNameForFile,
    matterTypeForFile,
    uploadedFileName,
    normalizedUploadedFileName,
    file: {
      fileName: normalizedUploadedFileName,
      originalFileName: uploadedFileName,
      contentType,
      size: fileBuffer.length,
      contentBase64: fileBuffer.toString('base64'),
    },
  };

  const webhookResult = await postToPowerAutomate(payload);
  sendJson(res, 200, {
    ok: true,
    message: 'Manual upload submitted successfully.',
    uploadedFileName: normalizedUploadedFileName,
    powerAutomateStatus: webhookResult.status,
  });
}

async function postToPowerAutomate(payload) {
  if (!WEBHOOK_URL) {
    throw new HttpError(500, 'Server is missing POWER_AUTOMATE_WEBHOOK_URL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new HttpError(502, `Power Automate returned HTTP ${response.status}.`, {
        powerAutomateStatus: response.status,
        powerAutomateResponse: responseText.slice(0, 1000),
      });
    }

    return { status: response.status, body: responseText };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(504, 'Power Automate request timed out.');
    }

    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Unable to reach Power Automate.', { cause: error.message });
  } finally {
    clearTimeout(timer);
  }
}

async function maybeAttachTemplate(payload) {
  if (!INCLUDE_TEMPLATE_BASE64) return;

  const templatePath = path.join(ROOT_DIR, TEMPLATE_FILE_NAME);
  const templateBuffer = await fsp.readFile(templatePath);
  payload.documentGeneration.template = {
    fileName: TEMPLATE_FILE_NAME,
    contentType: MIME_TYPES['.docx'],
    contentBase64: templateBuffer.toString('base64'),
  };
}

async function serveStatic(req, res, url) {
  const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const fileName = path.basename(requestPath);

  if (requestPath.includes('..') || requestPath !== `/${fileName}` || !PUBLIC_FILES.has(fileName)) {
    sendJson(res, 404, { ok: false, message: 'Not found.' });
    return;
  }

  const filePath = path.join(PUBLIC_DIR, fileName);
  const extension = path.extname(fileName).toLowerCase();
  const data = await fsp.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(data);
}

function assertJsonRequest(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'Expected application/json.');
  }
}

async function readJson(req, limitBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new HttpError(413, `Request body exceeds the ${limitBytes} byte limit.`);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function normalizeCaseTypes(value) {
  const values = Array.isArray(value) ? value : [value].filter(Boolean);
  const cleaned = values.map((item) => String(item).trim()).filter(Boolean);
  return cleaned.filter((item, index) => cleaned.indexOf(item) === index);
}

function normalizeChildren(childrenValue, body) {
  if (Array.isArray(childrenValue)) {
    return childrenValue
      .map((child) => ({
        name: String(child && child.name ? child.name : '').trim(),
        dateOfBirth: String(child && child.dateOfBirth ? child.dateOfBirth : '').trim(),
      }))
      .filter((child) => child.name || child.dateOfBirth);
  }

  const children = [];
  for (let index = 1; index <= 50; index += 1) {
    const name = String(body[`child${index}Name`] || '').trim();
    const dateOfBirth = String(body[`child${index}Dob`] || '').trim();
    if (name || dateOfBirth) children.push({ name, dateOfBirth });
  }
  return children;
}

function buildChildrenText(children) {
  return children.length
    ? children.map((child, index) => `Child ${index + 1}: ${child.name || 'Name not provided'} - DOB: ${child.dateOfBirth || 'DOB not provided'}`).join('\n')
    : '';
}

function sanitizeFilePart(value) {
  return String(value || 'Unknown')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Unknown';
}

function isPngDataUrl(value) {
  return /^data:image\/png;base64,[a-z0-9+/=\s]+$/i.test(String(value || ''));
}

function stripDataUrlPrefix(value) {
  return value.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
}

function looksLikeBase64(value) {
  return /^[a-z0-9+/]+={0,2}$/i.test(value) && value.length % 4 === 0;
}

function validateFileSignature(extension, buffer) {
  if (extension === '.pdf' && buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
    throw new HttpError(400, 'Uploaded PDF content is not valid.');
  }

  if (extension === '.docx' && buffer.subarray(0, 4).toString('binary') !== 'PK\u0003\u0004') {
    throw new HttpError(400, 'Uploaded DOCX content is not valid.');
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function handleError(res, error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const payload = {
    ok: false,
    message: statusCode >= 500 ? 'Submission service error.' : error.message,
  };

  if (process.env.NODE_ENV !== 'production' && error.details) {
    payload.details = error.details;
  }

  if (process.env.NODE_ENV !== 'production' && statusCode >= 500 && error.message) {
    payload.debugMessage = error.message;
  }

  sendJson(res, statusCode, payload);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
