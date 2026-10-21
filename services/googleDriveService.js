const jwt = require('jsonwebtoken');

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Reset cached token (used in tests or key rotation)
 */
function resetGoogleTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Obtain Google OAuth2 Access Token
 * Supports:
 * 1. Google Service Account (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_JSON)
 * 2. Google OAuth2 Refresh Token (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN)
 */
async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  // 1. Google Service Account (No user login prompt needed)
  let serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      serviceEmail = sa.client_email || serviceEmail;
      privateKey = sa.private_key || privateKey;
    } catch (e) {
      console.warn('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
    }
  }

  if (serviceEmail && privateKey) {
    // Normalize newlines in private key
    const formattedKey = privateKey.replace(/\\n/g, '\n');

    const nowUnix = Math.floor(now / 1000);
    const jwtPayload = {
      iss: serviceEmail,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      exp: nowUnix + 3600,
      iat: nowUnix
    };

    const signedJwt = jwt.sign(jwtPayload, formattedKey, { algorithm: 'RS256' });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(`Google Service Account auth failed: ${tokenData.error_description || tokenData.error || tokenRes.statusText}`);
    }

    cachedToken = tokenData.access_token;
    tokenExpiresAt = now + (tokenData.expires_in || 3600) * 1000;
    return cachedToken;
  }

  // 2. Google OAuth2 Client Refresh Token
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(`Google OAuth auth failed: ${tokenData.error_description || tokenData.error || tokenRes.statusText}`);
    }

    cachedToken = tokenData.access_token;
    tokenExpiresAt = now + (tokenData.expires_in || 3600) * 1000;
    return cachedToken;
  }

  throw new Error('Google Drive credentials not configured. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_KEY (and GOOGLE_DRIVE_FOLDER_ID) in your environment variables.');
}

/**
 * Upload a file directly to Google Drive API v3 (Zero Google Apps Script required)
 * Uses standard multipart/related upload.
 *
 * @param {Object} options
 * @param {Buffer} options.buffer File bytes buffer
 * @param {string} options.mimeType Image MIME type ('image/jpeg', 'image/png', 'image/webp')
 * @param {string} options.fileName Output filename in Google Drive
 * @param {string} [options.folderId] Google Drive folder ID
 * @param {string} [options.description] Metadata description
 * @returns {Promise<{fileId: string, fileName: string, fileUrl: string, viewUrl: string}>}
 */
async function uploadToGoogleDriveDirect({ buffer, mimeType, fileName, folderId, description }) {
  const accessToken = await getGoogleAccessToken();
  const targetFolderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!targetFolderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured. Please specify the target Google Drive folder ID in your environment variables.');
  }

  const metadata = {
    name: fileName,
    parents: [targetFolderId],
    description: description || 'Bank Passbook Photo'
  };

  const boundary = '-------MDM_DRIVE_BOUNDARY_' + Date.now().toString(36);
  const delimiter = '\r\n--' + boundary + '\r\n';
  const closeDelimiter = '\r\n--' + boundary + '--';

  const metadataPart = delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const payloadBuffer = Buffer.concat([
    Buffer.from(metadataPart, 'utf8'),
    buffer,
    Buffer.from(closeDelimiter, 'utf8')
  ]);

  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(payloadBuffer.length)
    },
    body: payloadBuffer
  });

  const uploadJson = await uploadRes.json();
  if (!uploadRes.ok || !uploadJson.id) {
    throw new Error(`Google Drive API rejected file: ${uploadJson.error?.message || uploadRes.statusText}`);
  }

  const fileId = uploadJson.id;
  const viewUrl = uploadJson.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  return {
    fileId: fileId,
    fileName: uploadJson.name || fileName,
    fileUrl: viewUrl,
    viewUrl: viewUrl
  };
}

module.exports = {
  getGoogleAccessToken,
  uploadToGoogleDriveDirect,
  resetGoogleTokenCache
};
