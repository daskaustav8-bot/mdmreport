/**
 * Integration Tests: upload_csv.html & Supabase Monthly Report Processing
 * Zero PHP | Pure HTML+JS + Supabase PostgreSQL
 */

const assert = require('assert');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, getSchoolsMap } = require('../db/supabase');
const { createSessionToken } = require('../middleware/auth');
const app = require('../server');

const TEST_PORT = 3556;
let serverInstance;
let testsPassed = 0;
let testsFailed = 0;

function logResult(title, passed, detail = '') {
  if (passed) {
    testsPassed++;
    console.log(`✅ PASS: ${title}${detail ? ' - ' + detail : ''}`);
  } else {
    testsFailed++;
    console.error(`❌ FAIL: ${title}${detail ? ' - ' + detail : ''}`);
  }
}

function makeRequest(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING INTEGRATION TESTS: UPLOAD_CSV.HTML & SUPABASE');
  console.log('================================================================\n');

  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, resolve);
  });

  const mainAdminToken = createSessionToken({
    id: 3,
    username: 'admin',
    admin_type: 'main'
  });
  const mainCookie = `admin_session=${mainAdminToken}`;

  const infraAdminToken = createSessionToken({
    id: 6,
    username: 'admin',
    admin_type: 'infrastructure'
  });
  const infraCookie = `admin_session=${infraAdminToken}`;

  // Test 1: Page Route Serves upload_csv via clean URL and 308 on .html
  try {
    const res = await makeRequest('/upload_csv', {
      headers: { 'Cookie': mainCookie }
    });
    const hasHeader = res.body.includes('Upload Monthly Reports');
    const hasPrimaryCard = res.body.includes('Primary Schools');
    const hasUpperCard = res.body.includes('Upper Primary Schools');
    const zeroPhp = !res.body.includes('<?php') && !res.body.includes('$_POST');
    logResult('/upload_csv renders with complete UI and zero PHP', res.status === 200 && hasHeader && hasPrimaryCard && hasUpperCard && zeroPhp);

    const legacyRes = await makeRequest('/upload_csv.html', {
      headers: { 'Cookie': mainCookie }
    });
    logResult('/upload_csv.html redirects with HTTP 308 to /upload_csv', legacyRes.status === 308 && legacyRes.headers.location === '/upload_csv');
  } catch (e) {
    logResult('upload_csv renders', false, e.message);
  }

  // Test 2: Unauthenticated upload is blocked
  try {
    const res = await makeRequest('/api/monthly-report/upload-csv', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        month: 'March',
        year: '2025',
        type: 'primary',
        rows: []
      })
    });
    logResult('Unauthenticated upload request strictly rejected (401)', res.status === 401);
  } catch (e) {
    logResult('Unauthenticated upload request rejected', false, e.message);
  }

  // Test 3: Infrastructure session cannot access Main Admin upload
  try {
    const res = await makeRequest('/api/monthly-report/upload-csv', {
      method: 'POST',
      headers: {
        'Cookie': infraCookie,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        month: 'March',
        year: '2025',
        type: 'primary',
        rows: []
      })
    });
    logResult('Infrastructure Admin session cannot access Main Admin upload (401/403/Redirect)', res.status === 401 || res.status === 403 || res.status === 302);
  } catch (e) {
    logResult('Infrastructure Admin session cannot access upload', false, e.message);
  }

  // Clean up any test records
  const testUdise = '19120500703'; // ABADPARA PRIMARY SCHOOL
  const testMonth = 'TestMonth';
  const testYear = '2099';
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3', [testUdise, testMonth, testYear]);

  // Test 4: Primary CSV Upload to Supabase (Insert)
  try {
    // 35 columns matching original PHP structure:
    // 0: SL, 1: UDISE, 2: School, 3: Circle, 4: GP,
    // 5: bv_days, 6: p_days, 7: bv_act, 8: p_act, 9: bv_meals, 10: p_meals
    // 11-14: cc_bv (open, recv, exp, close), 15-18: cc_p (open, recv, exp, close)
    // 19-22: cch (open, recv, exp, close), 23-26: mme (open, recv, exp, close)
    // 27-30: rbv (open, recv, exp, close), 31-34: rp (open, recv, exp, close)
    const primaryRow = [
      '1', testUdise, 'RAW NAME', 'RAW CIRCLE', 'RAW GP',
      '20', '22', '15', '45', '300', '990',
      '100', '500', '400', '200', '250', '1000', '900', '350',
      '50', '200', '150', '100', '10', '50', '40', '20',
      '10.5', '50.0', '40.0', '20.5', '25.0', '100.0', '90.0', '35.0'
    ];

    const res = await makeRequest('/api/monthly-report/upload-csv', {
      method: 'POST',
      headers: {
        'Cookie': mainCookie,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        month: testMonth,
        year: testYear,
        type: 'primary',
        rows: [primaryRow]
      })
    });

    const json = JSON.parse(res.body);
    const dbCheck = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [testUdise, testMonth, testYear]
    );

    const row = dbCheck.rows[0];
    const insertedOk = res.status === 200 && json.status === 'success' && dbCheck.rows.length === 1;
    const authorativeNameUsed = row && row.school_name.includes('ABADPARA'); // Verified against master map
    const valuesMatch = row && row.p_days === 22 && row.p_actual === 45 && parseFloat(row.rice_p_close) === 35.0;

    logResult('Primary CSV upload successfully inserts into Supabase mdm_monthly_report', insertedOk && authorativeNameUsed && valuesMatch, `Row ID: ${row?.id}, School: ${row?.school_name}`);
  } catch (e) {
    logResult('Primary CSV upload inserts into Supabase', false, e.message);
  }

  // Test 5: Update vs Insert (Re-uploading modifies existing record without creating duplicate)
  try {
    const updatedPrimaryRow = [
      '1', testUdise, 'RAW NAME', 'RAW CIRCLE', 'RAW GP',
      '25', '26', '18', '50', '350', '1100',
      '200', '600', '500', '300', '350', '1200', '1000', '550',
      '60', '250', '200', '110', '15', '60', '50', '25',
      '20.0', '60.0', '50.0', '30.0', '35.0', '120.0', '100.0', '55.0'
    ];

    const res = await makeRequest('/api/monthly-report/upload-csv', {
      method: 'POST',
      headers: {
        'Cookie': mainCookie,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        month: testMonth,
        year: testYear,
        type: 'primary',
        rows: [updatedPrimaryRow]
      })
    });

    const countCheck = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [testUdise, testMonth, testYear]
    );

    const updatedRow = countCheck.rows[0];
    const noDuplicates = countCheck.rows.length === 1; // Strict 1 record
    const valuesUpdated = updatedRow && updatedRow.p_days === 26 && updatedRow.p_actual === 50 && parseFloat(updatedRow.rice_p_close) === 55.0;

    logResult('Re-uploading same (u_dise, month, year) safely updates without duplicating', noDuplicates && valuesUpdated, `Total records for key: ${countCheck.rows.length}, Updated p_days: ${updatedRow?.p_days}`);
  } catch (e) {
    logResult('Re-uploading updates without duplicating', false, e.message);
  }

  // Test 6: Upper Primary CSV Upload to Supabase
  const testUpperUdise = '19120512203'; // AINCHGARH JR. HIGH SCHOOL
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3', [testUpperUdise, testMonth, testYear]);

  try {
    // Upper Primary Column Mapping:
    // col[5]: p_days, col[6]: up_days, col[7]: p_act, col[8]: up_act, col[9]: p_meals, col[10]: up_meals
    // col[11-14]: cc_p, col[15-18]: cc_up, col[19-22]: cch, col[23-26]: mme
    // col[27-30]: rp, col[31-34]: rup
    const upperRow = [
      '1', testUpperUdise, 'RAW NAME', 'RAW CIRCLE', 'RAW GP',
      '18', '24', '40', '65', '800', '1500',
      '150', '800', '700', '250', '200', '1200', '1000', '400',
      '40', '180', '140', '80', '12', '45', '35', '22',
      '30.0', '90.0', '80.0', '40.0', '50.0', '150.0', '130.0', '70.0'
    ];

    const res = await makeRequest('/api/monthly-report/upload-csv', {
      method: 'POST',
      headers: {
        'Cookie': mainCookie,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        month: testMonth,
        year: testYear,
        type: 'upper',
        rows: [upperRow]
      })
    });

    const dbCheck = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [testUpperUdise, testMonth, testYear]
    );

    const row = dbCheck.rows[0];
    const insertedOk = res.status === 200 && dbCheck.rows.length === 1;
    const authorativeNameUsed = row && row.school_name.includes('AINCHGARH');
    const valuesMatch = row && row.up_days === 24 && row.up_actual === 65 && parseFloat(row.rice_up_close) === 70.0;

    logResult('Upper Primary CSV upload correctly maps to up_* columns and upserts to Supabase', insertedOk && authorativeNameUsed && valuesMatch, `School: ${row?.school_name}, up_days: ${row?.up_days}, up_actual: ${row?.up_actual}`);
  } catch (e) {
    logResult('Upper Primary CSV upload maps to up_* columns', false, e.message);
  }

  // Test 7: Fallback school mapping when UDISE is not in master list
  const unknownUdise = '99999999999';
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3', [unknownUdise, testMonth, testYear]);

  try {
    const fallbackRow = [
      '1', unknownUdise, 'NEW UNKNOWN SCHOOL', 'CUSTOM CIRCLE', 'CUSTOM GP',
      '20', '22', '15', '45', '300', '990',
      '100', '500', '400', '200', '250', '1000', '900', '350',
      '50', '200', '150', '100', '10', '50', '40', '20',
      '10.5', '50.0', '40.0', '20.5', '25.0', '100.0', '90.0', '35.0'
    ];

    await makeRequest('/api/monthly-report/upload-csv', {
      method: 'POST',
      headers: {
        'Cookie': mainCookie,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        month: testMonth,
        year: testYear,
        type: 'primary',
        rows: [fallbackRow]
      })
    });

    const dbCheck = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [unknownUdise, testMonth, testYear]
    );

    const row = dbCheck.rows[0];
    const fallbackWorked = row && row.school_name === 'NEW UNKNOWN SCHOOL' && row.circle_name === 'CUSTOM CIRCLE' && row.gp_name === 'CUSTOM GP';
    logResult('Fallback mapping handles unknown UDISE gracefully from CSV indices 2, 3, 4', fallbackWorked, `Stored School: ${row?.school_name}, Circle: ${row?.circle_name}`);
  } catch (e) {
    logResult('Fallback mapping handles unknown UDISE', false, e.message);
  }

  // Clean up test rows
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE u_dise IN ($1, $2, $3) AND month_name = $4 AND year = $5', [testUdise, testUpperUdise, unknownUdise, testMonth, testYear]);

  if (serverInstance) await new Promise(res => serverInstance.close(res));
  await pool.end();

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${testsPassed}/${testsPassed + testsFailed} PASSED`);
  if (testsFailed === 0) {
    console.log('🎉 ALL UPLOAD_CSV AND SUPABASE INTEGRATION TESTS PASSED!');
  } else {
    console.error(`⚠️ ${testsFailed} TESTS FAILED!`);
    process.exit(1);
  }
  console.log('================================================================\n');
  process.exit(0);
}

runTests().catch(async err => {
  console.error('Fatal test error:', err);
  if (serverInstance) await new Promise(res => serverInstance.close(res));
  await pool.end();
  process.exit(1);
});
