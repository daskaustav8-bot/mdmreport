const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer();
const { findAdminUser, verifyPassword, updateLastLogin } = require('../db/supabase');
const {
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  loginRateLimiter,
  recordFailedAttempt,
  resetFailedAttempts,
  getClientIp
} = require('../middleware/auth');

/**
 * Common Login Handler
 */
async function handleLogin(req, res, forcedType = null) {
  const ip = getClientIp(req);

  const username = typeof req.body?.username === 'string' 
    ? req.body.username.trim() 
    : (typeof req.query?.username === 'string' ? req.query.username.trim() : '');
  const password = typeof req.body?.password === 'string' 
    ? req.body.password 
    : (typeof req.query?.password === 'string' ? req.query.password : '');
  const adminType = forcedType || (typeof req.body?.admin_type === 'string' 
    ? req.body.admin_type.trim() 
    : (typeof req.query?.admin_type === 'string' ? req.query.admin_type.trim() : ''));

  const isInfra = adminType === 'infrastructure' || req.originalUrl.includes('infra');
  const genericError = isInfra ? 'ভুল ইউজারনেম বা পাসওয়ার্ড!' : 'Invalid Username or Password!';

  // Input validation
  if (!username || !password || !['infrastructure', 'main'].includes(adminType)) {
    recordFailedAttempt(ip);
    return res.status(400).json({
      success: false,
      error: genericError
    });
  }

  try {
    // 1. Identify user strictly scoped by both admin_type AND username
    const user = await findAdminUser(username, adminType);

    // 2. Verify password against stored bcrypt hash in Supabase
    const isValid = await verifyPassword(password, user ? user.password : null);

    if (!isValid || !user) {
      recordFailedAttempt(ip);
      return res.status(401).json({
        success: false,
        error: genericError
      });
    }

    // 3. Successful authentication: reset rate limiter, update timestamp
    resetFailedAttempts(ip);
    await updateLastLogin(user.id);

    // 4. Generate scoped session token and attach HttpOnly cookie
    const token = createSessionToken(user);
    setSessionCookie(res, token, req);

    const redirectPath = user.admin_type === 'infrastructure' ? '/basicinfrastructure' : '/admin_dashboard';

    return res.status(200).json({
      success: true,
      authenticated: true,
      username: user.username,
      admin_type: user.admin_type,
      circle_name: 'Pandua Block Admin',
      redirect: redirectPath
    });

  } catch (err) {
    console.error('Login error in handleLogin:', err.message);
    return res.status(500).json({
      success: false,
      error: 'An internal error occurred during authentication.'
    });
  }
}

/**
 * Common Session Check Handler
 */
function handleSessionCheck(req, res, expectedType = null) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (!req.session) {
    return res.json({ authenticated: false });
  }

  const queryType = expectedType || req.query.admin_type;
  if (queryType && req.session.admin_type !== queryType) {
    return res.json({
      authenticated: false,
      error: 'Session exists for different admin scope.'
    });
  }

  const redirectPath = req.session.admin_type === 'infrastructure' ? '/basicinfrastructure' : '/admin_dashboard';

  return res.json({
    authenticated: true,
    username: req.session.username,
    admin_type: req.session.admin_type,
    circle_name: 'Pandua Block Admin',
    redirect: redirectPath
  });
}

/**
 * Common Logout Handler
 */
function handleLogout(req, res) {
  clearSessionCookie(res);

  const reqType = req.query.type || (req.originalUrl.includes('infra') ? 'infrastructure' : 'main');
  const redirectTarget = reqType === 'infrastructure' ? '/infra_login' : '/admin_login';

  const isAjax = req.xhr || 
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

  if (isAjax) {
    return res.json({
      success: true,
      message: 'Logged out successfully',
      redirect: redirectTarget
    });
  }

  return res.redirect(redirectTarget);
}

// ==========================================
// Standard API Endpoints
// ==========================================
router.post('/login', upload.none(), loginRateLimiter, (req, res) => handleLogin(req, res));
router.get('/session', (req, res) => handleSessionCheck(req, res));
router.all('/logout', (req, res) => handleLogout(req, res));

// ==========================================
// Backward-Compatible Endpoints (Zero PHP)
// ==========================================
// Infrastructure
router.post('/infra_login_handler.php', upload.none(), loginRateLimiter, (req, res) => handleLogin(req, res, 'infrastructure'));
router.get('/infra_login_handler.php', (req, res) => {
  if (req.query.action === 'check_session' || req.query.check !== undefined) {
    return handleSessionCheck(req, res, 'infrastructure');
  }
  return res.redirect(req.session?.admin_type === 'infrastructure' ? '/basicinfrastructure' : '/infra_login');
});
router.get('/infra_session_check.php', (req, res) => handleSessionCheck(req, res, 'infrastructure'));

// Main Admin
router.post('/admin_login_handler.php', upload.none(), loginRateLimiter, (req, res) => handleLogin(req, res, 'main'));
router.get('/admin_login_handler.php', (req, res) => {
  if (req.query.action === 'check_session' || req.query.check !== undefined) {
    return handleSessionCheck(req, res, 'main');
  }
  return res.redirect(req.session?.admin_type === 'main' ? '/admin_dashboard' : '/admin_login');
});
router.get('/admin_session_check.php', (req, res) => handleSessionCheck(req, res, 'main'));

// Logout
router.all('/logout.php', (req, res) => handleLogout(req, res));

module.exports = {
  router,
  handleLogin,
  handleSessionCheck,
  handleLogout
};
