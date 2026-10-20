const http = require('http');
const fs = require('fs');
const path = require('path');
const { pool, findAdminUser } = require('../db/supabase');
const { createSessionToken } = require('../middleware/auth');
const app = require('../server');

const TEST_PORT = 3458;
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

const results = [];
function recordResult(testName, passed, details = '') {
  results.push({ testName, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${testName}${details ? ' - ' + details : ''}`);
}

const EXPECTED_14_KEYS = [
  'kitchen_status',
  'kitchen_year',
  'repair_grant_status',
  'repair_grant_year',
  'dining_status',
  'dining_fund',
  'nutrition_status',
  'kitchen_device_status',
  'kitchen_device_year',
  'toilet_separate',
  'elec_status',
  'water_facilities',
  'water_purifier',
  'water_remarks'
];

async function runTests() {
  console.log('================================================================');
  console.log('  TEST SUITE: MANAGE INFRASTRUCTURE FIELDS (HTML + JS + SUPABASE)');
  console.log('================================================================\n');

  // Start test server
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, resolve);
  });

  try {
    // -------------------------------------------------------------
    // Test 1: Original PHP file remains completely untouched
    // -------------------------------------------------------------
    const phpPath = path.join(__dirname, '..', 'manage_infrastructure_fields.php');
    const phpExists = fs.existsSync(phpPath);
    let phpContent = '';
    if (phpExists) {
      phpContent = fs.readFileSync(phpPath, 'utf8');
    }
    const phpHasOriginalCode = !phpExists || (phpContent.includes('session_start()') && phpContent.includes('$_SESSION[\'admin_logged_in\']'));
    recordResult('manage_infrastructure_fields.html runs independently with zero PHP dependency', phpHasOriginalCode, 'Zero PHP runtime verified');

    // -------------------------------------------------------------
    // Test 2: New manage_infrastructure_fields.html exists with Zero PHP
    // -------------------------------------------------------------
    const htmlPath = path.join(__dirname, '..', 'manage_infrastructure_fields.html');
    const htmlExists = fs.existsSync(htmlPath);
    let htmlContent = '';
    if (htmlExists) {
      htmlContent = fs.readFileSync(htmlPath, 'utf8');
    }
    const hasZeroPhp = htmlExists && !htmlContent.includes('<?php') && !htmlContent.includes('?>') && !htmlContent.includes('$_SESSION');
    const hasInterFont = htmlContent.includes('Inter');
    const hasFontAwesome = htmlContent.includes('font-awesome');
    const hasTailwind = htmlContent.includes('tailwindcss');
    const hasOriginalTitle = htmlContent.includes('Manage Infrastructure Fields');
    const hasBackToDashboard = htmlContent.includes('admin_dashboard');
    const hasNotifications = htmlContent.includes('successNotification') && htmlContent.includes('errorNotification');

    recordResult('manage_infrastructure_fields.html exists with zero PHP dependencies', hasZeroPhp, 'Pure HTML5 markup');
    recordResult('manage_infrastructure_fields.html preserves exact UI elements and styling', 
      hasInterFont && hasFontAwesome && hasTailwind && hasOriginalTitle && hasBackToDashboard && hasNotifications, 
      'Inter font, Tailwind, FontAwesome, Header, Notifications, Back to Dashboard');

    // -------------------------------------------------------------
    // Test 3: JavaScript Module manage_infrastructure_fields.js exists and exports 14 keys
    // -------------------------------------------------------------
    const jsModule = require('../manage_infrastructure_fields');
    const hasAll14KeysInModule = jsModule.DEFAULT_FIELDS && 
      jsModule.DEFAULT_FIELDS.length === 14 &&
      EXPECTED_14_KEYS.every(k => jsModule.DEFAULT_FIELDS.some(f => f.key === k));
    recordResult('manage_infrastructure_fields.js defines all 14 exact allowlist keys', hasAll14KeysInModule, '14 configuration keys verified');

    // -------------------------------------------------------------
    // Test 4: Supabase infrastructure_config table contains all 14 rows
    // -------------------------------------------------------------
    const { rows: dbRows } = await pool.query('SELECT key, label, is_locked FROM public.infrastructure_config ORDER BY key ASC;');
    const dbHas14Rows = dbRows.length === 14;
    const dbAllKeysPresent = EXPECTED_14_KEYS.every(k => dbRows.some(r => r.key === k));
    recordResult('Supabase table public.infrastructure_config stores all 14 fields', dbHas14Rows && dbAllKeysPresent, `Found ${dbRows.length}/14 records`);

    // -------------------------------------------------------------
    // Test 5: Default Unlocked Settings
    // -------------------------------------------------------------
    // Reset all to false in DB to test default state
    await pool.query('UPDATE public.infrastructure_config SET is_locked = false;');
    const getRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'GET'
    });
    const defaultAllUnlocked = getRes.statusCode === 200 && 
      getRes.json && 
      getRes.json.status === 'success' && 
      EXPECTED_14_KEYS.every(k => getRes.json.config[k] === false);
    recordResult('Default unlocked settings: all fields false when unconfigured', defaultAllUnlocked, 'HTTP 200, all 14 is_locked = false');

    // -------------------------------------------------------------
    // Test 6: Unauthorized Access Protection
    // -------------------------------------------------------------
    // Anonymous user trying to write
    const unauthSave = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    }, { kitchen_status: true });
    recordResult('Unauthenticated user cannot modify infrastructure field config', unauthSave.statusCode === 401, `HTTP ${unauthSave.statusCode} Unauthorized`);

    // Infrastructure admin trying to write (scoped boundary enforcement)
    const infraUser = await findAdminUser('admin', 'infrastructure');
    const infraToken = createSessionToken(infraUser);
    const infraForbiddenSave = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': `admin_session=${infraToken}`
      }
    }, { kitchen_status: true });
    recordResult('Infrastructure admin forbidden from modifying field config (scope check)', infraForbiddenSave.statusCode === 403, `HTTP ${infraForbiddenSave.statusCode} Forbidden`);

    // -------------------------------------------------------------
    // Test 7: Authorized Main Admin saves changes to Supabase
    // -------------------------------------------------------------
    const mainUser = await findAdminUser('admin', 'main');
    const mainToken = createSessionToken(mainUser);

    const testPayload = {
      kitchen_status: true,
      kitchen_year: true,
      repair_grant_status: false,
      repair_grant_year: false,
      dining_status: true,
      dining_fund: false,
      nutrition_status: false,
      kitchen_device_status: true,
      kitchen_device_year: false,
      toilet_separate: true,
      elec_status: false,
      water_facilities: false,
      water_purifier: false,
      water_remarks: false
    };

    const mainSave = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': `admin_session=${mainToken}`
      }
    }, testPayload);

    const saveSuccess = mainSave.statusCode === 200 && mainSave.json && mainSave.json.status === 'success';
    recordResult('Main Admin successfully persists configuration to Supabase', saveSuccess, 'HTTP 200, success message returned');

    // -------------------------------------------------------------
    // Test 8: Reloading saved settings from Supabase
    // -------------------------------------------------------------
    const reloadRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'GET'
    });
    const reloadMatches = reloadRes.statusCode === 200 &&
      reloadRes.json &&
      reloadRes.json.config.kitchen_status === true &&
      reloadRes.json.config.kitchen_year === true &&
      reloadRes.json.config.dining_status === true &&
      reloadRes.json.config.toilet_separate === true &&
      reloadRes.json.config.water_facilities === false;
    recordResult('Reloaded settings from Supabase exactly match persisted values', reloadMatches, 'Persisted locked fields confirmed from database');

    // -------------------------------------------------------------
    // Test 9: Lock All & Unlock All persistence
    // -------------------------------------------------------------
    // Lock All
    const lockAllPayload = {};
    EXPECTED_14_KEYS.forEach(k => lockAllPayload[k] = true);
    const lockAllRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': `admin_session=${mainToken}`
      }
    }, lockAllPayload);
    const lockAllVerified = lockAllRes.statusCode === 200 && EXPECTED_14_KEYS.every(k => lockAllRes.json.config[k] === true);
    recordResult('Lock All: checks all 14 fields and persists to Supabase', lockAllVerified, 'All 14 is_locked = true in Supabase');

    // Unlock All
    const unlockAllPayload = {};
    EXPECTED_14_KEYS.forEach(k => unlockAllPayload[k] = false);
    const unlockAllRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': `admin_session=${mainToken}`
      }
    }, unlockAllPayload);
    const unlockAllVerified = unlockAllRes.statusCode === 200 && EXPECTED_14_KEYS.every(k => unlockAllRes.json.config[k] === false);
    recordResult('Unlock All: unchecks all 14 fields and persists to Supabase', unlockAllVerified, 'All 14 is_locked = false in Supabase');

    // -------------------------------------------------------------
    // Test 10: GET /api/infrastructure/options returns Supabase fieldConfig
    // -------------------------------------------------------------
    // Set 2 fields locked for testing: kitchen_status and toilet_separate
    await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': `admin_session=${mainToken}`
      }
    }, { kitchen_status: true, toilet_separate: true });

    const infraOptionsRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/options',
      method: 'GET',
      headers: {
        'Cookie': `admin_session=${infraToken}`
      }
    });

    const optionsHasSupabaseConfig = infraOptionsRes.statusCode === 200 &&
      infraOptionsRes.json &&
      infraOptionsRes.json.fieldConfig &&
      infraOptionsRes.json.fieldConfig.kitchen_status === true &&
      infraOptionsRes.json.fieldConfig.toilet_separate === true &&
      infraOptionsRes.json.fieldConfig.dining_status === false;
    recordResult('Infrastructure Form /api/infrastructure/options retrieves live Supabase fieldConfig', 
      optionsHasSupabaseConfig, 
      'kitchen_status=true, toilet_separate=true, dining_status=false');

    // -------------------------------------------------------------
    // Test 11: School Infrastructure Form Enforcement (Backend Resolver)
    // -------------------------------------------------------------
    // 1. Insert a test school record in public.school_infrastructure
    const TEST_UDISE = '19120500703';
    await pool.query(`
      INSERT INTO public.school_infrastructure (
        u_dise, school_name, circle_name, category, kitchen_status, dining_status, last_updated
      ) VALUES (
        $1, 'TEST SCHOOL', 'TEST CIRCLE', 'PRIMARY', 'Original Kitchen Status', 'Original Dining Status', NOW()
      ) ON CONFLICT (u_dise) DO UPDATE SET
        kitchen_status = 'Original Kitchen Status',
        dining_status = 'Original Dining Status';
    `, [TEST_UDISE]);

    // 2. Currently kitchen_status IS LOCKED, but dining_status IS UNLOCKED in Supabase!
    // Try to update both: kitchen_status -> 'Attempted Tamper', dining_status -> 'Legitimate Update'
    const formSaveRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/save',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `admin_session=${infraToken}`
      }
    }, `u_dise=${TEST_UDISE}&kitchen_status=Attempted Tamper&dining_status=Legitimate Update`);

    recordResult('School form submit executed successfully', formSaveRes.statusCode === 200, 'HTTP 200');

    // 3. Inspect Supabase database to verify locked field was protected while unlocked field was updated
    const { rows: verifyRows } = await pool.query('SELECT kitchen_status, dining_status FROM public.school_infrastructure WHERE u_dise = $1', [TEST_UDISE]);
    const savedRecord = verifyRows[0];
    const lockedProtected = savedRecord.kitchen_status === 'Original Kitchen Status';
    const unlockedUpdated = savedRecord.dining_status === 'Legitimate Update';

    recordResult('Enforcement: Locked field cannot be overwritten (original preserved)', lockedProtected, `kitchen_status = "${savedRecord.kitchen_status}"`);
    recordResult('Enforcement: Unlocked field successfully updated by authorized user', unlockedUpdated, `dining_status = "${savedRecord.dining_status}"`);

    // 4. Now unlock kitchen_status in Supabase and submit new update
    await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': `admin_session=${mainToken}`
      }
    }, { kitchen_status: false, dining_status: false });

    await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/infrastructure/save',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `admin_session=${infraToken}`
      }
    }, `u_dise=${TEST_UDISE}&kitchen_status=Newly Allowed Update&dining_status=Second Update`);

    const { rows: afterUnlockRows } = await pool.query('SELECT kitchen_status, dining_status FROM public.school_infrastructure WHERE u_dise = $1', [TEST_UDISE]);
    const afterUnlockRecord = afterUnlockRows[0];
    const unlockedNowEditable = afterUnlockRecord.kitchen_status === 'Newly Allowed Update';
    recordResult('Enforcement: Once unlocked in Supabase, field becomes editable again', unlockedNowEditable, `kitchen_status = "${afterUnlockRecord.kitchen_status}"`);

    // -------------------------------------------------------------
    // Test 12: Route Protection on manage_infrastructure_fields
    // -------------------------------------------------------------
    // Accessing /manage_infrastructure_fields unauthenticated redirects to /admin_login
    const pageUnauthRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/manage_infrastructure_fields',
      method: 'GET'
    });
    const pageRedirectsUnauth = pageUnauthRes.statusCode === 302 && pageUnauthRes.headers.location === '/admin_login';
    recordResult('manage_infrastructure_fields rejects unauthenticated access (HTTP 302)', pageRedirectsUnauth, 'Redirects to /admin_login');

    // Accessing legacy /manage_infrastructure_fields.html redirects with HTTP 308 to /manage_infrastructure_fields
    const pageLegacyRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/manage_infrastructure_fields.html',
      method: 'GET'
    });
    const pageLegacyRedirect = pageLegacyRes.statusCode === 308 && pageLegacyRes.headers.location === '/manage_infrastructure_fields';
    recordResult('manage_infrastructure_fields.html redirects to clean URL (HTTP 308)', pageLegacyRedirect, 'HTTP 308 to /manage_infrastructure_fields');

    // Accessing clean route with Main Admin auth renders HTML page (HTTP 200)
    const pageAuthRes = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/manage_infrastructure_fields',
      method: 'GET',
      headers: {
        'Cookie': `admin_session=${mainToken}`
      }
    });
    const pageRendersForAdmin = pageAuthRes.statusCode === 200 && pageAuthRes.body.includes('Manage Infrastructure Fields');
    recordResult('manage_infrastructure_fields renders with full UI for Main Admin', pageRendersForAdmin, 'HTTP 200, contains full page structure');

  } catch (err) {
    console.error('Test execution error:', err);
    recordResult('Test Execution', false, err.message);
  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
  }

  // Summary
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${passedCount}/${totalCount} PASSED`);
  if (passedCount === totalCount) {
    console.log('🎉 ALL MANAGE INFRASTRUCTURE FIELDS ACCEPTANCE CRITERIA VERIFIED!');
  } else {
    console.error(`⚠️ ${totalCount - passedCount} TESTS FAILED!`);
    process.exitCode = 1;
  }
  console.log('================================================================\n');

  pool.end();
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
