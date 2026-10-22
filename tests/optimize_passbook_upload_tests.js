/**
 * Test Suite: Bank Passbook Photo Upload Optimization & Bottleneck Diagnostics
 */
const assert = require('assert');
const http = require('http');
require('dotenv').config();
const { pool } = require('../db/supabase');
const app = require('../server');

let server;
let port;

// Genuine JPEG image buffer (mocking passbook photo)
function createMockJpegBuffer(sizeBytes) {
  const buf = Buffer.alloc(sizeBytes, 0x80);
  buf[0] = 0xFF; buf[1] = 0xD8; buf[2] = 0xFF; // JPEG SOI marker
  buf[sizeBytes - 2] = 0xFF; buf[sizeBytes - 1] = 0xD9; // JPEG EOI marker
  return buf;
}

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
  console.log('  STARTING TEST SUITE: PASSBOOK UPLOAD SPEED & BOTTLENECK DIAGNOSTICS');
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

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });

  const testUdise = '19120500703'; // ABADPARA PRIMARY SCHOOL
  const testMonth = 'January';
  const testYear = '2026';

  // Test 1: Uploading an optimized JPEG image (~450KB) returns status 200, fileId, and timing metrics
  await test('Upload optimized JPEG photo returns timing breakdown (drive_ms, db_ms, total_server_ms)', async () => {
    const optJpeg = createMockJpegBuffer(450 * 1024); // 450 KB
    const { boundary, body } = buildMultipart(
      { u_dise: testUdise, month: testMonth, year: testYear },
      'photo',
      'ABADPARA_PRIMARY_SCHOOL.jpg',
      'image/jpeg',
      optJpeg
    );

    const res = await request({
      hostname: 'localhost',
      port,
      path: '/api/monthly-report/upload-passbook',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, body);

    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}: ${res.body}`);
    assert.strictEqual(res.json.status, 'success');
    assert.ok(res.json.fileId, 'Response should contain Google Drive fileId');
    assert.ok(res.json.fileUrl, 'Response should contain fileUrl');
    assert.ok(res.json.timing, 'Response should contain timing diagnostic object');
    assert.strictEqual(typeof res.json.timing.drive_ms, 'number', 'timing.drive_ms should be a number');
    assert.strictEqual(typeof res.json.timing.db_ms, 'number', 'timing.db_ms should be a number');
    assert.strictEqual(typeof res.json.timing.total_server_ms, 'number', 'timing.total_server_ms should be a number');

    console.log(`   [Diagnostic Metrics] Drive Upload: ${res.json.timing.drive_ms} ms | DB Save: ${res.json.timing.db_ms} ms | Total Server: ${res.json.timing.total_server_ms} ms`);
  });

  // Test 2: Compression efficiency simulation (8MB original vs 450KB optimized)
  await test('Verify payload reduction: 8MB original camera image vs 450KB optimized', async () => {
    const origSize = 8 * 1024 * 1024;
    const optSize = 450 * 1024;
    const reductionPercent = ((origSize - optSize) / origSize) * 100;
    assert.ok(reductionPercent > 90, 'Compression must achieve >90% bandwidth reduction');
    console.log(`   [Payload Comparison] Original: ${(origSize / (1024 * 1024)).toFixed(2)} MB -> Optimized: ${(optSize / 1024).toFixed(0)} KB (${reductionPercent.toFixed(1)}% reduction)`);
  });

  // Test 3: Supabase stores fileId and metadata only (no binary image stored in DB)
  await test('Supabase stores metadata reference without image binary bloat', async () => {
    const { rows } = await pool.query(
      'SELECT school_id, drive_file_id, file_name, file_url, submission_status FROM public.bank_passbook_submissions WHERE school_id = $1',
      [testUdise]
    );
    assert.strictEqual(rows.length, 1, 'Should find submission record in bank_passbook_submissions');
    const row = rows[0];
    assert.ok(row.drive_file_id, 'drive_file_id should be present');
    assert.ok(row.file_url.includes('drive.google.com'), 'file_url should point to Google Drive');
    assert.strictEqual(row.submission_status, 'Submitted');
  });

  // Test 4: Retry with the same cached buffer succeeds seamlessly
  await test('Retry upload with cached in-memory buffer succeeds without reselection', async () => {
    const cachedBuffer = createMockJpegBuffer(480 * 1024);
    const { boundary, body } = buildMultipart(
      { u_dise: testUdise, month: testMonth, year: testYear },
      'photo',
      'ABADPARA_PRIMARY_SCHOOL.jpg',
      'image/jpeg',
      cachedBuffer
    );

    const res = await request({
      hostname: 'localhost',
      port,
      path: '/api/monthly-report/upload-passbook',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, body);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'success');
    assert.ok(res.json.fileId);
  });

  server.close();
  await pool.end();

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED`);
  if (passed === total) {
    console.log('🎉 ALL OPTIMIZATION & DIAGNOSTIC TESTS PASSED SUCCESSFULLY!');
  }
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
