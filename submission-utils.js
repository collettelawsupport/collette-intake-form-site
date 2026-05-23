const fs = require('node:fs/promises');
const path = require('node:path');

const TEMPLATE_FILE_NAME = 'ClientIntakeForm_Automation_Template.docx';
const SOURCE_NAME = 'collette-intake-form-netlify';
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function getConfig() {
  return {
    webhookUrl: process.env.POWER_AUTOMATE_WEBHOOK_URL || '',
    maxUploadBytes: Number.parseInt(process.env.MAX_UPLOAD_BYTES || String(15 * 1024 * 1024), 10),
    maxJsonBodyBytes: Number.parseInt(process.env.MAX_JSON_BODY_BYTES || String(30 * 1024 * 1024), 10),
    timeoutMs: Number.parseInt(process.env.POWER_AUTOMATE_TIMEOUT_MS || '20000', 10),
    includeTemplateBase64: /^true$/i.test(process.env.INCLUDE_TEMPLATE_BASE64 || ''),
  };
}

function parseJsonBody(rawBody, isBase64Encoded = false) {
  const config = getConfig();
  const bodyText = isBase64Encoded
    ? Buffer.from(rawBody || '', 'base64').toString('utf8')
    : String(rawBody || '');

  if (Buffer.byteLength(bodyText, 'utf8') > config.maxJsonBodyBytes) {
    throw new HttpError(413, `Request body exceeds the ${config.maxJsonBodyBytes} byte limit.`);
  }

  if (!bodyText.trim()) return {};

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

async function createOnlinePayload(body) {
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
  return payload;
}

function createManualUploadPayload(body) {
  const config = getConfig();
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
  if (fileBuffer.length > config.maxUploadBytes) {
    throw new HttpError(413, `Uploaded file exceeds the ${config.maxUploadBytes} byte limit.`);
  }

  validateFileSignature(extension, fileBuffer);

  const clientNameForFile = sanitizeFilePart(clientName);
  const matterTypeForFile = sanitizeFilePart(matterType);
  const normalizedUploadedFileName = `${clientNameForFile}_${matterTypeForFile}_Completed_Form${extension}`;
  const contentType = extension === '.pdf' ? 'application/pdf' : DOCX_CONTENT_TYPE;

  return {
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
}

async function postToPowerAutomate(payload) {
  const config = getConfig();
  if (!config.webhookUrl) {
    throw new HttpError(500, 'Server is missing POWER_AUTOMATE_WEBHOOK_URL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.webhookUrl, {
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

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(payload),
  };
}

function errorResponse(error) {
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

  return jsonResponse(statusCode, payload);
}

async function maybeAttachTemplate(payload) {
  const config = getConfig();
  if (!config.includeTemplateBase64) return;

  const templateBuffer = await readTemplateFile();
  payload.documentGeneration.template = {
    fileName: TEMPLATE_FILE_NAME,
    contentType: DOCX_CONTENT_TYPE,
    contentBase64: templateBuffer.toString('base64'),
  };
}

async function readTemplateFile() {
  const candidates = [
    path.join(process.cwd(), TEMPLATE_FILE_NAME),
    path.join(__dirname, TEMPLATE_FILE_NAME),
    path.join(__dirname, '..', TEMPLATE_FILE_NAME),
    path.join(__dirname, '..', '..', TEMPLATE_FILE_NAME),
  ];

  for (const filePath of candidates) {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  throw new HttpError(500, `${TEMPLATE_FILE_NAME} was not found in the function bundle.`);
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

module.exports = {
  createManualUploadPayload,
  createOnlinePayload,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  postToPowerAutomate,
};
