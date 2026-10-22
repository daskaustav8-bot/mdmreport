/**
 * Test Suite: Bank Passbook Photo Upload to Direct Google Drive API (Zero Google Script) & Supabase Reference Storage
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
require('dotenv').config();
const { pool } = require('../db/supabase');
const app = require('../server');
const { resetGoogleTokenCache } = require('../services/googleDriveService');

let server;
let port;
let mockGoogleApiServer;
let mockGoogleApiPort;

// Generate test RSA Key Pair for Service Account JWT signature testing
const { privateKey: testPrivateKey, publicKey: testPublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Valid 1x1 PNG image buffer with genuine PNG header (magic bytes: 89 50 4E 47)
const VALID_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Fake text buffer claiming to be image
const FAKE_IMAGE_BUFFER = Buffer.from('This is a text file pretending to be an image', 'utf8');

function request(options, bodyBuffer = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function buildMultipart(fields, fileFieldName, fileName, fileMime, fileBuffer) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }

  if (fileFieldName && fileBuffer) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\nContent-Type: ${fileMime}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const fullBody = Buffer.concat(parts);
  return { boundary, body: fullBody };
}

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING TEST SUITE: DIRECT GOOGLE DRIVE API (NO GOOGLE SCRIPT)');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    return fn()
      .then(() => {
        passed++;
        console.log(`✅ PASS: ${name}`);
      })
      .catch((err) => {
        console.error(`❌ FAIL: ${name}`);
        console.error('   Error:', err.message);
      });
  }

  // 1. Start Express Server
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });

  // 2. Start Mock Google API Server (Handles OAuth2 token exchange & Drive v3 multipart upload)
  let lastDriveUploadReceived = false;
  let receivedParents = null;

  await new Promise((resolve) => {
    mockGoogleApiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        // Mock OAuth2 Token endpoint
        if (req.url === '/token') {
          return res.end(JSON.stringify({
            access_token: 'mock_google_oauth_token_12345',
            token_type: 'Bearer',
            expires_in: 3600
          }));
        }

        // Mock Google Drive API v3 Files upload endpoint
        if (req.url.startsWith('/upload/drive/v3/files')) {
          lastDriveUploadReceived = true;
          // Extract parents from multipart
          const match = body.match(/"parents":\s*\["([^"]+)"\]/);
          if (match) receivedParents = match[1];

          return res.end(JSON.stringify({
            id: 'direct_drive_file_id_555444',
            name: 'Passbook_19120500703_October_2026.png',
            webViewLink: 'https://drive.google.com/file/d/direct_drive_file_id_555444/view'
          }));
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
    });

    mockGoogleApiServer.listen(0, () => {
      mockGoogleApiPort = mockGoogleApiServer.address().port;
      resolve();
    });
  });

  const testUdise = '19120500703'; // Abadpara Primary School
  const testMonth = 'October';
  const testYear = '2026';

  try {
    // Test 1: Reject upload if no file is provided
    await test('Reject upload when no file is attached (400 Bad Request)', async () => {
      const { boundary, body } = buildMultipart({ u_dise: testUdise, month: testMonth, year: testYear }, null, null, null, null);
      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json?.status, 'error');
    });

    // Test 2: Reject upload when UDISE does not exist in master school list
    await test('Reject upload with forged or invalid school UDISE code (400 Bad Request)', async () => {
      const fakeUdise = '99999999999';
      const { boundary, body } = buildMultipart(
        { u_dise: fakeUdise, month: testMonth, year: testYear },
        'photo',
        'passbook.png',
        'image/png',
        VALID_PNG_BUFFER
      );
      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);
      assert.strictEqual(res.status, 400);
      assert(res.json?.message.includes('not found in master records'));
    });

    // Test 3: Reject disallowed file extensions / MIME types
    await test('Reject non-image file uploads such as PDF or text (400 Bad Request)', async () => {
      const { boundary, body } = buildMultipart(
        { u_dise: testUdise, month: testMonth, year: testYear },
        'photo',
        'passbook.pdf',
        'application/pdf',
        Buffer.from('%PDF-1.4 ... fake pdf content')
      );
      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);
      assert.strictEqual(res.status, 400);
      assert(res.json?.message.includes('Only JPG, JPEG, PNG, and WebP images are allowed'));
    });

    // Test 4: Reject corrupted or disguised files failing magic-bytes validation
    await test('Reject disguised files with invalid image magic bytes (400 Bad Request)', async () => {
      const { boundary, body } = buildMultipart(
        { u_dise: testUdise, month: testMonth, year: testYear },
        'photo',
        'passbook.jpg',
        'image/jpeg',
        FAKE_IMAGE_BUFFER
      );
      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);
      assert.strictEqual(res.status, 400);
      assert(res.json?.message.includes('Corrupted image file'));
    });

    // Test 5: Return 503 when Google Drive credentials are not set
    await test('Return 503 DRIVE_CONFIG_REQUIRED when credentials are completely missing', async () => {
      const origKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      const origEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const origGas = process.env.GOOGLE_DRIVE_WEBAPP_URL;
      const origClientId = process.env.GOOGLE_CLIENT_ID;
      const origClientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const origRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_DRIVE_WEBAPP_URL;
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REFRESH_TOKEN;

      const { boundary, body } = buildMultipart(
        { u_dise: testUdise, month: testMonth, year: testYear },
        'photo',
        'passbook.png',
        'image/png',
        VALID_PNG_BUFFER
      );
      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);

      process.env.GOOGLE_SERVICE_ACCOUNT_KEY = origKey;
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = origEmail;
      process.env.GOOGLE_DRIVE_WEBAPP_URL = origGas;
      if (origClientId) process.env.GOOGLE_CLIENT_ID = origClientId;
      if (origClientSecret) process.env.GOOGLE_CLIENT_SECRET = origClientSecret;
      if (origRefreshToken) process.env.GOOGLE_REFRESH_TOKEN = origRefreshToken;

      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.json?.code, 'DRIVE_CONFIG_REQUIRED');
    });

    // Test 6: Direct Google Drive API v3 Upload (Without Google Apps Script)
    await test('Direct Google Drive API v3 upload via Service Account (Zero Google Script)', async () => {
      // Mock global fetch to intercept Google OAuth2 and Drive endpoints
      const originalFetch = global.fetch;
      global.fetch = async (url, opts = {}) => {
        const urlStr = String(url);
        if (urlStr.includes('oauth2.googleapis.com/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: 'mock_direct_drive_token_xyz',
              expires_in: 3600
            })
          };
        }
        if (urlStr.includes('www.googleapis.com/upload/drive/v3/files')) {
          lastDriveUploadReceived = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'direct_drive_file_id_555444',
              name: 'Passbook_19120500703_October_2026.png',
              webViewLink: 'https://drive.google.com/file/d/direct_drive_file_id_555444/view'
            })
          };
        }
        return originalFetch(url, opts);
      };

      // Set Service Account environment variables (Direct Drive API mode)
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test-drive-service@pandua-mdm.iam.gserviceaccount.com';
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY = testPrivateKey;
      process.env.GOOGLE_DRIVE_FOLDER_ID = 'target_drive_folder_id_12345';
      delete process.env.GOOGLE_DRIVE_WEBAPP_URL; // Guarantee NO Google Script is used!

      resetGoogleTokenCache();

      const { boundary, body } = buildMultipart(
        { u_dise: testUdise, month: testMonth, year: testYear },
        'photo',
        'passbook_real.png',
        'image/png',
        VALID_PNG_BUFFER
      );

      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);

      global.fetch = originalFetch;

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json?.status, 'success');
      assert.strictEqual(res.json?.fileId, 'direct_drive_file_id_555444');
      assert(res.json?.fileUrl.includes('direct_drive_file_id_555444'));
      assert.strictEqual(lastDriveUploadReceived, true);

      // Verify record saved in Supabase PostgreSQL
      const dbRes = await pool.query(
        'SELECT u_dise, month_name, year, passbook_photo_file_id, passbook_photo_url, fund_details_json FROM public.mdm_monthly_report WHERE u_dise = $1 AND LOWER(month_name) = LOWER($2) AND year = $3',
        [testUdise, testMonth, testYear]
      );
      assert.strictEqual(dbRes.rows.length, 1);
      const row = dbRes.rows[0];
      assert.strictEqual(row.passbook_photo_file_id, 'direct_drive_file_id_555444');
      assert(row.passbook_photo_url.includes('direct_drive_file_id_555444'));
    });

    // Test 7: Verify /api/monthly-report returns the Direct Google Drive file ID & URL
    await test('GET /api/monthly-report retrieves direct Google Drive photo reference from Supabase', async () => {
      const res = await request({
        hostname: 'localhost',
        port: port,
        path: `/api/monthly-report?u_dise=${testUdise}&month_name=${testMonth}&year=${testYear}`,
        method: 'GET'
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json?.status, 'success');
      assert.strictEqual(res.json?.data?.passbook_photo_file_id, 'direct_drive_file_id_555444');
      assert(res.json?.data?.passbook_photo_url.includes('direct_drive_file_id_555444'));
    });

    // Test 8: Verify report save preserves existing Google Drive photo reference
    await test('POST /api/monthly-report/save maintains Google Drive photo reference without overwriting', async () => {
      const payload = {
        u_dise: testUdise,
        month_name: testMonth,
        year: testYear,
        p_days: 24,
        p_actual: 55,
        p_meals: 1200,
        passbook_photo_file_id: null,
        passbook_photo_url: null
      };
      const jsonBody = Buffer.from(JSON.stringify(payload), 'utf8');

      const res = await request({
        hostname: 'localhost',
        port: port,
        path: '/api/monthly-report/save',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': jsonBody.length
        }
      }, jsonBody);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json?.status, 'success');

      const dbRes = await pool.query(
        'SELECT passbook_photo_file_id, passbook_photo_url FROM public.mdm_monthly_report WHERE u_dise = $1 AND LOWER(month_name) = LOWER($2) AND year = $3',
        [testUdise, testMonth, testYear]
      );
      assert.strictEqual(dbRes.rows[0].passbook_photo_file_id, 'direct_drive_file_id_555444');
    });

  } finally {
    server.close();
    mockGoogleApiServer.close();
    await pool.end();
  }

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED`);
  if (passed === total) {
    console.log('🎉 ALL DIRECT GOOGLE DRIVE API TESTS PASSED SUCCESSFULLY!');
  } else {
    console.log('❌ SOME TESTS FAILED.');
    process.exit(1);
  }
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
