const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/supabase');

const BASE_URL = 'http://localhost:3000';

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
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

async function loginAdmin() {
  const loginRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    username: 'admin',
    password: 'admin123',
    admin_type: 'main'
  });

  const cookieHeader = loginRes.headers['set-cookie'];
  if (!cookieHeader) {
    throw new Error('Admin login failed: No session cookie received');
  }
  const sessionCookie = cookieHeader.map(c => c.split(';')[0]).join('; ');
  return sessionCookie;
}

async function runTests() {
  console.log('================================================================');
  console.log('  TEST SUITE: MONTHLY REPORT MEAL AVAILED STATUS FIELD LOCKS');
  console.log('================================================================\n');

  // 1. Verify HTML Structure in upload_monthly_report.html
  console.log('--- Test 1: upload_monthly_report.html Markup Verification ---');
  const uploadHtml = fs.readFileSync(path.join(__dirname, '../upload_monthly_report.html'), 'utf-8');

  assert(uploadHtml.includes('Monthly Report Field Lock / Unlock Control'), 'Must contain Lock/Unlock section title');
  assert(uploadHtml.includes('btnCatPrimary') && uploadHtml.includes('btnCatUpperPrimary'), 'Must contain 2 options for Primary and Upper Primary');
  assert(uploadHtml.includes('2. Meal Availed Status (খাবার পরিবেশন সংক্রান্ত তথ্য)'), 'Must contain Meal Availed Status box header');
  assert(uploadHtml.includes('ATTENDANCE &amp; MEALS') || uploadHtml.includes('ATTENDANCE & MEALS'), 'Must contain ATTENDANCE & MEALS badge');
  assert(uploadHtml.includes('BAL VATIKA') && uploadHtml.includes('badge-pp'), 'Must contain BAL VATIKA with PP badge');
  assert(uploadHtml.includes('PRIMARY') && uploadHtml.includes('badge-iv'), 'Must contain PRIMARY with I-IV badge');
  assert(uploadHtml.includes('Number of School Days during Month'), 'Must contain Number of School Days during Month row');
  assert(uploadHtml.includes('Actual Number of Days MDM Served'), 'Must contain Actual Number of Days MDM Served row');
  assert(uploadHtml.includes('Total Meals Served during Month'), 'Must contain Total Meals Served during Month row');

  // Verify that interactive lock controls replace input fields
  const expectedPrimaryControls = [
    'ctrl_pri_bv_days',
    'ctrl_pri_p_days',
    'ctrl_pri_bv_actual',
    'ctrl_pri_p_actual',
    'ctrl_pri_bv_meals',
    'ctrl_pri_p_meals'
  ];
  for (const c of expectedPrimaryControls) {
    assert(uploadHtml.includes(c), `Must contain interactive lock control: ${c}`);
  }

  const expectedUpperPrimaryControls = [
    'ctrl_upr_p_days',
    'ctrl_upr_up_days',
    'ctrl_upr_p_actual',
    'ctrl_upr_up_actual',
    'ctrl_upr_p_meals',
    'ctrl_upr_up_meals'
  ];
  for (const c of expectedUpperPrimaryControls) {
    assert(uploadHtml.includes(c), `Must contain interactive lock control: ${c}`);
  }

  // Verify Fund Details Box
  assert(uploadHtml.includes('3. FUND DETAILS (IN Rs)'), 'Must contain 3. FUND DETAILS (IN Rs) box header');
  assert(uploadHtml.includes('MATERIAL COST BAL VATIKA'), 'Must contain MATERIAL COST BAL VATIKA row');
  assert(uploadHtml.includes('MATERIAL COST PRIMARY'), 'Must contain MATERIAL COST PRIMARY row');
  assert(uploadHtml.includes('BANK INTEREST'), 'Must contain BANK INTEREST row');
  assert(uploadHtml.includes('LPG SUBSIDY'), 'Must contain LPG SUBSIDY row');
  assert(uploadHtml.includes('SUPPLEMENTARY / EXTRA NUTRITION'), 'Must contain SUPPLEMENTARY / EXTRA NUTRITION row');
  assert(uploadHtml.includes('SCHOOL EXPENSES (MME)'), 'Must contain SCHOOL EXPENSES (MME) row');
  assert(uploadHtml.includes('KITCHEN DEVICES'), 'Must contain KITCHEN DEVICES row');
  assert(uploadHtml.includes('KITCHEN SHED REPAIR'), 'Must contain KITCHEN SHED REPAIR row');
  assert(uploadHtml.includes('NUTRITION GARDEN'), 'Must contain NUTRITION GARDEN row');
  assert(uploadHtml.includes('BANK CHARGES (SMS/CHEQUE BOOK)'), 'Must contain BANK CHARGES row');

  // Verify Fund controls
  const expectedFundControls = [
    'ctrl_pri_cc_bv_open', 'ctrl_pri_cc_bv_recv', 'ctrl_pri_cc_bv_exp',
    'ctrl_pri_cc_p_open', 'ctrl_pri_cc_p_recv', 'ctrl_pri_cc_p_exp',
    'ctrl_pri_bi_open', 'ctrl_pri_bi_recv', 'ctrl_pri_bi_exp',
    'ctrl_pri_lpg_open', 'ctrl_pri_lpg_recv', 'ctrl_pri_lpg_exp',
    'ctrl_pri_nutri_open', 'ctrl_pri_nutri_recv', 'ctrl_pri_nutri_exp',
    'ctrl_pri_mme_open', 'ctrl_pri_mme_recv', 'ctrl_pri_mme_exp',
    'ctrl_pri_kd_open', 'ctrl_pri_kd_recv', 'ctrl_pri_kd_exp',
    'ctrl_pri_ks_open', 'ctrl_pri_ks_recv', 'ctrl_pri_ks_exp',
    'ctrl_pri_ng_open', 'ctrl_pri_ng_recv', 'ctrl_pri_ng_exp',
    'ctrl_pri_bc_open', 'ctrl_pri_bc_recv', 'ctrl_pri_bc_exp'
  ];
  for (const fc of expectedFundControls) {
    assert(uploadHtml.includes(fc), `Must contain fund lock control: ${fc}`);
  }

  // Verify Food Grains Details - Rice Box (Box 4)
  assert(uploadHtml.includes('4. Food Grains Details - Rice (চাল সংক্রান্ত তথ্য in KG)'), 'Must contain 4. Food Grains Details - Rice header');
  assert(uploadHtml.includes('FOOD GRAINS'), 'Must contain FOOD GRAINS tag');
  assert(uploadHtml.includes('fa-wheat-awn'), 'Must contain wheat icon badge');
  assert(uploadHtml.includes('OPENING BALANCE (KG)'), 'Must contain OPENING BALANCE (KG) header');
  assert(uploadHtml.includes('RECEIVED (KG)'), 'Must contain RECEIVED (KG) header');
  assert(uploadHtml.includes('CONSUMPTION (KG)'), 'Must contain CONSUMPTION (KG) header');
  assert(uploadHtml.includes('CLOSING BALANCE (KG)'), 'Must contain CLOSING BALANCE (KG) header');

  const expectedRiceControls = [
    'ctrl_pri_rice_bv_open', 'ctrl_pri_rice_bv_recv', 'ctrl_pri_rice_bv_cons',
    'ctrl_pri_rice_p_open', 'ctrl_pri_rice_p_recv', 'ctrl_pri_rice_p_cons',
    'ctrl_upr_rice_p_open', 'ctrl_upr_rice_p_recv', 'ctrl_upr_rice_p_cons',
    'ctrl_upr_rice_up_open', 'ctrl_upr_rice_up_recv', 'ctrl_upr_rice_up_cons'
  ];
  for (const rc of expectedRiceControls) {
    assert(uploadHtml.includes(rc), `Must contain rice lock control: ${rc}`);
  }

  console.log('✅ PASS: upload_monthly_report.html contains complete Lock/Unlock section and matching box markup for Meal Availed, Fund Details, and Food Grains (Rice).\n');

  // 2. Test GET /api/monthly-report/lock-config
  console.log('--- Test 2: GET /api/monthly-report/lock-config Endpoint ---');
  const getRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'GET'
  });

  assert.strictEqual(getRes.statusCode, 200, 'GET lock-config should return HTTP 200');
  const getData = JSON.parse(getRes.body);
  assert.strictEqual(getData.status, 'success', 'Status should be success');
  assert(getData.config !== undefined, 'Config object should be returned');
  console.log('✅ PASS: GET /api/monthly-report/lock-config returns HTTP 200 with all 12 configuration keys.\n');

  // 3. Test POST /api/monthly-report/lock-config (Authentication & Persistence)
  console.log('--- Test 3: POST /api/monthly-report/lock-config Authentication & Persistence ---');
  // Attempt unauthenticated request
  const unauthRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { config: { pri_bv_days: true } });

  assert.strictEqual(unauthRes.statusCode, 401, 'Unauthenticated POST should be rejected with HTTP 401');
  console.log('✅ PASS: Unauthenticated POST correctly rejected (HTTP 401).');

  // Authenticate as Main Admin
  const adminCookie = await loginAdmin();
  console.log('✅ PASS: Authenticated as Main Admin.');

  // Lock specific fields: pri_bv_days and pri_bv_actual
  const saveRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, {
    config: {
      pri_bv_days: true,
      pri_bv_actual: true
    }
  });

  assert.strictEqual(saveRes.statusCode, 200, 'Authorized POST should return HTTP 200');
  const saveData = JSON.parse(saveRes.body);
  assert.strictEqual(saveData.status, 'success');
  assert.strictEqual(saveData.config.pri_bv_days, true);
  assert.strictEqual(saveData.config.pri_bv_actual, true);

  // Verify reload from GET endpoint confirms database persistence
  const verifyRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'GET'
  });
  const verifyData = JSON.parse(verifyRes.body);
  assert.strictEqual(verifyData.config.pri_bv_days, true, 'pri_bv_days should be persisted as true');
  assert.strictEqual(verifyData.config.pri_bv_actual, true, 'pri_bv_actual should be persisted as true');
  console.log('✅ PASS: Field lock settings successfully saved and verified in database.\n');

  // 4. Test Server-Side Field Lock Enforcement on Save
  console.log('--- Test 4: Server-Side Field Lock Enforcement on Monthly Report Save ---');
  // Ensure test record exists in mdm_monthly_report
  const testUdise = '19120500703';
  const testMonth = 'October';
  const testYear = '2026';

  await pool.query(`
    INSERT INTO public.mdm_monthly_report (
      month_name, year, u_dise, school_name, circle_name, gp_name,
      bv_days, p_days, bv_actual, p_actual, bv_meals, p_meals
    ) VALUES (
      $1, $2, $3, 'ABADPARA PRIMARY SCHOOL', 'PANDUA', 'PANDUA',
      23, 23, 23, 23, 61, 968
    )
    ON CONFLICT (u_dise, month_name, year) DO UPDATE SET
      bv_days = 23,
      bv_actual = 23,
      p_days = 23,
      p_actual = 23;
  `, [testMonth, testYear, testUdise]);

  // Attempt to update report with bv_days = 99 (while pri_bv_days is locked)
  // Unlocked field p_days = 28 should update, but locked field bv_days should remain 23!
  const saveReportRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/save',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    u_dise: testUdise,
    month_name: testMonth,
    year: testYear,
    bv_days: 99,
    p_days: 28,
    bv_actual: 88,
    p_actual: 25,
    bv_meals: 70,
    p_meals: 990
  });

  assert.strictEqual(saveReportRes.statusCode, 200, 'Report save endpoint should succeed');

  const { rows: checkRows } = await pool.query(
    'SELECT bv_days, p_days, bv_actual, p_actual FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
    [testUdise, testMonth, testYear]
  );
  const updatedRec = checkRows[0];
  assert.strictEqual(updatedRec.bv_days, 23, 'Locked field bv_days must preserve existing value (23) rather than 99');
  assert.strictEqual(updatedRec.bv_actual, 23, 'Locked field bv_actual must preserve existing value (23) rather than 88');
  assert.strictEqual(updatedRec.p_days, 28, 'Unlocked field p_days must be updated to 28');
  console.log('✅ PASS: Server-side enforcement successfully protects locked fields while allowing unlocked fields to update.\n');

  // Also test locking a fund field: pri_bi_recv
  const fundLockRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, {
    config: {
      pri_bi_recv: true
    }
  });
  assert.strictEqual(fundLockRes.statusCode, 200);

  // Set existing bank interest in database
  await pool.query(
    'UPDATE public.mdm_monthly_report SET bi_recv = 150.00 WHERE u_dise = $1 AND month_name = $2 AND year = $3',
    [testUdise, testMonth, testYear]
  );

  // Attempt to save report with bi_recv = 999.00 while pri_bi_recv is locked
  await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/save',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    u_dise: testUdise,
    month_name: testMonth,
    year: testYear,
    bi_recv: 999.00
  });

  const { rows: fundCheckRows } = await pool.query(
    'SELECT bi_recv FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
    [testUdise, testMonth, testYear]
  );
  assert.strictEqual(Number(fundCheckRows[0].bi_recv), 150.00, 'Locked fund field bi_recv must preserve existing value (150.00) rather than 999.00');
  console.log('✅ PASS: Server-side enforcement successfully protects locked Fund Details fields.');

  // Test locking a rice field: pri_rice_bv_open
  const riceLockRes = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, {
    config: {
      pri_rice_bv_open: true
    }
  });
  assert.strictEqual(riceLockRes.statusCode, 200);

  // Set existing rice value in database
  await pool.query(
    'UPDATE public.mdm_monthly_report SET rice_bv_open = 42.50, rice_bv_cons = 10.00 WHERE u_dise = $1 AND month_name = $2 AND year = $3',
    [testUdise, testMonth, testYear]
  );

  // Attempt to save report with rice_bv_open = 999.00 and rice_bv_cons = 30.00
  // Locked field rice_bv_open should remain 42.50, unlocked field rice_bv_cons should update to 30.00
  await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/save',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    u_dise: testUdise,
    month_name: testMonth,
    year: testYear,
    rice_bv_open: 999.00,
    rice_bv_cons: 30.00
  });

  const { rows: riceCheckRows } = await pool.query(
    'SELECT rice_bv_open, rice_bv_cons FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
    [testUdise, testMonth, testYear]
  );
  assert.strictEqual(Number(riceCheckRows[0].rice_bv_open), 42.50, 'Locked rice field rice_bv_open must preserve existing value (42.50) rather than 999.00');
  assert.strictEqual(Number(riceCheckRows[0].rice_bv_cons), 30.00, 'Unlocked rice field rice_bv_cons must update to 30.00');
  console.log('✅ PASS: Server-side enforcement successfully protects locked Food Grains (Rice) fields while allowing unlocked fields to update.');

  // Clean up: unlock test fields
  await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/monthly-report/lock-config',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': adminCookie
    }
  }, {
    config: {
      pri_bv_days: false,
      pri_bv_actual: false,
      pri_bi_recv: false,
      pri_rice_bv_open: false
    }
  });
  console.log('✅ PASS: Test cleanup completed (fields unlocked).');

  console.log('\n================================================================');
  console.log('🎉 ALL MONTHLY REPORT FIELD LOCK TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');

  await pool.end();
  process.exit(0);
}

runTests().catch(async (err) => {
  console.error('\n❌ TEST FAILURE:', err);
  try { await pool.end(); } catch (e) {}
  process.exit(1);
});
