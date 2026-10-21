/**
 * Test Suite: Bank Passbook Submission Tracker & School Upload Integration
 * Verifies live Supabase school master integration, submission tracking,
 * upload status transitions, Excel reporting, and security boundaries.
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
require('dotenv').config();
const app = require('../server');
const { pool, getSchools } = require('../db/supabase');
const { createSessionToken } = require('../middleware/auth');
const { resetGoogleTokenCache } = require('../services/googleDriveService');

const TEST_PORT = 3989;
let serverInstance;

// Generate test RSA Key Pair for Service Account JWT signature testing
const { privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

function request(options, postBuffer = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });
    req.on('error', reject);
    if (postBuffer) {
      req.write(postBuffer);
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

// 1x1 valid PNG buffer
const TEST_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function runTrackerTests() {
  console.log('================================================================');
  console.log('  STARTING TEST SUITE: BANK PASSBOOK SUBMISSION TRACKER');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`✅ PASS: ${name}`);
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error('   Error:', err.message);
    }
  }

  // Start test server
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, resolve);
  });

  const adminToken = createSessionToken({ id: 1, username: 'admin', admin_type: 'main' });
  const adminCookie = `admin_session=${adminToken}`;
  const testSchoolUdise = '19120513702'; // ABIRA PRIMARY SCHOOL (initially Not Submitted)

  try {
    // Test 1: Security - Unauthorized access to tracker API is rejected (401)
    await test('Security: GET /api/monthly-report/passbook-tracker rejects unauthenticated requests (HTTP 401)', async () => {
      const res = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/passbook-tracker',
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.json?.authenticated, false);
    });

    // Test 2: Authenticated admin receives complete school master list (246 schools)
    let initialSubmittedCount = 0;
    await test('Admin: GET /api/monthly-report/passbook-tracker returns all 246 schools and accurate summary', async () => {
      const res = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/passbook-tracker',
        method: 'GET',
        headers: { Cookie: adminCookie, 'Accept': 'application/json' }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json?.status, 'success');
      assert.strictEqual(res.json?.summary?.total_schools, 246);
      assert.strictEqual(res.json?.schools?.length, 246);
      assert(typeof res.json?.summary?.submitted === 'number');
      assert(typeof res.json?.summary?.not_submitted === 'number');
      assert.strictEqual(res.json?.summary?.submitted + res.json?.summary?.not_submitted, 246);
      initialSubmittedCount = res.json.summary.submitted;

      // Verify school row structure
      const sample = res.json.schools[0];
      assert(sample.sl_no === 1);
      assert(sample.school_id);
      assert(sample.school_name);
      assert(sample.status === 'Submitted' || sample.status === 'Not Submitted');
    });

    // Test 3: GET /api/monthly-report/passbook-status for submitted school
    await test('Integration: GET /api/monthly-report/passbook-status returns Submitted for school 19120500703', async () => {
      const res = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/passbook-status?school_id=19120500703',
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json?.status, 'success');
      assert.strictEqual(res.json?.submission?.submission_status, 'Submitted');
      assert(res.json?.submission?.drive_file_id);
      assert(res.json?.submission?.file_url.includes('drive.google.com'));
    });

    // Test 4: GET /api/monthly-report/passbook-status for unsubmitted school
    await test('Integration: GET /api/monthly-report/passbook-status returns Not Submitted for pending school', async () => {
      const res = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: `/api/monthly-report/passbook-status?school_id=${testSchoolUdise}`,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json?.status, 'success');
      assert.strictEqual(res.json?.submission?.submission_status, 'Not Submitted');
      assert.strictEqual(res.json?.submission?.drive_file_id, null);
    });

    // Test 5: Upload passbook photo for test school and verify automatic status update to Submitted
    await test('Upload Flow: School upload updates status to Submitted automatically in tracker', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url, opts = {}) => {
        const urlStr = String(url);
        if (urlStr.includes('oauth2.googleapis.com/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'mock_test_token_777', expires_in: 3600 })
          };
        }
        if (urlStr.includes('www.googleapis.com/upload/drive/v3/files')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'test_drive_file_abira_888',
              name: `Passbook_${testSchoolUdise}_October_2026.png`,
              webViewLink: 'https://drive.google.com/file/d/test_drive_file_abira_888/view'
            })
          };
        }
        return originalFetch(url, opts);
      };

      const origEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const origKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@pandua.iam.gserviceaccount.com';
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY = testPrivateKey;
      delete process.env.GOOGLE_DRIVE_WEBAPP_URL;

      resetGoogleTokenCache();

      const { boundary, body } = buildMultipart(
        { u_dise: testSchoolUdise, month: 'October', year: '2026' },
        'photo',
        'abira_passbook.png',
        'image/png',
        TEST_PNG_BUFFER
      );

      const uploadRes = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);

      global.fetch = originalFetch;
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = origEmail;
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY = origKey;
      resetGoogleTokenCache();

      assert.strictEqual(uploadRes.statusCode, 200);
      assert.strictEqual(uploadRes.json?.status, 'success');
      assert.strictEqual(uploadRes.json?.submissionStatus, 'Submitted');

      // Verify tracker now shows Submitted and incremented count
      const trackerRes = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/passbook-tracker',
        method: 'GET',
        headers: { Cookie: adminCookie, 'Accept': 'application/json' }
      });
      assert.strictEqual(trackerRes.statusCode, 200);
      assert.strictEqual(trackerRes.json?.summary?.submitted, initialSubmittedCount + 1);

      const targetSchool = trackerRes.json?.schools?.find(s => s.school_id === testSchoolUdise);
      assert(targetSchool, 'Target school must exist in tracker');
      assert.strictEqual(targetSchool.status, 'Submitted');
      assert(targetSchool.drive_file_id);
      assert(targetSchool.file_url.includes('drive.google.com'));
      assert(targetSchool.submitted_at);
    });

    // Test 6: Re-uploading photo updates record without creating duplicate entries
    await test('Deduplication: Replacing existing photo updates record without duplicate entries', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url, opts = {}) => {
        const urlStr = String(url);
        if (urlStr.includes('oauth2.googleapis.com/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'mock_test_token_777', expires_in: 3600 })
          };
        }
        if (urlStr.includes('www.googleapis.com/upload/drive/v3/files')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 'test_drive_file_abira_replaced_999',
              name: `Passbook_${testSchoolUdise}_October_2026_replaced.png`,
              webViewLink: 'https://drive.google.com/file/d/test_drive_file_abira_replaced_999/view'
            })
          };
        }
        return originalFetch(url, opts);
      };

      const origEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const origKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'test@pandua.iam.gserviceaccount.com';
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY = testPrivateKey;
      delete process.env.GOOGLE_DRIVE_WEBAPP_URL;

      resetGoogleTokenCache();

      const { boundary, body } = buildMultipart(
        { u_dise: testSchoolUdise, month: 'October', year: '2026' },
        'photo',
        'abira_passbook_new.png',
        'image/png',
        TEST_PNG_BUFFER
      );

      const replaceRes = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/upload-passbook',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, body);

      global.fetch = originalFetch;
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = origEmail;
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY = origKey;
      resetGoogleTokenCache();

      assert.strictEqual(replaceRes.statusCode, 200);

      // Verify in database that exactly 1 row exists for this school
      const dbCheck = await pool.query(
        'SELECT id, school_id, drive_file_id FROM public.bank_passbook_submissions WHERE school_id = $1',
        [testSchoolUdise]
      );
      assert.strictEqual(dbCheck.rows.length, 1, 'Should only have 1 row for this school (no duplicates)');
      assert.strictEqual(dbCheck.rows[0].drive_file_id, 'test_drive_file_abira_replaced_999');
    });

    // Test 7: Download Excel Report contains all schools and required columns
    await test('Excel Report: GET /api/monthly-report/passbook-tracker/excel downloads complete 246-school report', async () => {
      const res = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: '/api/monthly-report/passbook-tracker/excel',
        method: 'GET',
        headers: { Cookie: adminCookie }
      });
      assert.strictEqual(res.statusCode, 200);
      assert(res.headers['content-type'].includes('vnd.ms-excel'));
      assert(res.headers['content-disposition'].includes('attachment'));
      assert(res.headers['content-disposition'].includes('Bank_Passbook_Submission_Report_'));

      // Check required table header columns in content
      assert(res.body.includes('<th>id</th>'));
      assert(res.body.includes('School Name'));
      assert(res.body.includes('Category'));
      assert(res.body.includes('udise_code'));
      assert(res.body.includes('Circle Name'));
      assert(res.body.includes('GP Name'));
      assert(res.body.includes('Passbook Submission Status'));
      assert(res.body.includes('Submission Date and Time'));
      assert(res.body.includes('Passbook Photo Link'));

      // Check both Submitted and Not Submitted rows are included
      assert(res.body.includes('Submitted'));
      assert(res.body.includes('Not Submitted'));
      assert(res.body.includes(testSchoolUdise));
    });

    // Clean up test school submission row
    await pool.query('DELETE FROM public.bank_passbook_submissions WHERE school_id = $1', [testSchoolUdise]);
    await pool.query('DELETE FROM public.mdm_monthly_report WHERE u_dise = $1 AND year = $2', [testSchoolUdise, '2026']);

  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
  }

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED`);
  if (passed === total) {
    console.log('🎉 ALL BANK PASSBOOK TRACKER TESTS PASSED SUCCESSFULLY!');
  } else {
    console.error('⚠️ SOME TESTS FAILED');
  }
  console.log('================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runTrackerTests().then(() => {
  process.exit(0);
}).catch((e) => {
  console.error('Tracker suite fatal error:', e);
  process.exit(1);
});
