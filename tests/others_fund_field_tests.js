const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/supabase');

async function runTests() {
  console.log('================================================================');
  console.log('  TEST SUITE: OTHERS FIELD IN FUND DETAILS (update_monthly_report.html)');
  console.log('================================================================\n');

  // 1. Verify update_monthly_report.html Markup
  console.log('--- Test 1: HTML Markup in update_monthly_report.html ---');
  const htmlContent = fs.readFileSync(path.join(__dirname, '../update_monthly_report.html'), 'utf8');

  // Check section order: BANK CHARGES must appear BEFORE OTHERS
  const bcIndex = htmlContent.indexOf('BANK CHARGES (SMS/CHEQUE BOOK)');
  const othIndex = htmlContent.indexOf('<td>OTHERS</td>');
  const totalIndex = htmlContent.indexOf('GRAND TOTAL (₹)');

  assert(bcIndex !== -1, 'BANK CHARGES (SMS/CHEQUE BOOK) section must exist');
  assert(othIndex !== -1, 'OTHERS section must exist');
  assert(totalIndex !== -1, 'GRAND TOTAL section must exist');

  assert(bcIndex < othIndex, 'OTHERS must be positioned after BANK CHARGES');
  assert(othIndex < totalIndex, 'OTHERS must be positioned before GRAND TOTAL');

  // Check inputs existence and attributes
  assert(htmlContent.includes('id="oth_open"'), 'oth_open input must exist');
  assert(htmlContent.includes('id="oth_recv"'), 'oth_recv input must exist');
  assert(htmlContent.includes('id="oth_exp"'), 'oth_exp input must exist');
  assert(htmlContent.includes('id="oth_close"'), 'oth_close input must exist');
  assert(htmlContent.includes('data-group="oth"'), 'data-group="oth" must exist');

  // Check JavaScript references in update_monthly_report.html
  assert(htmlContent.includes("'oth'"), 'fundFieldGroups must include "oth"');
  assert(htmlContent.includes("$('#oth_open').val("), 'oth_open must be populated on load');
  assert(htmlContent.includes("oth_open: $('#oth_open').val()"), 'oth_open must be included in save payload');

  console.log('✅ PASS: HTML markup and JS references correctly placed in update_monthly_report.html.\n');

  // 2. Test API Save & Retrieve with Others Field
  console.log('--- Test 2: API Save and Retrieve with Others Field ---');
  const testUdise = '19180100101'; // Valid school UDISE
  const testMonth = 'October';
  const testYear = '2026';

  const testPayload = {
    u_dise: testUdise,
    month_name: testMonth,
    year: testYear,
    school_name: 'TEST SCHOOL FOR OTHERS FIELD',
    circle_name: 'TEST CIRCLE',
    gp_name: 'TEST GP',
    bc_open: 15.00,
    bc_recv: 0.00,
    bc_exp: 15.00,
    bc_close: 0.00,
    oth_open: 2500.50,
    oth_recv: 1000.00,
    oth_exp: 750.25,
    oth_close: 2750.25
  };

  const saveRes = await fetch('http://localhost:3000/api/monthly-report/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testPayload)
  });

  const saveJson = await saveRes.json();
  assert.strictEqual(saveRes.status, 200, 'Save response should be HTTP 200');
  assert.strictEqual(saveJson.status, 'success', 'Save status should be success');
  console.log('✅ PASS: Saved report containing Others field.');

  // Fetch report via GET
  const getRes = await fetch(`http://localhost:3000/api/monthly-report?u_dise=${testUdise}&month_name=${testMonth}&year=${testYear}`);
  const getJson = await getRes.json();
  assert.strictEqual(getRes.status, 200, 'Get response should be HTTP 200');
  assert.strictEqual(getJson.status, 'success', 'Get status should be success');

  const report = getJson.data;
  assert.strictEqual(parseFloat(report.oth_open), 2500.50, 'oth_open must match');
  assert.strictEqual(parseFloat(report.oth_recv), 1000.00, 'oth_recv must match');
  assert.strictEqual(parseFloat(report.oth_exp), 750.25, 'oth_exp must match');
  assert.strictEqual(parseFloat(report.oth_close), 2750.25, 'oth_close must match');

  const fj = typeof report.fund_details_json === 'string' ? JSON.parse(report.fund_details_json) : report.fund_details_json;
  assert(fj && fj.others, 'fund_details_json must contain others');
  assert.strictEqual(fj.others.open, 2500.50, 'fund_details_json.others.open must match');
  assert.strictEqual(fj.others.recv, 1000.00, 'fund_details_json.others.recv must match');
  assert.strictEqual(fj.others.exp, 750.25, 'fund_details_json.others.exp must match');
  assert.strictEqual(fj.others.close, 2750.25, 'fund_details_json.others.close must match');
  console.log('✅ PASS: GET /api/monthly-report returned correct oth columns and fund_details_json.others data.');

  // Clean up test report
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3', [testUdise, testMonth, testYear]);
  console.log('✅ PASS: Test report cleanup completed.\n');

  console.log('================================================================');
  console.log('🎉 ALL OTHERS FUND FIELD TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================');
  await pool.end();
}

runTests().catch(err => {
  console.error('❌ Test Failure:', err);
  process.exit(1);
});
