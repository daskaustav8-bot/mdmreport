const { pool } = require('../db/supabase');
const { encryptToken, decryptToken } = require('./cryptoService');

const DEFAULT_TESTING_EXPIRY_DAYS = 7;

/**
 * Resilient query executor with automatic retry for Supabase cloud transaction poolers
 */
async function executeQuery(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    const isNetworkErr = err.message && (
      err.message.includes('Connection terminated') ||
      err.message.includes('socket disconnected') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('client network socket')
    );
    if (isNetworkErr) {
      await new Promise(r => setTimeout(r, 300));
      return await pool.query(text, params);
    }
    throw err;
  }
}

/**
 * Format milliseconds remaining into human-readable "Xd Xh Xm Xs"
 */
function formatTimeRemaining(ms) {
  if (ms <= 0) return 'Expired';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Determine dynamic status based on record timestamps and error states
 */
function computeStatus(record) {
  if (!record) return 'not_configured';
  if (record.status === 'reconnection_required') return 'reconnection_required';

  if (record.expires_at) {
    const now = Date.now();
    const expiryTime = new Date(record.expires_at).getTime();
    const msRemaining = expiryTime - now;

    if (msRemaining <= 0) {
      return 'expired';
    }
    // Expiring soon if less than 24 hours remaining
    if (msRemaining <= 24 * 60 * 60 * 1000) {
      return 'expiring_soon';
    }
  }

  return record.status || 'connected';
}

/**
 * Fetch raw Google Drive OAuth token record from Supabase
 */
async function getGoogleDriveTokenRecord() {
  try {
    const query = `
      SELECT id, provider, account_email, encrypted_refresh_token, token_iv, token_auth_tag,
             issued_at, expires_at, is_testing_mode, status, last_verified_at, last_error,
             created_at, updated_at
      FROM public.google_drive_oauth_tokens
      WHERE provider = 'google'
      LIMIT 1;
    `;
    const { rows } = await executeQuery(query);
    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error('Error querying google_drive_oauth_tokens:', err.message);
    throw err;
  }
}

/**
 * Retrieve decrypted refresh token from Supabase.
 * Never logs or exposes the plaintext or ciphertext.
 *
 * @returns {Promise<{ refreshToken: string, record: Object } | null>}
 */
async function getDecryptedRefreshToken() {
  const record = await getGoogleDriveTokenRecord();
  if (!record || !record.encrypted_refresh_token) {
    return null;
  }

  try {
    const plaintext = decryptToken(
      record.encrypted_refresh_token,
      record.token_iv,
      record.token_auth_tag
    );
    return {
      refreshToken: plaintext,
      record: record
    };
  } catch (err) {
    console.error('Failed to decrypt Google Drive refresh token:', err.message);
    throw new Error('Google Drive token decryption failed. Encryption key may have changed.');
  }
}

/**
 * Save / Update Google Drive refresh token in Supabase.
 * Encrypts with AES-256-GCM.
 *
 * @param {Object} options
 * @param {string} options.refreshToken Plaintext refresh token to encrypt and store
 * @param {string} [options.accountEmail] Connected Google account email
 * @param {boolean} [options.isTestingMode=true] Whether subject to 7-day testing expiry
 * @param {Date} [options.issuedAt=new Date()] Token issuance timestamp
 * @param {Date} [options.expiresAt] Explicit expiry date if provided by Google
 */
async function saveGoogleDriveToken({ refreshToken, accountEmail, isTestingMode = true, issuedAt, expiresAt }) {
  if (!refreshToken) {
    throw new Error('Cannot save empty Google Drive refresh token');
  }

  const { encryptedData, iv, authTag } = encryptToken(refreshToken);
  const now = issuedAt || new Date();

  // If in Testing mode and no explicit expiry, set to 7 days from issuedAt
  let computedExpiresAt = expiresAt;
  if (!computedExpiresAt && isTestingMode) {
    computedExpiresAt = new Date(now.getTime() + DEFAULT_TESTING_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  }

  const query = `
    INSERT INTO public.google_drive_oauth_tokens (
      provider, account_email, encrypted_refresh_token, token_iv, token_auth_tag,
      issued_at, expires_at, is_testing_mode, status, last_verified_at, last_error, updated_at
    ) VALUES (
      'google', $1, $2, $3, $4,
      $5, $6, $7, 'connected', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
    )
    ON CONFLICT (provider) DO UPDATE SET
      account_email = COALESCE(EXCLUDED.account_email, public.google_drive_oauth_tokens.account_email),
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      token_iv = EXCLUDED.token_iv,
      token_auth_tag = EXCLUDED.token_auth_tag,
      issued_at = EXCLUDED.issued_at,
      expires_at = EXCLUDED.expires_at,
      is_testing_mode = EXCLUDED.is_testing_mode,
      status = 'connected',
      last_verified_at = CURRENT_TIMESTAMP,
      last_error = NULL,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, provider, account_email, issued_at, expires_at, is_testing_mode, status, last_verified_at;
  `;

  const values = [
    accountEmail || null,
    encryptedData,
    iv,
    authTag,
    now.toISOString(),
    computedExpiresAt ? computedExpiresAt.toISOString() : null,
    Boolean(isTestingMode)
  ];

  const { rows } = await executeQuery(query, values);
  return rows[0];
}

/**
 * Update token status, error message, or verification timestamp
 */
async function updateGoogleDriveTokenStatus({ status, lastError, lastVerifiedAt }) {
  const sets = [];
  const params = [];
  let paramIdx = 1;

  if (status !== undefined) {
    sets.push(`status = $${paramIdx++}`);
    params.push(status);
  }
  if (lastError !== undefined) {
    sets.push(`last_error = $${paramIdx++}`);
    params.push(lastError);
  }
  if (lastVerifiedAt !== undefined) {
    sets.push(`last_verified_at = $${paramIdx++}`);
    params.push(lastVerifiedAt ? new Date(lastVerifiedAt).toISOString() : new Date().toISOString());
  }
  sets.push(`updated_at = CURRENT_TIMESTAMP`);

  if (sets.length === 1) return; // Only updated_at

  const query = `
    UPDATE public.google_drive_oauth_tokens
    SET ${sets.join(', ')}
    WHERE provider = 'google';
  `;

  await executeQuery(query, params);
}

/**
 * Get safe metadata for admin dashboard display.
 * Strictly avoids exposing plaintext tokens, ciphertext, iv, or authTag.
 */
async function getSafeGoogleDriveStatus() {
  const record = await getGoogleDriveTokenRecord();
  if (!record) {
    return {
      has_token: false,
      connection_status: 'not_configured',
      account_email: null,
      issued_at: null,
      expires_at: null,
      time_remaining_ms: 0,
      time_remaining_formatted: 'Not Configured',
      last_verified_at: null,
      last_error: null,
      is_testing_mode: true,
      folder_id: process.env.GOOGLE_DRIVE_FOLDER_ID || null
    };
  }

  const effectiveStatus = computeStatus(record);
  let timeRemainingMs = 0;
  if (record.expires_at) {
    timeRemainingMs = Math.max(0, new Date(record.expires_at).getTime() - Date.now());
  }

  return {
    has_token: true,
    connection_status: effectiveStatus,
    account_email: record.account_email || 'dasarnima94@gmail.com',
    issued_at: record.issued_at ? new Date(record.issued_at).toISOString() : null,
    expires_at: record.expires_at ? new Date(record.expires_at).toISOString() : null,
    time_remaining_ms: timeRemainingMs,
    time_remaining_formatted: formatTimeRemaining(timeRemainingMs),
    last_verified_at: record.last_verified_at ? new Date(record.last_verified_at).toISOString() : null,
    last_error: record.last_error || null,
    is_testing_mode: Boolean(record.is_testing_mode),
    folder_id: process.env.GOOGLE_DRIVE_FOLDER_ID || null
  };
}

/**
 * Verify Google Drive connection using Supabase-stored refresh token.
 * Refreshes an access token and checks folder access, updating last_verified_at.
 */
async function verifyGoogleDriveConnection() {
  const tokenData = await getDecryptedRefreshToken();
  if (!tokenData || !tokenData.refreshToken) {
    return {
      success: false,
      connection_status: 'not_configured',
      message: 'No Google Drive refresh token stored in Supabase. Please connect Google Drive first.'
    };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!clientId || !clientSecret) {
    return {
      success: false,
      connection_status: 'error',
      message: 'Server missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables.'
    };
  }

  // 1. Request access token from Google
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenData.refreshToken,
        grant_type: 'refresh_token'
      })
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok || !tokenJson.access_token) {
      const errorMsg = tokenJson.error_description || tokenJson.error || 'Authentication failed';
      console.error('Google OAuth token verification failed:', errorMsg);

      // Handle invalid_grant / revoked token
      const isInvalidGrant = tokenJson.error === 'invalid_grant' || (errorMsg && errorMsg.includes('invalid_grant'));
      const newStatus = isInvalidGrant ? 'reconnection_required' : 'reconnection_required';

      await updateGoogleDriveTokenStatus({
        status: newStatus,
        lastError: `Google authentication failed: ${errorMsg}`
      });

      return {
        success: false,
        connection_status: newStatus,
        message: isInvalidGrant
          ? 'Google authorization has expired or was revoked (invalid_grant). Reconnection is required.'
          : `Google Drive verification error: ${errorMsg}`
      };
    }

    const accessToken = tokenJson.access_token;

    // 2. Verify Google Drive Folder access
    let folderInfo = null;
    if (folderId) {
      const folderRes = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,capabilities&supportsAllDrives=true`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (folderRes.ok) {
        folderInfo = await folderRes.json();
      }
    }

    // 3. Update Supabase record as verified
    const record = tokenData.record;
    const effectiveStatus = computeStatus({ ...record, status: 'connected' });
    const now = new Date();

    await updateGoogleDriveTokenStatus({
      status: effectiveStatus,
      lastError: null,
      lastVerifiedAt: now
    });

    return {
      success: true,
      connection_status: effectiveStatus,
      message: 'Google Drive connection verified successfully.',
      account_email: record.account_email || 'dasarnima94@gmail.com',
      folder_name: folderInfo?.name || 'Bank Passbook Imgs',
      can_upload: Boolean(folderInfo?.capabilities?.canAddChildren),
      last_verified_at: now.toISOString()
    };
  } catch (netErr) {
    console.error('Network error during Google Drive verification:', netErr.message);
    await updateGoogleDriveTokenStatus({
      lastError: `Network error verifying connection: ${netErr.message}`
    });
    return {
      success: false,
      connection_status: 'error',
      message: `Network error verifying Google Drive: ${netErr.message}`
    };
  }
}

/**
 * Safe one-time migration: If public.google_drive_oauth_tokens is empty and
 * GOOGLE_REFRESH_TOKEN exists in process.env, encrypt and insert into Supabase.
 */
async function migrateFromEnvIfEmpty() {
  try {
    const existing = await getGoogleDriveTokenRecord();
    if (existing) {
      return { migrated: false, reason: 'Supabase already contains a token' };
    }

    const envToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!envToken) {
      return { migrated: false, reason: 'No GOOGLE_REFRESH_TOKEN in environment' };
    }

    console.log('[Google Drive Migration] One-time migration: Encrypting and saving GOOGLE_REFRESH_TOKEN to Supabase...');
    const saved = await saveGoogleDriveToken({
      refreshToken: envToken,
      accountEmail: 'dasarnima94@gmail.com',
      isTestingMode: true,
      issuedAt: new Date()
    });

    console.log('[Google Drive Migration] Successfully migrated refresh token to Supabase (Record ID:', saved.id, ')');
    return { migrated: true, recordId: saved.id };
  } catch (err) {
    console.error('[Google Drive Migration] Error during one-time migration:', err.message);
    return { migrated: false, error: err.message };
  }
}

module.exports = {
  getGoogleDriveTokenRecord,
  getDecryptedRefreshToken,
  saveGoogleDriveToken,
  updateGoogleDriveTokenStatus,
  getSafeGoogleDriveStatus,
  verifyGoogleDriveConnection,
  migrateFromEnvIfEmpty,
  formatTimeRemaining,
  computeStatus
};
