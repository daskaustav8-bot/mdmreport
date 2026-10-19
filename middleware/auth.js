const jwt = require('jsonwebtoken');
require('dotenv').config();

const COOKIE_NAME = 'admin_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'mdmreport_default_secure_secret_fallback_2026';
const SESSION_EXPIRY = '8h';
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000;

// In-memory rate limiting map: ip -> { count: number, firstAttemptTime: number }
const rateLimitMap = new Map();

function isLocalhost(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function getLimits(ip) {
  if (isLocalhost(ip)) {
    return { maxAttempts: 25, lockoutMs: 30 * 1000 }; // 30 seconds for local admin/testing
  }
  return { maxAttempts: MAX_FAILED_ATTEMPTS, lockoutMs: LOCKOUT_WINDOW_MS };
}

/**
 * Clean up old entries from rate limiter
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    const { lockoutMs } = getLimits(ip);
    if (now - record.firstAttemptTime > lockoutMs) {
      rateLimitMap.delete(ip);
    }
  }
}, 30 * 1000).unref();

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

/**
 * Check if IP is currently rate-limited
 * @param {string} ip
 * @returns {boolean}
 */
function isRateLimited(ip) {
  const record = rateLimitMap.get(ip);
  if (!record) return false;
  const { maxAttempts, lockoutMs } = getLimits(ip);
  if (Date.now() - record.firstAttemptTime > lockoutMs) {
    rateLimitMap.delete(ip);
    return false;
  }
  return record.count >= maxAttempts;
}

/**
 * Record a failed login attempt
 * @param {string} ip
 */
function recordFailedAttempt(ip) {
  const now = Date.now();
  const { lockoutMs } = getLimits(ip);
  const record = rateLimitMap.get(ip);
  if (!record || (now - record.firstAttemptTime > lockoutMs)) {
    rateLimitMap.set(ip, { count: 1, firstAttemptTime: now });
  } else {
    record.count += 1;
  }
}

/**
 * Reset failed attempts upon successful authentication
 * @param {string} ip
 */
function resetFailedAttempts(ip) {
  rateLimitMap.delete(ip);
}

/**
 * Clear all rate limit records
 */
function clearAllRateLimits() {
  rateLimitMap.clear();
}

/**
 * Rate limiting middleware for login endpoints
 */
function loginRateLimiter(req, res, next) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    const record = rateLimitMap.get(ip);
    const { lockoutMs } = getLimits(ip);
    const remainingSeconds = record 
      ? Math.max(1, Math.ceil((lockoutMs - (Date.now() - record.firstAttemptTime)) / 1000))
      : 30;
    const isInfra = req.body?.admin_type === 'infrastructure' || req.originalUrl.includes('infra');
    const msg = isInfra 
      ? `অনেকবার ব্যর্থ প্রচেষ্টার কারণে সাময়িকভাবে স্থগিত করা হয়েছে। অনুগ্রহ করে ${remainingSeconds} সেকেন্ড পর পুনরায় চেষ্টা করুন।`
      : `Too many failed login attempts. Please try again after ${remainingSeconds} seconds.`;
    return res.status(429).json({
      success: false,
      error: msg,
      retryAfter: remainingSeconds
    });
  }
  next();
}

/**
 * Create a signed, scoped JWT session token
 * @param {Object} user
 * @returns {string}
 */
function createSessionToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      admin_type: user.admin_type
    },
    SESSION_SECRET,
    { expiresIn: SESSION_EXPIRY }
  );
}

/**
 * Verify and decode session token
 * @param {string} token
 * @returns {Object|null}
 */
function verifySessionToken(token) {
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Set HttpOnly, Secure, SameSite session cookie
 * @param {Object} res Express response
 * @param {string} token JWT token
 * @param {Object} req Express request
 */
function setSessionCookie(res, token, req) {
  const isSecure = (req && req.secure) || process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  });
}

/**
 * Clear session cookie on logout
 * @param {Object} res Express response
 */
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  });
}

/**
 * Middleware: extracts and verifies session cookie
 */
function sessionMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] || 
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
      ? req.headers.authorization.slice(7) 
      : null);

  if (token) {
    req.session = verifySessionToken(token);
  } else {
    req.session = null;
  }
  next();
}

/**
 * Middleware: enforces authorization for a specific admin type
 * @param {'infrastructure' | 'main'} requiredType
 */
function requireAuth(requiredType) {
  return (req, res, next) => {
    const isAjax = req.xhr || 
      (req.headers.accept && req.headers.accept.includes('application/json')) ||
      (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

    const redirectTarget = requiredType === 'infrastructure' ? '/infra_login' : '/admin_login';

    // 1. Not authenticated
    if (!req.session) {
      if (isAjax) {
        return res.status(401).json({
          success: false,
          authenticated: false,
          error: 'Unauthorized: Authentication required.'
        });
      }
      return res.redirect(redirectTarget);
    }

    // 2. Scoped boundary check: wrong admin type
    if (req.session.admin_type !== requiredType) {
      if (isAjax) {
        return res.status(403).json({
          success: false,
          authenticated: true,
          error: `Forbidden: Access restricted to ${requiredType} administrators.`
        });
      }
      return res.redirect(redirectTarget);
    }

    // 3. Authorized
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  requireAuth,
  loginRateLimiter,
  recordFailedAttempt,
  resetFailedAttempts,
  clearAllRateLimits,
  getClientIp
};
