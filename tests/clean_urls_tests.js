/**
 * Verification Suite: Clean Extensionless URLs, 308 Redirects & Query Preservation
 * Validates Vercel cleanUrls configuration & server-side routing
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');
const { createSessionToken } = require('../middleware/auth');
const { pool } = require('../db/supabase');

const TEST_PORT = 3666;
let serverInstance;

function request(urlPath, options = {}) {
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
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

const results = [];
function recordResult(testName, passed, details = '') {
  results.push({ testName, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${testName}${details ? ' - ' + details : ''}`);
}

async function runCleanUrlTests() {
  console.log('================================================================');
  console.log('  TEST SUITE: PM POSHAN CLEAN EXTENSIONLESS URLS & REDIRECTS');
  console.log('================================================================\n');

  // Start test server
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

  try {
    // -------------------------------------------------------------
    // Phase 1: Direct Extensionless Page Navigation (HTTP 200)
    // -------------------------------------------------------------
    console.log('--- Phase 1: Direct Extensionless Page Routes (HTTP 200) ---');

    const cleanPages = [
      { path: '/', titleSnippet: 'Dashboard' },
      { path: '/admin_login', titleSnippet: 'Admin' },
      { path: '/infra_login', titleSnippet: 'Infrastructure' },
      { path: '/basicinfrastructure', cookie: infraCookie, titleSnippet: 'Infrastructure' },
      { path: '/infrastructure', cookie: infraCookie, titleSnippet: 'Infrastructure' },
      { path: '/admin_dashboard', cookie: mainCookie, titleSnippet: 'Admin' },
      { path: '/admin_rice_view', cookie: mainCookie, titleSnippet: 'Rice' },
      { path: '/admin_student_view', cookie: mainCookie, titleSnippet: 'Student' },
      { path: '/upload_csv', cookie: mainCookie, titleSnippet: 'Upload' },
      { path: '/admin_upload', cookie: mainCookie, titleSnippet: 'Upload' },
      { path: '/upload_monthly_report', cookie: mainCookie, titleSnippet: 'Monthly Report' },
      { path: '/upload_infrastructure', cookie: mainCookie, titleSnippet: 'Upload Infrastructure' },
      { path: '/manage_infrastructure_fields', cookie: mainCookie, titleSnippet: 'Manage Infrastructure Fields' },
      { path: '/rice_report_detail', cookie: mainCookie, titleSnippet: 'Requirement' },
      { path: '/ricerequirement', titleSnippet: 'Rice Requirement' },
      { path: '/rice_report_view', titleSnippet: 'Rice Requirement' },
      { path: '/rice_report_panel', titleSnippet: 'Rice Requirement' },
      { path: '/status_table', titleSnippet: 'Recently Submitted Schools' },
      { path: '/student_update', titleSnippet: 'Student Enrolment' },
      { path: '/update_monthly_report', titleSnippet: 'Monthly Report' },
      { path: '/monthlyreport', titleSnippet: 'Monthly Report' },
      { path: '/monthly_view', titleSnippet: 'Monthly Report' },
      { path: '/closingbalance', titleSnippet: 'Monthly Report' }
    ];

    for (const page of cleanPages) {
      const headers = page.cookie ? { Cookie: page.cookie } : {};
      const res = await request(page.path, { headers });
      const ok = res.statusCode === 200 && res.body.toLowerCase().includes(page.titleSnippet.toLowerCase());
      recordResult(
        `Direct clean URL: ${page.path} returns HTTP 200`,
        ok,
        `HTTP ${res.statusCode}`
      );
    }

    // -------------------------------------------------------------
    // Phase 2: Query String Preservation on Clean URLs
    // -------------------------------------------------------------
    console.log('\n--- Phase 2: Query Parameter Functionality on Clean URLs ---');

    const resClosingQuery = await request('/closingbalance?month=October');
    recordResult(
      'Clean URL /closingbalance?month=October loads with query intact',
      resClosingQuery.statusCode === 200 && resClosingQuery.body.includes('October'),
      `HTTP ${resClosingQuery.statusCode}`
    );

    const resStudentQuery = await request('/student_update?u_dise=19120500703');
    recordResult(
      'Clean URL /student_update?u_dise=19120500703 loads with query intact',
      resStudentQuery.statusCode === 200,
      `HTTP ${resStudentQuery.statusCode}`
    );

    // -------------------------------------------------------------
    // Phase 3: Legacy .html URLs issue HTTP 308 and Preserve Query Parameters
    // -------------------------------------------------------------
    console.log('\n--- Phase 3: Legacy .html 308 Redirects & Query Preservation ---');

    const legacyHtmlPages = [
      { legacy: '/index.html', clean: '/' },
      { legacy: '/admin_login.html', clean: '/admin_login' },
      { legacy: '/infra_login.html', clean: '/infra_login' },
      { legacy: '/admin_dashboard.html', clean: '/admin_dashboard' },
      { legacy: '/basicinfrastructure.html', clean: '/basicinfrastructure' },
      { legacy: '/infrastructure.html', clean: '/infrastructure' },
      { legacy: '/admin_rice_view.html', clean: '/admin_rice_view' },
      { legacy: '/admin_student_view.html', clean: '/admin_student_view' },
      { legacy: '/upload_csv.html', clean: '/upload_csv' },
      { legacy: '/admin_upload.html', clean: '/admin_upload' },
      { legacy: '/upload_monthly_report.html', clean: '/upload_monthly_report' },
      { legacy: '/upload_infrastructure.html', clean: '/upload_infrastructure' },
      { legacy: '/manage_infrastructure_fields.html', clean: '/manage_infrastructure_fields' },
      { legacy: '/ricerequirement.html', clean: '/ricerequirement' },
      { legacy: '/rice_report_view.html', clean: '/rice_report_view' },
      { legacy: '/rice_report_panel.html', clean: '/rice_report_panel' },
      { legacy: '/rice_report_detail.html', clean: '/rice_report_detail' },
      { legacy: '/status_table.html', clean: '/status_table' },
      { legacy: '/student_update.html', clean: '/student_update' },
      { legacy: '/update_monthly_report.html', clean: '/update_monthly_report' },
      { legacy: '/monthlyreport.html', clean: '/monthlyreport' },
      { legacy: '/monthly_view.html', clean: '/monthly_view' },
      { legacy: '/closingbalance.html', clean: '/closingbalance' }
    ];

    for (const item of legacyHtmlPages) {
      const res = await request(item.legacy);
      const ok = res.statusCode === 308 && res.headers.location === item.clean;
      recordResult(
        `Legacy .html redirect: ${item.legacy} -> ${item.clean} (HTTP 308)`,
        ok,
        `HTTP ${res.statusCode} Location: ${res.headers.location}`
      );
    }

    // Explicit test for query parameter preservation on legacy .html redirect
    const resHtmlQuery = await request('/closingbalance.html?month=October');
    recordResult(
      'Legacy /closingbalance.html?month=October redirects to /closingbalance?month=October',
      resHtmlQuery.statusCode === 308 && resHtmlQuery.headers.location === '/closingbalance?month=October',
      `HTTP ${resHtmlQuery.statusCode} -> ${resHtmlQuery.headers.location}`
    );

    // -------------------------------------------------------------
    // Phase 4: Legacy .php URLs issue HTTP 308 Redirects
    // -------------------------------------------------------------
    console.log('\n--- Phase 4: Legacy .php 308 Redirects & Query Preservation ---');

    const legacyPhpPages = [
      { legacy: '/index.php', clean: '/' },
      { legacy: '/infrastructure.php', clean: '/infrastructure' },
      { legacy: '/basicinfrastructure.php', clean: '/basicinfrastructure' },
      { legacy: '/admin_login.php', clean: '/admin_login' },
      { legacy: '/infra_login.php', clean: '/infra_login' },
      { legacy: '/admin_dashboard.php', clean: '/admin_dashboard' },
      { legacy: '/admin_rice_view.php', clean: '/admin_rice_view' },
      { legacy: '/admin_student_view.php', clean: '/admin_student_view' },
      { legacy: '/ricerequirement.php', clean: '/ricerequirement' },
      { legacy: '/rice_report_view.php', clean: '/rice_report_view' },
      { legacy: '/rice_report_panel.php', clean: '/rice_report_panel' },
      { legacy: '/student_update.php', clean: '/student_update' },
      { legacy: '/update_monthly_report.php', clean: '/update_monthly_report' },
      { legacy: '/monthlyreport.php', clean: '/monthlyreport' },
      { legacy: '/monthly_view.php', clean: '/monthly_view' },
      { legacy: '/manage_infrastructure_fields.php', clean: '/manage_infrastructure_fields' },
      { legacy: '/upload_csv.php', clean: '/upload_csv' },
      { legacy: '/admin_upload.php', clean: '/upload_csv' },
      { legacy: '/upload_monthly_report.php', clean: '/upload_monthly_report' },
      { legacy: '/upload_infrastructure.php', clean: '/upload_infrastructure' },
      { legacy: '/closingbalance.php?month=October', clean: '/closingbalance?month=October' }
    ];

    for (const item of legacyPhpPages) {
      const res = await request(item.legacy);
      const ok = res.statusCode === 308 && res.headers.location === item.clean;
      recordResult(
        `Legacy .php redirect: ${item.legacy} -> ${item.clean} (HTTP 308)`,
        ok,
        `HTTP ${res.statusCode} Location: ${res.headers.location}`
      );
    }

    // -------------------------------------------------------------
    // Phase 5: Assets and API Integrity
    // -------------------------------------------------------------
    console.log('\n--- Phase 5: Static Assets (.js/.css) & API Integrity ---');

    const resJsAsset = await request('/supabase-client.js');
    recordResult(
      'Static script asset /supabase-client.js is NOT redirected and serves JS content',
      resJsAsset.statusCode === 200 && resJsAsset.body.includes('fetchSupabaseSchools'),
      `HTTP ${resJsAsset.statusCode}`
    );

    const resApiSchools = await request('/api/schools');
    recordResult(
      'API endpoint /api/schools remains functional and returns 200 JSON',
      resApiSchools.statusCode === 200 && resApiSchools.headers['content-type']?.includes('application/json'),
      `HTTP ${resApiSchools.statusCode}`
    );

    // -------------------------------------------------------------
    // Phase 6: Bengali Text Preservation
    // -------------------------------------------------------------
    console.log('\n--- Phase 6: Bengali UI Text Preservation ---');

    const resMonthlyBengali = await request('/monthlyreport');
    const hasBengaliMonthly = resMonthlyBengali.body.includes('যে মাসের MDCF');
    recordResult(
      'Bengali instructional text preserved on /monthlyreport',
      hasBengaliMonthly,
      'Bengali text found in response'
    );

    const resClosingBengali = await request('/closingbalance');
    const hasBengaliClosing = resClosingBengali.body.includes('যে মাসের MDCF');
    recordResult(
      'Bengali instructional text preserved on /closingbalance',
      hasBengaliClosing,
      'Bengali text found in response'
    );

    // -------------------------------------------------------------
    // Phase 7: Repository Scan - Zero Extension Links in HTML Files
    // -------------------------------------------------------------
    console.log('\n--- Phase 7: Static Inspection - Zero Extension Links in HTML Files ---');

    const htmlFiles = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.html'));
    let foundLegacyHrefs = [];

    for (const file of htmlFiles) {
      const content = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // match href="..." or location = '...' containing .html or .php
        const match = line.match(/(href=["']|location\.(href|replace)\s*=\s*['"])([a-zA-Z0-9_-]+\.(html|php))/);
        if (match) {
          foundLegacyHrefs.push(`${file}:${idx + 1}: ${match[0]}`);
        }
      });
    }

    recordResult(
      'All internal navigation links and redirects in HTML files use clean extensionless URLs',
      foundLegacyHrefs.length === 0,
      foundLegacyHrefs.length === 0 ? '0 legacy references found across all HTML files' : `Found: ${foundLegacyHrefs.join(', ')}`
    );

    // -------------------------------------------------------------
    // Phase 8: Vercel Configuration Verification
    // -------------------------------------------------------------
    console.log('\n--- Phase 8: vercel.json cleanUrls & Redirects Configuration ---');

    const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    const cleanUrlsSet = vercelConfig.cleanUrls === true;
    const hasPhpRedirects = (Array.isArray(vercelConfig.redirects) && vercelConfig.redirects.length > 0) ||
      (Array.isArray(vercelConfig.routes) && vercelConfig.routes.some(r => r.status === 308 && r.headers?.Location));
    const hasNodeBuild = Array.isArray(vercelConfig.builds) && vercelConfig.builds.some(b => b.use === '@vercel/node');

    const redirectCount = (vercelConfig.redirects?.length || 0) + (vercelConfig.routes?.filter(r => r.status === 308).length || 0);

    recordResult(
      'vercel.json has cleanUrls: true configured',
      cleanUrlsSet,
      `cleanUrls = ${vercelConfig.cleanUrls}`
    );
    recordResult(
      'vercel.json has explicit legacy .php 308 redirects configured',
      hasPhpRedirects,
      `Found ${redirectCount} redirect rules`
    );
    recordResult(
      'vercel.json preserves existing @vercel/node build config for api/index.js',
      hasNodeBuild,
      'builds array preserved'
    );

  } catch (err) {
    console.error('Fatal test error:', err);
    recordResult('Execution', false, err.message);
  } finally {
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
    await pool.end();
  }

  console.log('\n================================================================');
  const allPassed = results.every(r => r.passed);
  const passedCount = results.filter(r => r.passed).length;
  console.log(`TEST SUMMARY: ${passedCount}/${results.length} PASSED`);
  if (allPassed) {
    console.log('🎉 ALL CLEAN EXTENSIONLESS URL CHECKS VERIFIED SUCCESSFULLY!');
  } else {
    console.log('❌ SOME TESTS FAILED. PLEASE REVIEW RESULTS ABOVE.');
  }
  console.log('================================================================');

  process.exit(allPassed ? 0 : 1);
}

if (require.main === module) {
  runCleanUrlTests();
}

module.exports = { runCleanUrlTests };
