const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const upload = multer();
require('dotenv').config();

const { router: authRouter, handleLogin, handleSessionCheck, handleLogout } = require('./routes/auth');
const { sessionMiddleware, requireAuth, loginRateLimiter } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Parsing Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);

// =========================================================================
// Legacy Extension URL Redirection Middleware (Page routes -> Clean URLs)
// Preserves query strings (e.g. ?month=October) with HTTP 308
// =========================================================================
const LEGACY_PAGE_REDIRECTS = {
  // Legacy .html pages
  '/index.html': '/',
  '/admin_login.html': '/admin_login',
  '/infra_login.html': '/infra_login',
  '/admin_dashboard.html': '/admin_dashboard',
  '/basicinfrastructure.html': '/basicinfrastructure',
  '/infrastructure.html': '/infrastructure',
  '/admin_rice_view.html': '/admin_rice_view',
  '/admin_student_view.html': '/admin_student_view',
  '/upload_csv.html': '/upload_csv',
  '/admin_upload.html': '/admin_upload',
  '/upload_monthly_report.html': '/upload_monthly_report',
  '/upload_infrastructure.html': '/upload_infrastructure',
  '/manage_infrastructure_fields.html': '/manage_infrastructure_fields',
  '/ricerequirement.html': '/ricerequirement',
  '/rice_report_view.html': '/rice_report_view',
  '/rice_report_panel.html': '/rice_report_panel',
  '/rice_report_detail.html': '/rice_report_detail',
  '/status_table.html': '/status_table',
  '/student_update.html': '/student_update',
  '/update_monthly_report.html': '/update_monthly_report',
  '/monthlyreport.html': '/monthlyreport',
  '/monthly_view.html': '/monthly_view',
  '/closingbalance.html': '/closingbalance',

  // Legacy .php pages
  '/index.php': '/',
  '/infrastructure.php': '/infrastructure',
  '/basicinfrastructure.php': '/basicinfrastructure',
  '/admin_login.php': '/admin_login',
  '/infra_login.php': '/infra_login',
  '/admin_dashboard.php': '/admin_dashboard',
  '/admin_rice_view.php': '/admin_rice_view',
  '/admin_student_view.php': '/admin_student_view',
  '/ricerequirement.php': '/ricerequirement',
  '/rice_report_view.php': '/rice_report_view',
  '/rice_report_panel.php': '/rice_report_panel',
  '/student_update.php': '/student_update',
  '/update_monthly_report.php': '/update_monthly_report',
  '/monthlyreport.php': '/monthlyreport',
  '/monthly_view.php': '/monthly_view',
  '/manage_infrastructure_fields.php': '/manage_infrastructure_fields'
};

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }
  const cleanTarget = LEGACY_PAGE_REDIRECTS[req.path];
  if (cleanTarget) {
    const queryIdx = req.url.indexOf('?');
    const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
    return res.redirect(308, cleanTarget + queryString);
  }
  // GET /closingbalance.php without render=report_body -> redirect to /closingbalance
  if (req.path === '/closingbalance.php' && req.query.render !== 'report_body') {
    const queryIdx = req.url.indexOf('?');
    const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
    return res.redirect(308, '/closingbalance' + queryString);
  }
  // GET /upload_csv.php or /admin_upload.php -> /upload_csv
  if (req.path === '/upload_csv.php' || req.path === '/admin_upload.php') {
    const queryIdx = req.url.indexOf('?');
    const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
    return res.redirect(308, '/upload_csv' + queryString);
  }
  // GET /upload_monthly_report.php -> /upload_monthly_report
  if (req.path === '/upload_monthly_report.php') {
    const queryIdx = req.url.indexOf('?');
    const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
    return res.redirect(308, '/upload_monthly_report' + queryString);
  }
  // GET /upload_infrastructure.php -> /upload_infrastructure
  if (req.path === '/upload_infrastructure.php') {
    const queryIdx = req.url.indexOf('?');
    const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
    return res.redirect(308, '/upload_infrastructure' + queryString);
  }
  next();
});

// Authentication API Router
app.use('/api/auth', authRouter);

// Application Data Router (Schools, Infrastructure, Rice Reports)
const dataRouter = require('./routes/data');
app.use('/api', dataRouter);
app.use('/', dataRouter);

// Direct Backward-Compatible Authentication Endpoints (Zero PHP)
app.post('/infra_login_handler.php', upload.none(), loginRateLimiter, (req, res) => handleLogin(req, res, 'infrastructure'));
app.get('/infra_login_handler.php', (req, res) => {
  if (req.query.action === 'check_session' || req.query.check !== undefined) {
    return handleSessionCheck(req, res, 'infrastructure');
  }
  return res.redirect(req.session?.admin_type === 'infrastructure' ? '/basicinfrastructure' : '/infra_login');
});
app.get('/infra_session_check.php', (req, res) => handleSessionCheck(req, res, 'infrastructure'));

app.post('/admin_login_handler.php', upload.none(), loginRateLimiter, (req, res) => handleLogin(req, res, 'main'));
app.get('/admin_login_handler.php', (req, res) => {
  if (req.query.action === 'check_session' || req.query.check !== undefined) {
    return handleSessionCheck(req, res, 'main');
  }
  return res.redirect(req.session?.admin_type === 'main' ? '/admin_dashboard' : '/admin_login');
});
app.get('/admin_session_check.php', (req, res) => handleSessionCheck(req, res, 'main'));

app.all('/logout.php', (req, res) => handleLogout(req, res));
app.all('/logout', (req, res) => handleLogout(req, res));

// =========================================================================
// Server-Side Protected Dashboard & Management Routes (Clean Extensionless)
// =========================================================================

// 1. Infrastructure Admin Scope
app.get(['/basicinfrastructure', '/infrastructure'], requireAuth('infrastructure'), (req, res) => {
  res.sendFile(path.join(__dirname, 'basicinfrastructure.html'));
});

// 2. Main Admin Scope
app.get(['/admin_dashboard', '/admin-dashboard'], requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin_dashboard.html'));
});
app.get(['/admin_rice_view', '/admin-rice-view'], requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin_rice_view.html'));
});
app.get(['/admin_student_view', '/admin-student-view'], requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'admin_student_view.html'));
});
app.get(['/upload_csv', '/upload-csv', '/admin_upload', '/admin-upload'], requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'upload_csv.html'));
});
app.get(['/upload_monthly_report', '/upload-monthly-report'], requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'upload_monthly_report.html'));
});
app.get(['/upload_infrastructure', '/upload-infrastructure'], requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'upload_infrastructure.html'));
});
app.get('/manage_infrastructure_fields', requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'manage_infrastructure_fields.html'));
});
app.get('/rice_report_detail', requireAuth('main'), (req, res) => {
  res.sendFile(path.join(__dirname, 'rice_report_detail.html'));
});

// =========================================================================
// Public Report & Form Routes (Clean Extensionless)
// =========================================================================
app.get('/ricerequirement', (req, res) => {
  res.sendFile(path.join(__dirname, 'ricerequirement.html'));
});

app.get('/rice_report_view', (req, res) => {
  res.sendFile(path.join(__dirname, 'rice_report_view.html'));
});

app.get(['/rice_report_panel', '/rice-report-panel'], (req, res) => {
  res.sendFile(path.join(__dirname, 'rice_report_panel.html'));
});

app.get('/status_table', (req, res) => {
  res.sendFile(path.join(__dirname, 'status_table.html'));
});

app.get('/student_update', (req, res) => {
  res.sendFile(path.join(__dirname, 'student_update.html'));
});

app.get('/update_monthly_report', (req, res) => {
  res.sendFile(path.join(__dirname, 'update_monthly_report.html'));
});

app.get('/monthlyreport', (req, res) => {
  res.sendFile(path.join(__dirname, 'monthlyreport.html'));
});

app.get('/monthly_view', (req, res) => {
  res.sendFile(path.join(__dirname, 'monthly_view.html'));
});

app.get('/closingbalance', (req, res) => {
  res.sendFile(path.join(__dirname, 'closingbalance.html'));
});

// =========================================================================
// Public Login & Informational Routes (Clean Extensionless)
// =========================================================================
app.get(['/infra_login', '/infra-login'], (req, res) => {
  if (req.session?.admin_type === 'infrastructure') {
    return res.redirect('/basicinfrastructure');
  }
  res.sendFile(path.join(__dirname, 'infra_login.html'));
});

app.get(['/admin_login', '/admin-login'], (req, res) => {
  if (req.session?.admin_type === 'main') {
    return res.redirect('/admin_dashboard');
  }
  res.sendFile(path.join(__dirname, 'admin_login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const fs = require('fs');

// Explicit Static Asset Handlers with strict MIME types and caching (Never return text/html for scripts)
app.get('/supabase-client.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const candidates = [
    path.join(__dirname, 'supabase-client.js'),
    path.join(__dirname, '..', 'supabase-client.js'),
    path.join(process.cwd(), 'supabase-client.js')
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    return res.sendFile(found);
  }
  return res.status(404).type('application/javascript').send('// supabase-client.js not found');
});

app.get('/manage_infrastructure_fields.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const candidates = [
    path.join(__dirname, 'manage_infrastructure_fields.js'),
    path.join(__dirname, '..', 'manage_infrastructure_fields.js'),
    path.join(process.cwd(), 'manage_infrastructure_fields.js')
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    return res.sendFile(found);
  }
  return res.status(404).type('application/javascript').send('// manage_infrastructure_fields.js not found');
});

app.get('/style.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const candidates = [
    path.join(__dirname, 'style.css'),
    path.join(__dirname, '..', 'style.css'),
    path.join(process.cwd(), 'style.css')
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    return res.sendFile(found);
  }
  return res.status(404).type('text/css').send('/* style.css not found */');
});

// Serve remaining static assets (CSS, JS, images)
app.use(express.static(__dirname));

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).send('Page not found');
});

// Start server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`- Infrastructure Admin Login: http://localhost:${PORT}/infra_login`);
    console.log(`- Main Admin Login: http://localhost:${PORT}/admin_login`);
  });
}

module.exports = app;
