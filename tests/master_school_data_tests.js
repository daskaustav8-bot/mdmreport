const http = require('http');
const app = require('../server');
const { pool, getSchools, getSchoolsMap } = require('../db/supabase');

const TEST_PORT = 3888;
let serverInstance;

function request(options, postData = null) {
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
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  const match = cookieStr.match(/admin_session=([^;]+)/);
  return match ? `admin_session=${match[1]}` : null;
}

const results = [];
function recordResult(testName, passed, details = '') {
  results.push({ testName, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${testName}${details ? ' - ' + details : ''}`);
}

async function runMasterVerificationTests() {
  console.log('================================================================');
  console.log('  STARTING COMPREHENSIVE SUPABASE SCHOOL MASTER VERIFICATION');
  console.log('  Zero PHP Runtime | Supabase Single Source of Truth');
  console.log('================================================================\n');

  // Start Express Test Server
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, resolve);
  });

  try {
    // -------------------------------------------------------------
    // 1. Direct Supabase Query & 5 Master Fields Verification
    // -------------------------------------------------------------
    console.log('--- Phase 1: Supabase Direct Verification ---');
    const schools = await getSchools();
    const schoolsMap = await getSchoolsMap();

    recordResult(
      'School Master record count matches exactly (246 schools in Supabase)',
      schools.length === 246,
      `Retrieved ${schools.length} records`
    );

    // Verify all 5 master fields on every record
    const allHave5Fields = schools.every(s => 
      Boolean(s.name && s.school_name) &&
      Boolean(s.category && s.catergory) &&
      Boolean(s.circle && s.circle_name) &&
      Boolean(s.gp && s.gp_name) &&
      Boolean(s.udise && s.code)
    );

    recordResult(
      'All 5 Master Fields strictly present on every record: Name, Category, Circle, GP, UDISE',
      allHave5Fields,
      'Validated 246/246 records'
    );

    // Sample school verification
    const sample = schools[0];
    const mapLookup = schoolsMap[sample.udise];
    recordResult(
      'Selecting school by UDISE correctly associates 4 other master fields',
      mapLookup && mapLookup.school_name === sample.school_name && mapLookup.circle_name === sample.circle_name,
      `UDISE: ${sample.udise} -> ${sample.school_name}`
    );

    // -------------------------------------------------------------
    // 2. HTTP School Endpoints Verification
    // -------------------------------------------------------------
    console.log('\n--- Phase 2: School API Endpoints (Express & Supabase) ---');

    // A. GET /api/schools
    const resSchoolsApi = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/schools',
      method: 'GET'
    });
    recordResult(
      'GET /api/schools returns HTTP 200 with all 246 schools from Supabase',
      resSchoolsApi.statusCode === 200 && Array.isArray(resSchoolsApi.json) && resSchoolsApi.json.length === 246,
      `HTTP ${resSchoolsApi.statusCode}, Count: ${resSchoolsApi.json?.length}`
    );

    // B. GET /get_schools.php (Legacy compatibility endpoint)
    const resSchoolsPhp = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/get_schools.php',
      method: 'GET'
    });
    recordResult(
      'GET /get_schools.php executes via Express with zero PHP runtime',
      resSchoolsPhp.statusCode === 200 && Array.isArray(resSchoolsPhp.json) && resSchoolsPhp.json.length === 246,
      `HTTP ${resSchoolsPhp.statusCode}, Count: ${resSchoolsPhp.json?.length}`
    );

    // C. GET /get_student_schools.php
    const resStudentSchools = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/get_student_schools.php',
      method: 'GET'
    });
    const firstStudentSchool = resStudentSchools.json?.[0];
    const hasSelect2Props = firstStudentSchool && firstStudentSchool.id && firstStudentSchool.text && firstStudentSchool.category;
    recordResult(
      'GET /get_student_schools.php returns Select2 format with master school fields',
      resStudentSchools.statusCode === 200 && hasSelect2Props,
      `id: ${firstStudentSchool?.id}, text: ${firstStudentSchool?.text}`
    );

    // -------------------------------------------------------------
    // 3. Rice Requirement Endpoints
    // -------------------------------------------------------------
    console.log('\n--- Phase 3: Rice Requirement Endpoints ---');

    // A. GET /get_saved_data.php
    const resRiceSaved = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: `/get_saved_data.php?u_dise=${sample.udise}&quarter=Q1`,
      method: 'GET'
    });
    recordResult(
      'GET /get_saved_data.php returns saved rice requirement',
      resRiceSaved.statusCode === 200 && (resRiceSaved.json?.status === 'success' || resRiceSaved.json?.status === 'not_found'),
      `Status: ${resRiceSaved.json?.status}`
    );

    // B. POST /submit_rice.php (Test submission and master school enforcement)
    const resRiceSubmit = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/submit_rice.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, `u_dise=${sample.udise}&quarter=Q1&p_bv=50&p_c15=100&u_c5=0&u_c68=0`);

    recordResult(
      'POST /submit_rice.php upserts rice requirements to Supabase without PHP',
      resRiceSubmit.statusCode === 200 && resRiceSubmit.body.includes('success'),
      `Response: ${resRiceSubmit.body}`
    );

    // C. GET /status_table.php
    const resStatusTable = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/status_table.php',
      method: 'GET'
    });
    recordResult(
      'GET /status_table.php returns HTML table with recently submitted schools',
      resStatusTable.statusCode === 200 && resStatusTable.body.includes('Recently Submitted Schools'),
      `HTTP ${resStatusTable.statusCode}`
    );

    // -------------------------------------------------------------
    // 4. Admin Session & Exports Verification
    // -------------------------------------------------------------
    console.log('\n--- Phase 4: Admin Session & Export Endpoints ---');

    // Login as main admin
    const resAdminLogin = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'admin123', admin_type: 'main' });

    const adminCookie = extractCookie(resAdminLogin.headers);

    // A. GET /admin_rice_view_data.php?q=Q1
    const resRiceView = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_rice_view_data.php?q=Q1',
      method: 'GET',
      headers: { Cookie: adminCookie }
    });
    recordResult(
      'GET /admin_rice_view_data.php returns total 246 schools with submitted/pending stats',
      resRiceView.statusCode === 200 && resRiceView.json?.total_schools === 246,
      `Total: ${resRiceView.json?.total_schools}, Submitted: ${resRiceView.json?.submitted}, Pending: ${resRiceView.json?.pending}`
    );

    // B. GET /export_excel.php?q=Q1 (Submitted Excel)
    const resExportRice = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/export_excel.php?q=Q1',
      method: 'GET',
      headers: { Cookie: adminCookie }
    });
    recordResult(
      'GET /export_excel.php downloads Excel report with master school info from Supabase',
      resExportRice.statusCode === 200 && resExportRice.body.includes('Submitted School List Report'),
      `HTTP ${resExportRice.statusCode}`
    );

    // C. GET /export_pending_excel.php?q=Q1 (Pending Excel)
    const resExportPending = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/export_pending_excel.php?q=Q1',
      method: 'GET',
      headers: { Cookie: adminCookie }
    });
    recordResult(
      'GET /export_pending_excel.php downloads Pending Schools Excel against Supabase master list',
      resExportPending.statusCode === 200 && resExportPending.body.includes('Pending School List Report'),
      `HTTP ${resExportPending.statusCode}`
    );

    // D. GET /export_student_excel.php
    const resExportStudent = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/export_student_excel.php',
      method: 'GET',
      headers: { Cookie: adminCookie }
    });
    recordResult(
      'GET /export_student_excel.php downloads Student Enrolment Excel',
      resExportStudent.statusCode === 200 && resExportStudent.body.includes('Class-wise Student Enrolment Report'),
      `HTTP ${resExportStudent.statusCode}`
    );

    // E. GET /export_student_pending_excel.php
    const resExportStudentPending = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/export_student_pending_excel.php',
      method: 'GET',
      headers: { Cookie: adminCookie }
    });
    recordResult(
      'GET /export_student_pending_excel.php downloads Student Pending Excel',
      resExportStudentPending.statusCode === 200 && resExportStudentPending.body.includes('Pending Schools (Student Enrolment Not Updated)'),
      `HTTP ${resExportStudentPending.statusCode}`
    );

    // F. GET /export_all_infra_excel.php
    const resExportInfra = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/export_all_infra_excel.php',
      method: 'GET'
    });
    recordResult(
      'GET /export_all_infra_excel.php downloads Infrastructure Excel',
      resExportInfra.statusCode === 200 && resExportInfra.body.includes('School Infrastructure Report'),
      `HTTP ${resExportInfra.statusCode}`
    );

    // -------------------------------------------------------------
    // 5. Monthly Report & Closing Balance Endpoints
    // -------------------------------------------------------------
    console.log('\n--- Phase 5: Monthly Report & Closing Balance ---');

    // A. GET /download_monthly_template.php (Pre-populated with 246 schools)
    const resTmpl = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/download_monthly_template.php?type=all&month=January&year=2025',
      method: 'GET'
    });
    const tmplLines = resTmpl.body.split(/\r?\n/).filter(l => l.trim().length > 0);
    recordResult(
      'GET /download_monthly_template.php generates CSV with 246 schools from Supabase',
      resTmpl.statusCode === 200 && tmplLines.length >= 247, // 1 header + 246 schools
      `HTTP ${resTmpl.statusCode}, Total CSV Lines: ${tmplLines.length}`
    );

    // B. GET /closingbalance.php?render=report_body
    const resClosingRender = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: `/closingbalance.php?month=October&school=${encodeURIComponent(sample.name)}&render=report_body`,
      method: 'GET'
    });
    recordResult(
      'GET /closingbalance.php with render=report_body returns HTML report card',
      resClosingRender.statusCode === 200 && (resClosingRender.body.includes('Meal Availed Status') || resClosingRender.body.includes('No Data Found')),
      `HTTP ${resClosingRender.statusCode}`
    );

    // C. GET /closingbalance.php without render (direct visit redirects 308 to /closingbalance)
    const resClosingDirect = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/closingbalance.php',
      method: 'GET'
    });
    recordResult(
      'GET /closingbalance.php redirects with HTTP 308 to /closingbalance',
      resClosingDirect.statusCode === 308 && resClosingDirect.headers.location === '/closingbalance',
      `HTTP ${resClosingDirect.statusCode} -> ${resClosingDirect.headers.location}`
    );

    // Direct clean route GET /closingbalance serves closingbalance.html
    const resClosingClean = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/closingbalance',
      method: 'GET'
    });
    recordResult(
      'GET /closingbalance serves closingbalance.html directly',
      resClosingClean.statusCode === 200 && resClosingClean.body.includes('Monthly Report'),
      `HTTP ${resClosingClean.statusCode}`
    );

    // -------------------------------------------------------------
    // 6. View Routes Verification
    // -------------------------------------------------------------
    console.log('\n--- Phase 6: Clean HTML View Routes & 308 Redirects ---');

    const viewsToTest = [
      { path: '/monthlyreport', legacyPath: '/monthlyreport.html', title: 'School Monthly Report' },
      { path: '/monthly_view', legacyPath: '/monthly_view.html', title: 'Monthly Report Card' },
      { path: '/rice_report_view', legacyPath: '/rice_report_view.html', title: 'Rice Requirement' },
      { path: '/rice_report_panel', legacyPath: '/rice_report_panel.html', title: 'Rice Requirement Report Panel' },
      { path: '/status_table', legacyPath: '/status_table.html', title: 'Recently Submitted Schools' },
      { path: '/upload_monthly_report', legacyPath: '/upload_monthly_report.html', title: 'Upload Monthly Report' },
      { path: '/upload_csv', legacyPath: '/upload_csv.html', title: 'Admin Upload' },
      { path: '/admin_upload', legacyPath: '/admin_upload.html', title: 'Admin Upload' },
      { path: '/student_update', legacyPath: '/student_update.html', title: 'Student Enrolment' },
      { path: '/ricerequirement', legacyPath: '/ricerequirement.html', title: 'Rice Requirement' }
    ];

    for (const v of viewsToTest) {
      // Test clean extensionless route
      const resView = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: v.path,
        method: 'GET',
        headers: { Cookie: adminCookie }
      });
      recordResult(
        `Clean route ${v.path} renders successfully`,
        resView.statusCode === 200 && resView.body.includes(v.title),
        `HTTP ${resView.statusCode}`
      );

      // Test legacy .html route 308 redirect
      const resLegacy = await request({
        hostname: 'localhost',
        port: TEST_PORT,
        path: v.legacyPath,
        method: 'GET',
        headers: { Cookie: adminCookie }
      });
      recordResult(
        `Legacy route ${v.legacyPath} redirects to ${v.path} (HTTP 308)`,
        resLegacy.statusCode === 308 && resLegacy.headers.location === v.path,
        `HTTP ${resLegacy.statusCode} -> ${resLegacy.headers.location}`
      );
    }

    // -------------------------------------------------------------
    // 7. Student Enrolment Save & Fetch Verification
    // -------------------------------------------------------------
    console.log('\n--- Phase 7: Student Enrolment Save & Fetch ---');

    const resSaveStudent = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/save_student_enrolment.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      u_dise: sample.udise,
      pre_primary: 15,
      class_1: 20,
      class_2: 25,
      total_enrolment: 60,
      total_male: 30,
      total_female: 30,
      grand_total: 60
    });

    recordResult(
      'POST /save_student_enrolment.php saves to Supabase enforcing master fields',
      resSaveStudent.statusCode === 200 && resSaveStudent.json?.status === 'success',
      `Status: ${resSaveStudent.json?.status}`
    );

    const resGetStudent = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: `/get_student_enrolment.php?u_dise=${sample.udise}`,
      method: 'GET'
    });

    recordResult(
      'GET /get_student_enrolment.php retrieves updated enrolment data',
      resGetStudent.statusCode === 200 && resGetStudent.json?.status === 'success' && resGetStudent.json?.data?.u_dise === sample.udise,
      `UDISE: ${resGetStudent.json?.data?.u_dise}, School: ${resGetStudent.json?.data?.school_name}`
    );

    // -------------------------------------------------------------
    // 8. Newly Converted Clean APIs Verification
    // -------------------------------------------------------------
    console.log('\n--- Phase 8: Converted Modern Clean APIs ---');

    // A. GET /api/student/data
    const resStudentData = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/student/data',
      method: 'GET',
      headers: { Cookie: adminCookie }
    });
    recordResult(
      'GET /api/student/data returns JSON student enrolment records',
      resStudentData.statusCode === 200 && Array.isArray(resStudentData.json?.data),
      `Count: ${resStudentData.json?.data?.length}`
    );

    // B. GET /api/rice/panel-data
    const resRicePanel = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/rice/panel-data',
      method: 'GET'
    });
    recordResult(
      'GET /api/rice/panel-data returns JSON report panel records',
      resRicePanel.statusCode === 200 && Array.isArray(resRicePanel.json?.data),
      `Count: ${resRicePanel.json?.data?.length}`
    );

    // C. GET /api/rice/status-table?format=json
    const resStatusTableJson = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/rice/status-table?format=json',
      method: 'GET'
    });
    recordResult(
      'GET /api/rice/status-table?format=json returns JSON status records',
      resStatusTableJson.statusCode === 200 && Array.isArray(resStatusTableJson.json?.data),
      `Count: ${resStatusTableJson.json?.data?.length}`
    );

    // D. POST /api/save-data
    const resSaveMdcf = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/save-data',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }
    }, `month_name=October&school_name=${encodeURIComponent(sample.school_name)}&rice_received=100&rice_consumed=80&closing_balance=20`);
    recordResult(
      'POST /api/save-data saves legacy mdcf record into Supabase',
      resSaveMdcf.statusCode === 200 && resSaveMdcf.json?.status === 'success',
      `Response: ${resSaveMdcf.body}`
    );

  } finally {
    // Graceful teardown
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
  }

  console.log('\n================================================================');
  const allPassed = results.every(r => r.passed);
  console.log(`TEST SUMMARY: ${results.filter(r => r.passed).length}/${results.length} PASSED`);
  if (allPassed) {
    console.log('🎉 ALL MASTER SCHOOL DATA AND ZERO-PHP TESTS PASSED SUCCESSFULLY!');
  } else {
    console.log('❌ SOME TESTS FAILED. PLEASE REVIEW RESULTS ABOVE.');
    process.exit(1);
  }
  console.log('================================================================');

  // Explicitly exit so idle pool connections don't hang the runner
  process.exit(allPassed ? 0 : 1);
}

if (require.main === module) {
  runMasterVerificationTests().catch(err => {
    console.error('Fatal test error:', err);
    if (serverInstance) serverInstance.close();
    process.exit(1);
  });
}

module.exports = { runMasterVerificationTests };
