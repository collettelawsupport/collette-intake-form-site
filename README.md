# Collette Law Client Intake Form Website

This package is ready for Netlify. The public site stays static, and submissions go through Netlify Functions so the Power Automate HTTP trigger URL is never exposed in browser JavaScript.

## Files

- `public/index.html` - the existing intake form design, served as the homepage.
- `public/ClientIntakeForm_Blank_Download.docx` - blank Word form download.
- `public/collette-law-logo.png` - logo used by the page.
- `netlify/functions/online-submission.js` - secure online form submission endpoint.
- `netlify/functions/manual-upload.js` - secure manual upload endpoint.
- `submission-utils.js` - shared validation, file naming, and Power Automate forwarding logic.
- `ClientIntakeForm_Automation_Template.docx` - Word automation template with placeholders.
- `formFields.json` - online form field map.
- `power_automate_payload_samples.json` - examples of JSON sent to Power Automate.
- `netlify.toml` - Netlify publish directory, function bundling, and `/api/...` rewrites.
- `.env.example` - local environment variable reference.

## Netlify Setup

Use Git-based deploys or Netlify CLI for this project. A static-only drag-and-drop deploy of `public/` will publish the page, but it will not give you the backend submission flow because the Netlify Functions need to be built and deployed too.

Recommended Git deploy:

1. Push this folder to a GitHub, GitLab, or Bitbucket repository.
2. In Netlify, select **Add new project** and import the repository.
3. Netlify will read `netlify.toml`.
4. Confirm these settings if Netlify asks:
   - Build command: leave blank
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
5. Add the environment variable `POWER_AUTOMATE_WEBHOOK_URL` in Netlify with Functions scope enabled.
6. Deploy the site.

After deploy, the browser will post to:

- `/api/online-submission`
- `/api/manual-upload`

Netlify rewrites those URLs to the serverless functions:

- `/.netlify/functions/online-submission`
- `/.netlify/functions/manual-upload`

## Connect A GoDaddy Domain

The safest setup is to keep DNS at GoDaddy and add the Netlify records there. This avoids accidentally breaking existing email records.

1. Deploy and test the site on the temporary Netlify URL first, such as `your-site-name.netlify.app`.
2. In Netlify, open the site and go to **Domain management**.
3. Select **Add domain**, then **Add a domain you already own**.
4. Enter the GoDaddy domain, such as `example.com`, and confirm. Netlify will add both `example.com` and `www.example.com`.
5. In GoDaddy, open **Domain Portfolio**, select the domain, then open **DNS**.
6. Add or edit these website records:

```text
Type: A
Name: @
Value: 75.2.60.5
TTL: 1 hour or default
```

```text
Type: CNAME
Name: www
Value: your-site-name.netlify.app
TTL: 1 hour or default
```

Replace `your-site-name.netlify.app` with the actual Netlify subdomain for the deployed site. Do not delete MX, SPF, DKIM, DMARC, or Microsoft/Google email records unless you intend to change email service too.

7. Back in Netlify, check **Domain management** until DNS verification passes.
8. Set the preferred primary domain. If GoDaddy remains your DNS provider, Netlify recommends using the `www` subdomain as the primary domain.
9. Wait for HTTPS to finish provisioning. DNS can update quickly, but global propagation can take up to 48 hours.

## Environment Variables

Set these in Netlify's environment variable UI, CLI, or API. Do not put the real webhook URL in `netlify.toml`; Netlify does not expose `netlify.toml` variables to Functions at runtime.

- `POWER_AUTOMATE_WEBHOOK_URL` - required. The Power Automate HTTP trigger URL.
- `MAX_UPLOAD_BYTES` - optional. Defaults to `15728640` bytes.
- `MAX_JSON_BODY_BYTES` - optional. Defaults to `31457280` bytes.
- `POWER_AUTOMATE_TIMEOUT_MS` - optional. Defaults to `20000`.
- `INCLUDE_TEMPLATE_BASE64` - optional. Set to `true` to include the automation template as base64 in each online submission payload.

## Local Setup

For a quick local test without typing commands, double-click:

```text
Start_Local_Site.command
```

It starts the local backend, opens `http://localhost:3000/`, and keeps the server running while that window stays open. The first run creates `.env` from `.env.example`; add `POWER_AUTOMATE_WEBHOOK_URL` there before testing real submissions.

For a command-line local test without Netlify CLI:

1. Copy `.env.example` to `.env`.
2. Set `POWER_AUTOMATE_WEBHOOK_URL`.
3. Run:

```bash
node server.js
```

4. Open `http://localhost:3000`.

The local server mirrors the Netlify endpoints and serves the same `public/index.html` page.

## Online Form Payload

Online submissions include all form fields, `caseTypes`, `children`, `childrenText`, `signatureMethod`, optional `typedSignature`, and `signature` as a PNG data URL. Drawn and typed signatures both use the same `signature` image field. The backend recomputes these output names:

- `generatedDocxFileName`
- `generatedPdfFileName`
- `clientNameForFile`
- `matterTypeForFile`

The Power Automate payload also includes:

```json
{
  "submissionType": "online_form",
  "documentGeneration": {
    "action": "create_docx_and_pdf",
    "templateFileName": "ClientIntakeForm_Automation_Template.docx",
    "outputDocxFileName": "Jane_Client_Estate_Planning_Completed_Form.docx",
    "outputPdfFileName": "Jane_Client_Estate_Planning_Completed_Form.pdf",
    "templateData": {}
  }
}
```

Use `documentGeneration.templateData` to populate the Word template. Then save the DOCX using `outputDocxFileName`, convert it to PDF, and save the PDF using `outputPdfFileName`.

If `INCLUDE_TEMPLATE_BASE64=true`, the function also adds `documentGeneration.template.contentBase64`.

## Manual Upload Payload

Manual upload asks for client name and matter type before accepting a drag-and-drop `.docx` or `.pdf`. The backend validates the file extension and file signature, then forwards:

```json
{
  "submissionType": "manual_upload",
  "clientName": "Jane Client",
  "matterType": "Estate Planning",
  "normalizedUploadedFileName": "Jane_Client_Estate_Planning_Completed_Form.pdf",
  "file": {
    "fileName": "Jane_Client_Estate_Planning_Completed_Form.pdf",
    "originalFileName": "finished-intake.pdf",
    "contentType": "application/pdf",
    "size": 12345,
    "contentBase64": "..."
  }
}
```

In Power Automate, create a file from `base64ToBinary(triggerBody()?['file']?['contentBase64'])` and use `triggerBody()?['file']?['fileName']` as the destination name.

## Power Automate Flow

Create one flow with an HTTP trigger and branch on `submissionType`.

For `online_form`:

1. Read `documentGeneration.templateData`.
2. Populate `ClientIntakeForm_Automation_Template.docx` with fields such as `clientName`, `caseTypesText`, `childrenText`, `mainLegalIssue`, `signature`, and `signatureDate`.
3. Save the completed DOCX as `documentGeneration.outputDocxFileName`.
4. Convert the DOCX to PDF.
5. Save the PDF as `documentGeneration.outputPdfFileName`.

For `manual_upload`:

1. Read `file.contentBase64`.
2. Convert it with `base64ToBinary(...)`.
3. Save it as `file.fileName`.
4. Route or copy it to the same SharePoint/OneDrive destination as online submissions.
