const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  getDecryptedRefreshToken,
  updateGoogleDriveTokenStatus,
  migrateFromEnvIfEmpty
} = require('./googleDriveTokenManager');

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedRefreshToken = null;
let cachedRefreshTokenExpiresAt = 0;

/**
 * Reset cached token (used in tests or key rotation)
 */
function resetGoogleTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
  cachedRefreshToken = null;
  cachedRefreshTokenExpiresAt = 0;
}

/**
 * Obtain Google OAuth2 Access Token
 * Supports:
 * 1. Supabase-Stored Encrypted Refresh Token (AES-256-GCM) with client credentials (Primary for personal Drive storage quota)
 * 2. In-memory caching for both access token and refresh token to eliminate database latency
 * 3. Google Service Account Fallback (for Google Workspace Shared Drives)
 */
async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  // 1. Supabase Encrypted OAuth2 Refresh Token (Primary for Google Drive personal storage quota)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (clientId && clientSecret) {
    let refreshToken = cachedRefreshToken;

    if (!refreshToken || cachedRefreshTokenExpiresAt <= now) {
      try {
        let tokenData = await getDecryptedRefreshToken();

        // Check for safe one-time migration if Supabase table is empty
        if (!tokenData) {
          const migrationRes = await migrateFromEnvIfEmpty();
          if (migrationRes && migrationRes.migrated) {
            tokenData = await getDecryptedRefreshToken();
          }
        }

        if (tokenData && tokenData.refreshToken) {
          refreshToken = tokenData.refreshToken;
          cachedRefreshToken = refreshToken;
          cachedRefreshTokenExpiresAt = now + (15 * 60 * 1000); // In-memory cache for 15 minutes
        }
      } catch (dbErr) {
        console.warn('Could not retrieve OAuth token from Supabase:', dbErr.message);
      }
    }

    if (refreshToken) {
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

      const tokenDataJson = await tokenRes.json();
      if (!tokenRes.ok || !tokenDataJson.access_token) {
        cachedRefreshToken = null;
        const errDesc = tokenDataJson.error_description || tokenDataJson.error || tokenRes.statusText;
        const isInvalidGrant = tokenDataJson.error === 'invalid_grant' || (errDesc && errDesc.includes('invalid_grant'));
        if (isInvalidGrant) {
          await updateGoogleDriveTokenStatus({
            status: 'reconnection_required',
            lastError: `Google authorization has expired or was revoked (invalid_grant): ${errDesc}`
          });
          console.warn('OAuth refresh token expired (invalid_grant), falling back to Service Account if available...');
        } else {
          console.warn(`Google OAuth auth failed (${errDesc}), falling back to Service Account if available...`);
        }
      } else {
        cachedToken = tokenDataJson.access_token;
        tokenExpiresAt = now + (tokenDataJson.expires_in || 3600) * 1000;
        return cachedToken;
      }
    }
  }

  // 2. Google Service Account Fallback (Recommended for Google Workspace Shared Drives)
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

  // Auto-detect service account credentials file if environment variables are not directly set
  if (!serviceEmail || !privateKey) {
    const candidateFiles = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      path.join(process.cwd(), 'google-service-account.json'),
      path.join(process.cwd(), 'service-account.json'),
      path.join(process.cwd(), 'credentials.json')
    ].filter(Boolean);

    for (const filePath of candidateFiles) {
      try {
        if (fs.existsSync(filePath)) {
          const sa = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (sa.client_email && sa.private_key) {
            serviceEmail = sa.client_email;
            privateKey = sa.private_key;
            break;
          }
        }
      } catch (e) {
        // continue search
      }
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

  throw new Error('Google Drive credentials not configured. Please connect Google Drive in the Admin Dashboard or configure your credentials.');
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

  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true';
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
