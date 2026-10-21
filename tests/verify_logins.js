const http = require('http');

function postLogin(user, pass, type) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ username: user, password: pass, admin_type: type });
    const req = http.request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, cookie: res.headers['set-cookie'], data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, cookie: res.headers['set-cookie'], raw: body });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getWithCookie(path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://localhost:3000' + path, {
      method: 'GET',
      headers: {
        'Cookie': cookie ? cookie[0] : ''
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, bodySnippet: body.slice(0, 80) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function verifyAll() {
  console.log('=== VERIFYING LOCAL LOGIN SUITE ===\n');

  // Test 1: Main Admin with admin123
  console.log('1. Main Admin (admin / admin123):');
  const m1 = await postLogin('admin', 'admin123', 'main');
  console.log('   Status:', m1.status, 'Success:', m1.data?.success, 'Redirect:', m1.data?.redirect);
  const m1Page = await getWithCookie('/admin_dashboard', m1.cookie);
  console.log('   /admin_dashboard access:', m1Page.status === 200 ? 'OK (200)' : 'FAILED (' + m1Page.status + ')');
  const m1Session = await getWithCookie('/api/auth/session?admin_type=main', m1.cookie);
  console.log('   /api/auth/session check:', m1Session.status === 200 ? 'OK (200)' : 'FAILED (' + m1Session.status + ')');

  // Test 2: Main Admin with Admin@2025
  console.log('\n2. Main Admin (admin / Admin@2025):');
  const m2 = await postLogin('admin', 'Admin@2025', 'main');
  console.log('   Status:', m2.status, 'Success:', m2.data?.success);

  // Test 3: Infrastructure Admin with admin123
  console.log('\n3. Infrastructure Admin (admin / admin123):');
  const i1 = await postLogin('admin', 'admin123', 'infrastructure');
  console.log('   Status:', i1.status, 'Success:', i1.data?.success, 'Redirect:', i1.data?.redirect);
  const i1Page = await getWithCookie('/basicinfrastructure', i1.cookie);
  console.log('   /basicinfrastructure access:', i1Page.status === 200 ? 'OK (200)' : 'FAILED (' + i1Page.status + ')');
  const i1Session = await getWithCookie('/api/auth/session?admin_type=infrastructure', i1.cookie);
  console.log('   /api/auth/session check:', i1Session.status === 200 ? 'OK (200)' : 'FAILED (' + i1Session.status + ')');

  // Test 4: Infrastructure Admin with Admin@2025
  console.log('\n4. Infrastructure Admin (admin / Admin@2025):');
  const i2 = await postLogin('admin', 'Admin@2025', 'infrastructure');
  console.log('   Status:', i2.status, 'Success:', i2.data?.success);

  console.log('\n=== ALL TESTS COMPLETED ===');
}

verifyAll().catch(console.error);
