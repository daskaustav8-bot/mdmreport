/**
 * =========================================================================
 * GOOGLE APPS SCRIPT: BANK PASSBOOK PHOTO DRIVE UPLOADER (STANDALONE WEB APP)
 * =========================================================================
 *
 * This script securely receives Bank Passbook photos from your PM POSHAN 
 * Monthly Report system and stores them inside your private Google Drive folder.
 *
 * SCRIPT PROPERTIES CONFIGURATION (Project Settings > Script Properties):
 * -------------------------------------------------------------------------
 * Key: FOLDER_ID     -> The Google Drive Folder ID where photos will be stored.
 * Key: UPLOAD_TOKEN  -> A secure secret passphrase shared between this script
 *                       and your backend server (e.g. random 32-character string).
 *
 * DEPLOYMENT INSTRUCTIONS:
 * -------------------------------------------------------------------------
 * 1. Open Google Drive (https://drive.google.com).
 * 2. Create a new private folder (e.g., "MDM_Passbook_Photos").
 * 3. Open the folder and copy its Folder ID from the browser address bar:
 *    https://drive.google.com/drive/folders/<FOLDER_ID_IS_HERE>
 * 4. Go to Google Apps Script (https://script.google.com) and click "New project".
 * 5. Replace any code in Code.gs with this entire script.
 * 6. In the left sidebar, click the gear icon (Project Settings).
 * 7. Scroll to "Script Properties" and click "Add script property":
 *    - FOLDER_ID     : Paste your Google Drive Folder ID from step 3.
 *    - UPLOAD_TOKEN  : Enter a strong random secret token.
 * 8. Click "Save script properties".
 * 9. In the top right, click "Deploy" > "New deployment".
 * 10. Click the gear icon next to "Select type" and choose "Web app".
 * 11. Configure the deployment:
 *     - Description : MDM Passbook Photo Uploader
 *     - Execute as  : Me (<your-google-account>)
 *     - Who has access: Anyone (security is strictly enforced by UPLOAD_TOKEN)
 * 12. Click "Deploy", review permissions, and grant access to your Google account.
 * 13. Copy the "Web app URL" (ends in /exec).
 * 14. Add the URL and Token to your .env / Vercel Environment Variables:
 *     GOOGLE_DRIVE_WEBAPP_URL=https://script.google.com/macros/s/.../exec
 *     GOOGLE_DRIVE_UPLOAD_TOKEN=<your-token-from-step-7>
 * =========================================================================
 */

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Acquire script lock with a 30-second timeout to handle concurrent uploads safely
    lock.waitLock(30000);
  } catch (lockErr) {
    return jsonResponse({
      status: 'error',
      message: 'Server is busy processing other uploads. Please try again in a moment.'
    }, 429);
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({
        status: 'error',
        message: 'No payload received in request.'
      }, 400);
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse({
        status: 'error',
        message: 'Invalid JSON payload: ' + parseErr.message
      }, 400);
    }

    // 1. Authenticate with Shared Token
    var scriptProperties = PropertiesService.getScriptProperties();
    var expectedToken = scriptProperties.getProperty('UPLOAD_TOKEN');
    var receivedToken = payload.token || '';

    if (expectedToken && receivedToken !== expectedToken) {
      return jsonResponse({
        status: 'error',
        message: 'Unauthorized: Invalid or missing upload token.'
      }, 401);
    }

    // 2. Validate Google Drive Destination Folder
    var folderId = scriptProperties.getProperty('FOLDER_ID') || payload.folderId;
    if (!folderId) {
      return jsonResponse({
        status: 'error',
        message: 'Destination Google Drive Folder ID is not configured in Script Properties.'
      }, 500);
    }

    var folder;
    try {
      folder = DriveApp.getFolderById(folderId);
    } catch (folderErr) {
      return jsonResponse({
        status: 'error',
        message: 'Configured Google Drive folder could not be found or accessed: ' + folderErr.message
      }, 404);
    }

    // 3. Extract & Validate Image Data
    var base64Data = payload.fileBase64;
    var rawMimeType = (payload.mimeType || 'image/jpeg').toLowerCase();
    var originalName = payload.fileName || 'passbook.jpg';
    var udise = String(payload.udise || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
    var month = String(payload.month || 'month').replace(/[^a-zA-Z0-9_-]/g, '');
    var year = String(payload.year || 'year').replace(/[^a-zA-Z0-9_-]/g, '');
    var schoolName = String(payload.schoolName || 'School');

    // Strict MIME-type validation: only JPG, JPEG, PNG, WEBP
    var allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedMimes.indexOf(rawMimeType) === -1) {
      return jsonResponse({
        status: 'error',
        message: 'Invalid file format (' + rawMimeType + '). Only JPG, JPEG, PNG, and WebP images are allowed.'
      }, 400);
    }

    if (!base64Data || typeof base64Data !== 'string') {
      return jsonResponse({
        status: 'error',
        message: 'Missing image content data.'
      }, 400);
    }

    // Strip optional data URI prefix if present
    var cleanBase64 = base64Data.replace(/^data:[a-zA-Z0-9\/+-]+;base64,/, '');

    var decodedBytes;
    try {
      decodedBytes = Utilities.base64Decode(cleanBase64);
    } catch (decodeErr) {
      return jsonResponse({
        status: 'error',
        message: 'Base64 decoding failed: ' + decodeErr.message
      }, 400);
    }

    // Max file size: 10MB
    if (decodedBytes.length > 10 * 1024 * 1024) {
      return jsonResponse({
        status: 'error',
        message: 'File size exceeds the 10MB limit.'
      }, 400);
    }

    // Determine normalized extension
    var ext = 'jpg';
    if (rawMimeType === 'image/png') ext = 'png';
    else if (rawMimeType === 'image/webp') ext = 'webp';

    var timestamp = Utilities.formatDate(new Date(), 'GMT+05:30', 'yyyyMMdd_HHmmss');
    var sanitizedFileName = 'Passbook_' + udise + '_' + month + '_' + year + '_' + timestamp + '.' + ext;

    var blob = Utilities.newBlob(decodedBytes, rawMimeType, sanitizedFileName);

    // 4. Create File in Private Destination Folder
    var file = folder.createFile(blob);

    // Enforce private permissions: DO NOT make the file or folder public
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);

    // Attach metadata description for traceability in Google Drive
    file.setDescription(
      'PM POSHAN Bank Passbook Photo\n' +
      'UDISE Code: ' + udise + '\n' +
      'School Name: ' + schoolName + '\n' +
      'Reporting Period: ' + month + ' ' + year + '\n' +
      'Original File: ' + originalName + '\n' +
      'File Size: ' + (decodedBytes.length / 1024).toFixed(1) + ' KB\n' +
      'Uploaded At: ' + new Date().toISOString()
    );

    var fileId = file.getId();
    var fileUrl = file.getUrl();
    var viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';

    return jsonResponse({
      status: 'success',
      message: 'Bank passbook photo uploaded to Google Drive successfully.',
      fileId: fileId,
      fileName: sanitizedFileName,
      fileUrl: fileUrl,
      viewUrl: viewUrl
    }, 200);

  } catch (err) {
    return jsonResponse({
      status: 'error',
      message: 'Upload failed: ' + err.toString()
    }, 500);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Health check / diagnostic endpoint
 */
function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var isFolderConfigured = !!props.getProperty('FOLDER_ID');
  var isTokenConfigured = !!props.getProperty('UPLOAD_TOKEN');

  return jsonResponse({
    status: 'ok',
    service: 'PM POSHAN Bank Passbook Drive Uploader',
    folderConfigured: isFolderConfigured,
    tokenConfigured: isTokenConfigured,
    timestamp: new Date().toISOString()
  }, 200);
}

function jsonResponse(data, statusCode) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
