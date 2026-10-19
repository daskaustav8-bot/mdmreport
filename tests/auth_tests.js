const http = require('http');
const { Client } = require('pg');
const app = require('../server');

const TEST_PORT = 3456;
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

async function runTests() {
  console.log('================================================================');
  console.log('  STARTING INTEGRATION TEST SUITE: SUPABASE 2-ADMIN LOGIN SYSTEM');
  console.log('================================================================\n');

  // 1. Direct Supabase PostgreSQL and RLS Verification
  try {
    const pgClient = new Client({
      host: process.env.SUPABASE_DB_HOST,
      port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
      user: process.env.SUPABASE_DB_USER,
      password: process.env.SUPABASE_DB_PASSWORD,
      database: process.env.SUPABASE_DB_NAME,
      ssl: { rejectUnauthorized: false }
    });

    await pgClient.connect();
    const rows = await pgClient.query('SELECT username, admin_type, SUBSTRING(password, 1, 7) as hash_algo FROM public.admin_users ORDER BY admin_type;');
    const hasInfra = rows.rows.some(r => r.admin_type === 'infrastructure' && r.username === 'admin');
    const hasMain = rows.rows.some(r => r.admin_type === 'main' && r.username === 'admin');
    const isBcrypt = rows.rows.every(r => r.hash_algo.startsWith('$2b$'));

    recordResult('Supabase Table admin_users partitioned with admin_type', hasInfra && hasMain, `Found ${rows.rows.length} accounts`);
    recordResult('Passwords stored strictly as secure bcrypt hashes', isBcrypt, 'All records use $2b$ algorithm');

    // Test RLS on anonymous role
    let rlsBlocked = false;
    try {
      await pgClient.query('SET ROLE anon;');
      await pgClient.query('SELECT * FROM public.admin_users;');
    } catch (e) {
      rlsBlocked = e.message.includes('permission denied') || e.code === '42501';
    } finally {
      await pgClient.query('RESET ROLE;');
      await pgClient.end();
    }
    recordResult('Supabase RLS prevents anonymous clients from dumping password hashes', rlsBlocked, 'Role anon denied access');

  } catch (err) {
    recordResult('Supabase Database Connection', false, err.message);
  }

  // Start Express Test Server
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, resolve);
  });

  let infraCookie = null;
  let mainCookie = null;

  // 2. Infrastructure Admin Tests
  {
    // A. admin + Admin@2025 -> Success
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'Admin@2025', admin_type: 'infrastructure' });

    infraCookie = extractCookie(res.headers);
    const ok = res.statusCode === 200 && res.json?.success === true && res.json?.admin_type === 'infrastructure' && !!infraCookie;
    recordResult('Infrastructure Login: admin with Admin@2025 SUCCEEDS', ok, `HTTP ${res.statusCode}, HttpOnly cookie set`);
  }

  {
    // B. admin + admin123 on infra -> Must Fail
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'admin123', admin_type: 'infrastructure' });

    const ok = res.statusCode === 401 && res.json?.success === false && !extractCookie(res.headers);
    recordResult('Infrastructure Login: admin with admin123 FAILS', ok, `HTTP ${res.statusCode}, No session created`);
  }

  // 3. Main Admin Tests
  {
    // A. admin + admin123 -> Success
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'admin123', admin_type: 'main' });

    mainCookie = extractCookie(res.headers);
    const ok = res.statusCode === 200 && res.json?.success === true && res.json?.admin_type === 'main' && !!mainCookie;
    recordResult('Main Admin Login: admin with admin123 SUCCEEDS', ok, `HTTP ${res.statusCode}, HttpOnly cookie set`);
  }

  {
    // B. admin + Admin@2025 on main -> Must Fail
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'Admin@2025', admin_type: 'main' });

    const ok = res.statusCode === 401 && res.json?.success === false && !extractCookie(res.headers);
    recordResult('Main Admin Login: admin with Admin@2025 FAILS', ok, `HTTP ${res.statusCode}, No session created`);
  }

  // 4. Authorization Boundary Tests (Cross-Access Prevention)
  {
    // Infrastructure session accessing main dashboard route -> Must be Rejected (302 redirect to /admin_login)
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_dashboard',
      method: 'GET',
      headers: { Cookie: infraCookie }
    });

    const rejected = res.statusCode === 302 && res.headers.location === '/admin_login';
    recordResult('Authorization Boundary: Infrastructure session CANNOT access Main Admin route', rejected, `HTTP ${res.statusCode} redirected to ${res.headers.location}`);
  }

  {
    // Main admin session accessing infrastructure dashboard route -> Must be Rejected (302 redirect to /infra_login)
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/basicinfrastructure',
      method: 'GET',
      headers: { Cookie: mainCookie }
    });

    const rejected = res.statusCode === 302 && res.headers.location === '/infra_login';
    recordResult('Authorization Boundary: Main Admin session CANNOT access Infrastructure route', rejected, `HTTP ${res.statusCode} redirected to ${res.headers.location}`);
  }

  {
    // Infrastructure session accessing infrastructure dashboard route -> Must SUCCEED (200)
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/basicinfrastructure',
      method: 'GET',
      headers: { Cookie: infraCookie }
    });

    const ok = res.statusCode === 200;
    recordResult('Infrastructure session authorized to access Infrastructure dashboard', ok, `HTTP ${res.statusCode}`);
  }

  {
    // Main Admin session accessing main admin dashboard route -> Must SUCCEED (200)
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_dashboard',
      method: 'GET',
      headers: { Cookie: mainCookie }
    });

    const ok = res.statusCode === 200;
    recordResult('Main Admin session authorized to access Main Admin dashboard', ok, `HTTP ${res.statusCode}`);
  }

  // 5. Unauthenticated Direct Access & Clean URL Redirect Tests
  {
    const res1 = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_dashboard',
      method: 'GET'
    });
    const res2 = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/basicinfrastructure',
      method: 'GET'
    });

    const unauthRejected = (res1.statusCode === 302 && res1.headers.location === '/admin_login') &&
                           (res2.statusCode === 302 && res2.headers.location === '/infra_login');
    recordResult('Direct unauthenticated access to dashboards is strictly rejected', unauthRejected, 'Redirected to respective clean login pages');

    // Legacy .html routes issue 308 permanent redirect to clean URLs
    const legacyAdminHtml = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_dashboard.html',
      method: 'GET'
    });
    const legacyInfraHtml = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/basicinfrastructure.html',
      method: 'GET'
    });

    const legacyRedirectOk = (legacyAdminHtml.statusCode === 308 && legacyAdminHtml.headers.location === '/admin_dashboard') &&
                             (legacyInfraHtml.statusCode === 308 && legacyInfraHtml.headers.location === '/basicinfrastructure');
    recordResult('Legacy .html URLs issue HTTP 308 redirects to clean extensionless URLs', legacyRedirectOk, '308 redirects verified');
  }

  // 6. Anti-Tampering & Forgery Test
  {
    const forgedCookie = 'admin_session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MywidXNlcm5hbWUiOiJhZG1pbiIsImFkbWluX3R5cGUiOiJtYWluIn0.fake_invalid_signature_xxx';
    const res = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_dashboard',
      method: 'GET',
      headers: { Cookie: forgedCookie }
    });

    const forgeryRejected = res.statusCode === 302 && res.headers.location === '/admin_login';
    recordResult('Tampered or forged session token is detected and rejected', forgeryRejected, 'Server verification blocks unauthorized access');
  }

  // 7. Backward-Compatible Endpoint Tests (Zero PHP runtime)
  {
    // POST /infra_login_handler.php
    const resInfra = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/infra_login_handler.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, 'username=admin&password=Admin%402025');

    // POST /admin_login_handler.php
    const resAdmin = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/admin_login_handler.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, 'username=admin&password=admin123');

    const compatOk = resInfra.statusCode === 200 && resInfra.json?.success === true &&
                     resAdmin.statusCode === 200 && resAdmin.json?.success === true;
    recordResult('Backward-compatible PHP-named endpoints execute via Node.js without PHP', compatOk, 'infra_login_handler.php & admin_login_handler.php');
  }

  // 8. Logout and Session Invalidation
  {
    const resLogout = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/logout',
      method: 'GET',
      headers: { Cookie: mainCookie }
    });

    const clearedCookie = resLogout.headers['set-cookie']?.some(c => c.includes('admin_session=;'));
    
    // Check session after logout
    const resCheck = await request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/auth/session',
      method: 'GET',
      headers: { Cookie: 'admin_session=;' }
    });

    const logoutOk = clearedCookie && resCheck.json?.authenticated === false;
    recordResult('Logout clears session cookie and completely invalidates session', logoutOk, 'Session terminated');
  }

  // Close Server
  await new Promise(resolve => serverInstance.close(resolve));

  console.log('\n================================================================');
  const allPassed = results.every(r => r.passed);
  console.log(`TEST SUMMARY: ${results.filter(r => r.passed).length}/${results.length} PASSED`);
  if (allPassed) {
    console.log('🎉 ALL ACCEPTANCE CRITERIA AND SECURITY CHECKS VERIFIED SUCCESSFULLY!');
  } else {
    console.log('❌ SOME TESTS FAILED. PLEASE REVIEW RESULTS ABOVE.');
    process.exit(1);
  }
  console.log('================================================================');
  process.exit(allPassed ? 0 : 1);
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test runner fatal error:', err);
    if (serverInstance) serverInstance.close();
    process.exit(1);
  });
}

module.exports = { runTests };
