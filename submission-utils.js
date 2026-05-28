const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

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

  const clientIdentifierFields = normalizeClientIdentifierFields(body);
  const caseTypes = normalizeCaseTypes(body.caseTypes);
  const children = normalizeChildren(body.children, body);
  const clientNameForFile = sanitizeFilePart(body.clientName);
  const matterTypeForFile = sanitizeFilePart(caseTypes[0] || body.matterType || 'Intake');
  const generatedDocxFileName = `${clientNameForFile}_${matterTypeForFile}_Completed_Form.docx`;
  const generatedPdfFileName = `${clientNameForFile}_${matterTypeForFile}_Completed_Form.pdf`;

  const templateData = {
    ...body,
    ...clientIdentifierFields,
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

  const completedDocx = await renderCompletedDocx(templateData);
  const completedDocxBase64 = completedDocx.toString('base64');

  const payload = {
    ...templateData,
    source: SOURCE_NAME,
    receivedAt: new Date().toISOString(),
    completedFileName: generatedDocxFileName,
    completedFileContentBase64: completedDocxBase64,
    file: {
      fileName: generatedDocxFileName,
      contentType: DOCX_CONTENT_TYPE,
      size: completedDocx.length,
      contentBase64: completedDocxBase64,
    },
    documentGeneration: {
      action: 'website_generated_docx',
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

async function postToPowerAutomate(payload, options = {}) {
  const config = getConfig();
  const required = options.required !== false;
  if (!config.webhookUrl) {
    if (!required) return { status: null, skipped: true, body: '' };
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

async function renderCompletedDocx(templateData) {
  const templateBuffer = await readTemplateFile();
  const entries = unzipEntries(templateBuffer);
  const documentEntry = entries.get('word/document.xml');
  const relsEntry = entries.get('word/_rels/document.xml.rels');
  if (!documentEntry || !relsEntry) {
    throw new HttpError(500, 'The Word template is missing required document parts.');
  }

  const signatureImage = dataUrlToBuffer(templateData.signature);
  const signatureRelId = nextRelationshipId(relsEntry.data.toString('utf8'));
  const signatureFileName = 'word/media/signature.png';
  const textValues = {
    ...templateData,
    caseTypes: templateData.caseTypesText || normalizeCaseTypes(templateData.caseTypes).join(', '),
    signature: '',
  };

  let documentXml = documentEntry.data.toString('utf8');
  for (const [key, value] of Object.entries(textValues)) {
    if (key === 'signature') continue;
    documentXml = replacePlaceholder(documentXml, key, value);
  }
  documentXml = documentXml.replace(/<w:t>\{\{signature\}\}<\/w:t>/g, signatureDrawingXml(signatureRelId));
  documentXml = documentXml.replace(/\{\{[A-Za-z0-9_]+\}\}/g, '');

  const relsXml = relsEntry.data
    .toString('utf8')
    .replace(
      '</Relationships>',
      `<Relationship Id="${signatureRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/signature.png"/></Relationships>`,
    );

  entries.set('word/document.xml', { data: Buffer.from(documentXml, 'utf8') });
  entries.set('word/_rels/document.xml.rels', { data: Buffer.from(relsXml, 'utf8') });
  entries.set(signatureFileName, { data: signatureImage });
  return zipEntries(entries);
}

function replacePlaceholder(xml, key, value) {
  const placeholder = `{{${key}}}`;
  if (!xml.includes(placeholder)) return xml;
  return xml.split(placeholder).join(xmlTextWithBreaks(value));
}

function xmlTextWithBreaks(value) {
  const cleaned = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return cleaned
    .split('\n')
    .map(escapeXml)
    .join('</w:t><w:br/><w:t>');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function dataUrlToBuffer(value) {
  const match = String(value || '').match(/^data:image\/png;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new HttpError(400, 'Signature must be a PNG data URL.');
  return Buffer.from(match[1].replace(/\s/g, ''), 'base64');
}

function nextRelationshipId(relsXml) {
  const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number.parseInt(match[1], 10));
  return `rId${Math.max(0, ...ids) + 1}`;
}

function signatureDrawingXml(relId) {
  return `<w:drawing><wp:inline xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:extent cx="3200400" cy="777240"/><wp:docPr id="2001" name="Signature"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="signature.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3200400" cy="777240"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function unzipEntries(buffer) {
  const entries = new Map();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new HttpError(500, 'Invalid Word template zip directory.');
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = compressionMethod === 0
      ? Buffer.from(compressedData)
      : zlib.inflateRawSync(compressedData);

    entries.set(fileName, { data });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new HttpError(500, 'Invalid Word template zip structure.');
}

function zipEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [fileName, entry] of entries) {
    const fileNameBuffer = Buffer.from(fileName, 'utf8');
    const data = Buffer.from(entry.data);
    const compressedData = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(fileNameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, fileNameBuffer, compressedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, fileNameBuffer);

    offset += localHeader.length + fileNameBuffer.length + compressedData.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.size, 8);
  endRecord.writeUInt16LE(entries.size, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

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

function normalizeClientIdentifierFields(body) {
  const clientNoDriversLicense = isTruthy(body.clientNoDriversLicense);
  const clientNoSsn = isTruthy(body.clientNoSsn);
  const clientDlLast3 = String(body.clientDlLast3 || '').trim();
  const clientSsnLast3 = String(body.clientSsnLast3 || '').trim();

  if (!clientNoDriversLicense && !/^\d{3}$/.test(clientDlLast3)) {
    throw new HttpError(400, "Last 3 digits of driver's license are required unless the client does not have a driver's license.");
  }

  if (!clientNoSsn && !/^\d{3}$/.test(clientSsnLast3)) {
    throw new HttpError(400, 'Last 3 digits of Social Security number are required unless the client does not have a Social Security number.');
  }

  return {
    clientNoDriversLicense,
    clientNoSsn,
    clientDlLast3: clientNoDriversLicense ? "No driver's license" : clientDlLast3,
    clientSsnLast3: clientNoSsn ? 'No Social Security number' : clientSsnLast3,
  };
}

function isTruthy(value) {
  return value === true || /^(true|1|on|yes)$/i.test(String(value || '').trim());
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
