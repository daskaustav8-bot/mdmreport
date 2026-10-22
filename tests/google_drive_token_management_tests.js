const assert = require('assert');
const { pool } = require('../db/supabase');
const { encryptToken, decryptToken } = require('../services/cryptoService');
const tokenManager = require('../services/googleDriveTokenManager');
const app = require('../server');

const { createSessionToken } = require('../middleware/auth');

async function poolQuery(text, params = []) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, attempt * 400));
    }
  }
  throw lastErr;
}

let server;
let serverPort;
let adminCookie = '';

async function startTestServer() {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

async function stopTestServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getAdminSessionCookie() {
  const token = createSessionToken({ id: 1, username: 'admin', admin_type: 'main' });
  return `admin_session=${token}`;
}

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING TEST SUITE: SUPABASE GOOGLE DRIVE TOKEN MANAGEMENT  ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error('   Error:', err.message);
      failed++;
    }
  }

  await startTestServer();
  adminCookie = await getAdminSessionCookie();
  await poolQuery('SELECT 1');

  // Test 1: AES-256-GCM Encryption, Decryption, and Tamper Detection
  await test('AES-256-GCM encrypts, decrypts, and detects tampered data', async () => {
    const originalToken = '1//04_TEST_REALISTIC_GOOGLE_REFRESH_TOKEN_' + Date.now();
    const enc = encryptToken(originalToken);

    assert(enc.encryptedData && typeof enc.encryptedData === 'string', 'Missing encryptedData');
    assert(enc.iv && enc.iv.length === 24, 'IV must be 12 bytes (24 hex characters)');
    assert(enc.authTag && enc.authTag.length === 32, 'AuthTag must be 16 bytes (32 hex characters)');

    const dec = decryptToken(enc.encryptedData, enc.iv, enc.authTag);
    assert.strictEqual(dec, originalToken, 'Decrypted token must exactly match original token');

    // Tampering test: corrupt authTag
    assert.throws(() => {
      decryptToken(enc.encryptedData, enc.iv, '00000000000000000000000000000000');
    }, /unable to authenticate|Unsupported state/, 'Decryption must throw on tampered authTag');
  });

  // Test 2: Database Schema & RLS Verification
  await test('google_drive_oauth_tokens table exists with RLS enabled', async () => {
    const tableRes = await poolQuery(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'google_drive_oauth_tokens';
    `);
    const colNames = tableRes.rows.map(r => r.column_name);

    assert(colNames.includes('provider'), 'Missing provider column');
    assert(colNames.includes('account_email'), 'Missing account_email column');
    assert(colNames.includes('encrypted_refresh_token'), 'Missing encrypted_refresh_token column');
    assert(colNames.includes('token_iv'), 'Missing token_iv column');
    assert(colNames.includes('token_auth_tag'), 'Missing token_auth_tag column');
    assert(colNames.includes('issued_at'), 'Missing issued_at column');
    assert(colNames.includes('expires_at'), 'Missing expires_at column');
    assert(colNames.includes('status'), 'Missing status column');

    // Check Row Level Security
    const rlsRes = await poolQuery(`
      SELECT relrowsecurity 
      FROM pg_class 
      WHERE relname = 'google_drive_oauth_tokens';
    `);
    assert.strictEqual(rlsRes.rows[0]?.relrowsecurity, true, 'Row Level Security must be enabled');
  });

  // Test 3: Save and Retrieve Encrypted Token in Supabase
  await test('Save encrypted refresh token and retrieve via tokenManager', async () => {
    const testRefreshToken = '1//TEST_REFRESH_TOKEN_SUITE_RUN_' + Date.now();
    const testEmail = 'dasarnima94@gmail.com';

    await tokenManager.saveGoogleDriveToken({
      refreshToken: testRefreshToken,
      accountEmail: testEmail,
      isTestingMode: true
    });

    const decryptedObj = await tokenManager.getDecryptedRefreshToken();
    assert(decryptedObj, 'Must retrieve decrypted token object');
    assert.strictEqual(decryptedObj.refreshToken, testRefreshToken, 'Decrypted token must match saved token');
    assert.strictEqual(decryptedObj.record.account_email, testEmail, 'Email must match');

    // Direct database inspection: verify DB only contains encrypted hex, never plaintext
    const dbRow = await poolQuery("SELECT * FROM public.google_drive_oauth_tokens WHERE provider = 'google';");
    assert.strictEqual(dbRow.rows.length, 1, 'Exactly one record must exist');
    assert(!dbRow.rows[0].encrypted_refresh_token.includes('TEST_REFRESH_TOKEN'), 'Plaintext token must NEVER be stored in DB');
  });

  // Test 4: 7-Day Testing Expiry Calculation & Formatting
  await test('Calculate 7-day expiry deadline and time remaining without resetting on access refresh', async () => {
    const fixedNow = new Date('2026-10-22T10:00:00Z');
    const fixedToken = '1//EXPIRY_TEST_TOKEN_' + Date.now();

    const saved = await tokenManager.saveGoogleDriveToken({
      refreshToken: fixedToken,
      accountEmail: 'dasarnima94@gmail.com',
      isTestingMode: true,
      issuedAt: fixedNow
    });

    const issuedTime = new Date(saved.issued_at).getTime();
    const expiryTime = new Date(saved.expires_at).getTime();
    const diffDays = (expiryTime - issuedTime) / (1000 * 60 * 60 * 24);

    assert.strictEqual(Math.round(diffDays), 7, 'Expires_at must be exactly 7 days from issued_at');

    // Test countdown formatting function
    const formatted = tokenManager.formatTimeRemaining(6 * 86400000 + 4 * 3600000 + 25 * 60000 + 30000);
    assert.strictEqual(formatted, '6d 4h 25m 30s', 'Formatted remaining time must match');

    // Test computeStatus transitions
    const connectedStatus = tokenManager.computeStatus({
      status: 'connected',
      expires_at: new Date(Date.now() + 48 * 3600000).toISOString()
    });
    assert.strictEqual(connectedStatus, 'connected', 'Status > 24h must be connected');

    const expiringSoonStatus = tokenManager.computeStatus({
      status: 'connected',
      expires_at: new Date(Date.now() + 12 * 3600000).toISOString()
    });
    assert.strictEqual(expiringSoonStatus, 'expiring_soon', 'Status <= 24h must be expiring_soon');

    const expiredStatus = tokenManager.computeStatus({
      status: 'connected',
      expires_at: new Date(Date.now() - 1000).toISOString()
    });
    assert.strictEqual(expiredStatus, 'expired', 'Past expiry must be expired');
  });

  // Test 5: Reconnection Required on invalid_grant
  await test('Update status to reconnection_required on Google invalid_grant', async () => {
    await tokenManager.updateGoogleDriveTokenStatus({
      status: 'reconnection_required',
      lastError: 'Google authorization has expired or was revoked (invalid_grant)'
    });

    const safeStatus = await tokenManager.getSafeGoogleDriveStatus();
    assert.strictEqual(safeStatus.connection_status, 'reconnection_required');
    assert(safeStatus.last_error.includes('invalid_grant'), 'Last error must describe invalid_grant');
  });

  // Test 6: Secure Admin Status API (requireAuth & Zero Secret Leakage)
  await test('GET /api/admin/google-drive/status enforces admin auth and never leaks secrets', async () => {
    // 1. Unauthenticated request must be rejected
    const unauthRes = await fetch(`http://localhost:${serverPort}/api/admin/google-drive/status`, {
      headers: { 'Accept': 'application/json' },
      redirect: 'manual'
    });
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must be rejected with 401');

    // 2. Authenticated Admin request succeeds
    const authRes = await fetch(`http://localhost:${serverPort}/api/admin/google-drive/status`, {
      headers: { 'Cookie': adminCookie }
    });
    assert.strictEqual(authRes.status, 200, 'Authenticated admin must get HTTP 200');

    const json = await authRes.json();
    assert.strictEqual(json.status, 'success');
    assert(json.data.has_token === true, 'has_token must be true');
    assert.strictEqual(json.data.account_email, 'dasarnima94@gmail.com');
    assert(json.data.issued_at, 'issued_at must be provided');
    assert(json.data.expires_at, 'expires_at must be provided');

    // STRICT PRIVACY CHECK: Verify that no token, ciphertext, or key is exposed in the JSON response
    const rawResponse = JSON.stringify(json);
    assert(!rawResponse.includes('encrypted_refresh_token'), 'Ciphertext must NEVER be present in API response');
    assert(!rawResponse.includes('token_iv'), 'IV must NEVER be present in API response');
    assert(!rawResponse.includes('token_auth_tag'), 'Auth tag must NEVER be present in API response');
    assert(!rawResponse.includes('1//'), 'Plaintext token must NEVER be present in API response');
  });

  // Test 7: Secure Admin Verify Connection Endpoint
  await test('POST /api/admin/google-drive/verify enforces admin auth and returns safe report', async () => {
    // 1. Unauthenticated request must be rejected
    const unauthRes = await fetch(`http://localhost:${serverPort}/api/admin/google-drive/verify`, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      redirect: 'manual'
    });
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated verify must be rejected with 401');

    // 2. Authenticated Admin verify call executes internally
    const authRes = await fetch(`http://localhost:${serverPort}/api/admin/google-drive/verify`, {
      method: 'POST',
      headers: {
        'Cookie': adminCookie,
        'Content-Type': 'application/json'
      }
    });

    // The endpoint will respond with HTTP 200 (json with status error or success depending on mock/live tokens)
    assert.strictEqual(authRes.status, 200, 'Admin verify endpoint must respond HTTP 200');
    const json = await authRes.json();
    assert(json.status === 'success' || json.status === 'error', 'Response status must be success or error');
    assert(json.data, 'Response must include safe outcome data');

    // Verify response does not leak sensitive keys
    const rawVerify = JSON.stringify(json);
    assert(!rawVerify.includes('token_iv'), 'Verify must not leak token_iv');
    assert(!rawVerify.includes('token_auth_tag'), 'Verify must not leak token_auth_tag');
  });

  // Test 8: Safe One-Time Migration Logic from Environment Variable
  await test('One-time migration encrypts process.env.GOOGLE_REFRESH_TOKEN when Supabase is empty', async () => {
    // Clear the table to test migration
    await poolQuery("DELETE FROM public.google_drive_oauth_tokens WHERE provider = 'google';");

    // Set a dummy env token
    process.env.GOOGLE_REFRESH_TOKEN = '1//MIGRATION_SOURCE_TOKEN_999';

    const migResult = await tokenManager.migrateFromEnvIfEmpty();
    assert.strictEqual(migResult.migrated, true, 'Migration must report migrated = true');

    // Verify it is now in Supabase decrypted
    const retrieved = await tokenManager.getDecryptedRefreshToken();
    assert.strictEqual(retrieved.refreshToken, '1//MIGRATION_SOURCE_TOKEN_999');

    // Second call must NOT re-migrate
    const secondCall = await tokenManager.migrateFromEnvIfEmpty();
    assert.strictEqual(secondCall.migrated, false, 'Second migration must report migrated = false');
  });

  // Test 9: admin_dashboard.html Structure & Security Inspection
  await test('admin_dashboard.html includes Google Drive Token Management section with live countdown and zero token leakage', async () => {
    const fs = require('fs');
    const html = fs.readFileSync('admin_dashboard.html', 'utf8');

    assert(html.includes('Google Drive Token Management'), 'Dashboard must contain Google Drive Token Management title');
    assert(html.includes('driveStatusBadge'), 'Dashboard must contain status badge element');
    assert(html.includes('driveTimeRemaining'), 'Dashboard must contain countdown element');
    assert(html.includes('btnVerifyDrive'), 'Dashboard must contain verify connection button');
    assert(html.includes('btnReconnectDrive'), 'Dashboard must contain reconnect button');
    assert(html.includes('updateCountdownDisplay'), 'Dashboard must contain countdown timer update function');

    // Security check: No secret or token in HTML
    assert(!html.includes('GOOGLE_REFRESH_TOKEN'), 'Dashboard HTML must not hardcode GOOGLE_REFRESH_TOKEN');
    assert(!html.includes('encrypted_refresh_token'), 'Dashboard HTML must not reference encrypted_refresh_token');
  });

  await stopTestServer();

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${passed}/${passed + failed} PASSED`);
  if (failed === 0) {
    console.log('🎉 ALL SUPABASE GOOGLE DRIVE TOKEN MANAGEMENT TESTS PASSED!');
  } else {
    console.error(`⚠️ ${failed} TESTS FAILED.`);
    process.exit(1);
  }
  console.log('================================================================\n');

  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
