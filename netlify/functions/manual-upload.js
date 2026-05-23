const {
  createManualUploadPayload,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  postToPowerAutomate,
} = require('../../submission-utils');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  }

  try {
    assertJsonRequest(event);
    const body = parseJsonBody(event.body, event.isBase64Encoded);
    const payload = createManualUploadPayload(body);
    const webhookResult = await postToPowerAutomate(payload);

    return jsonResponse(200, {
      ok: true,
      message: 'Manual upload submitted successfully.',
      uploadedFileName: payload.normalizedUploadedFileName,
      powerAutomateStatus: webhookResult.status,
    });
  } catch (error) {
    return errorResponse(error);
  }
};

function assertJsonRequest(event) {
  const contentType = String(event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const error = new Error('Expected application/json.');
    error.statusCode = 415;
    throw error;
  }
}
