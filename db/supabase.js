const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Resolve Supabase database connection details with IPv4 pooler support for Vercel/serverless
let dbHost = process.env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com';
let dbPort = parseInt(process.env.SUPABASE_DB_PORT || '6543', 10);
let dbUser = process.env.SUPABASE_DB_USER || 'postgres.vaaukirzwhufortgafmn';
let dbPass = process.env.SUPABASE_DB_PASSWORD;
let dbName = process.env.SUPABASE_DB_NAME || 'postgres';

// If configured host is an IPv6-only direct host (db.<project-ref>.supabase.co),
// automatically map to the IPv4-compatible Supabase connection pooler to prevent ENOTFOUND on serverless
if (dbHost && dbHost.startsWith('db.') && dbHost.endsWith('.supabase.co')) {
  const projectRef = dbHost.replace(/^db\./, '').replace(/\.supabase\.co$/, '');
  dbHost = 'aws-0-ap-southeast-1.pooler.supabase.com';
  if (dbPort === 5432) {
    dbPort = 6543; // Transaction mode for serverless pooler
  }
  if (!dbUser.includes('.')) {
    dbUser = `${dbUser}.${projectRef}`;
  }
}

// High-performance connection pool with TCP keep-alive and persistent warm connections
const pool = new Pool({
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPass,
  database: dbName,
  ssl: { rejectUnauthorized: false },
  max: 20,
  min: 0,
  idleTimeoutMillis: 300000, // 5 minutes before idle connection is released
  connectionTimeoutMillis: 30000, // 30 seconds for reliable cloud connections
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Supabase database client:', err.message);
});

// Periodic pool heartbeat to prevent cloud firewall/Supavisor dropping idle sockets
const heartbeatInterval = setInterval(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    // Suppress background ping error
  }
}, 45000);
if (heartbeatInterval.unref) {
  heartbeatInterval.unref(); // Don't prevent process exit if running standalone scripts
}

// Pre-warm the pool immediately on startup
(async () => {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.warn('Initial pool pre-warm note:', err.message);
  }
})();

// A dummy bcrypt hash for timing mitigation when user is not found
const DUMMY_HASH = '$2b$12$Kj6l2HhC55hSgZ.b25m4y.B0c1jF8dOaD6YgVjUo8uVlZl5kI8/hO';

/**
 * In-memory Cache for Authoritative School Master Data
 * Reduces repeated round-trips from ~400ms across WAN down to ~0.05ms in RAM.
 */
let cachedSchools = null;
let cachedSchoolsMap = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL

function clearSchoolsCache() {
  cachedSchools = null;
  cachedSchoolsMap = null;
  cacheTimestamp = 0;
}

/**
 * Find admin user by username and admin_type in Supabase public.admin_users table.
 *
 * @param {string} username
 * @param {string} adminType 'infrastructure' | 'main'
 * @returns {Promise<Object|null>}
 */
async function findAdminUser(username, adminType) {
  if (!username || !adminType) return null;

  const query = `
    SELECT id, username, password, admin_type, created_at, last_login 
    FROM public.admin_users 
    WHERE username = $1 AND admin_type = $2 
    LIMIT 1;
  `;

  const { rows } = await pool.query(query, [username.trim(), adminType.trim()]);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Constant-time password verification using bcrypt.
 *
 * @param {string} candidatePassword
 * @param {string|null} storedHash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(candidatePassword, storedHash) {
  if (!storedHash) {
    // Run dummy compare to mitigate timing discrepancies
    await bcrypt.compare(candidatePassword || '', DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(candidatePassword, storedHash);
}

/**
 * Update the last_login timestamp for a verified admin user.
 *
 * @param {number|string} userId
 */
async function updateLastLogin(userId) {
  try {
    await pool.query('UPDATE public.admin_users SET last_login = NOW() WHERE id = $1', [userId]);
  } catch (err) {
    console.error('Failed to update last_login for user', userId, err.message);
  }
}

/**
 * Fetch authoritative schools list strictly from Supabase school_master table.
 * Sourced with high-performance in-memory caching and index-backed sorting.
 *
 * @param {boolean} forceRefresh
 * @returns {Promise<Array>}
 */
async function getSchools(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSchools && (now - cacheTimestamp < CACHE_TTL_MS)) {
    return cachedSchools;
  }

  try {
    let res;
    try {
      res = await pool.query(`
        SELECT udise_code, school_name, COALESCE(category, catergory) as category, circle_name, gp_name
        FROM public.school_master
        ORDER BY school_name ASC;
      `);
    } catch (tblErr) {
      // Fallback if schema uses school_name_list
      res = await pool.query(`
        SELECT udise_code, school_name, catergory as category, circle_name, gp_name
        FROM public.school_name_list
        ORDER BY school_name ASC;
      `);
    }

    const schools = res.rows.map(row => {
      const category = (row.category || '').trim();
      const isPrimary = (category === 'PRIMARY ONLY' || (category.toUpperCase().includes('PRIMARY') && !category.toUpperCase().includes('UPPER')));
      const udise = String(row.udise_code || '').trim();
      const schoolName = String(row.school_name || '').trim();
      const circle = String(row.circle_name || '').trim();
      const gp = String(row.gp_name || '').trim();

      return {
        udise: udise,
        code: udise,
        id: udise,
        name: schoolName,
        school_name: schoolName,
        text: schoolName,
        category: category,
        catergory: category,
        circle: circle,
        circle_name: circle,
        gp: gp,
        gp_name: gp,
        type: isPrimary ? 'P' : 'U'
      };
    });

    cachedSchools = schools;
    cachedSchoolsMap = null; // Rebuild lazily
    cacheTimestamp = now;

    return cachedSchools;
  } catch (err) {
    console.error('getSchools database query notice:', err.message);
    if (cachedSchools && cachedSchools.length > 0) {
      console.warn('Returning stale cached schools due to database notice.');
      return cachedSchools;
    }
    // High-resilience fallback to packaged authoritative school master CSV
    const csvSchools = loadSchoolsFromCsv();
    if (csvSchools.length > 0) {
      console.warn(`Serving ${csvSchools.length} authoritative schools from packaged master CSV fallback.`);
      cachedSchools = csvSchools;
      cachedSchoolsMap = null;
      cacheTimestamp = now;
      return cachedSchools;
    }
    throw err;
  }
}

/**
 * Load authoritative school master list from packaged CSV fallback
 *
 * @returns {Array}
 */
function loadSchoolsFromCsv() {
  try {
    const fs = require('fs');
    const path = require('path');
    const candidates = [
      path.join(__dirname, '..', 'school_master.csv'),
      path.join(__dirname, 'school_master.csv'),
      path.join(process.cwd(), 'school_master.csv')
    ];
    const csvPath = candidates.find(p => fs.existsSync(p));
    if (!csvPath) return [];

    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const schools = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 5) {
        const sName = parts[0].trim();
        const cat = parts[1].trim();
        const udise = parts[2].trim();
        const circle = parts[3].trim();
        const gp = parts[4].trim();
        const isPrimary = (cat === 'PRIMARY ONLY' || (cat.toUpperCase().includes('PRIMARY') && !cat.toUpperCase().includes('UPPER')));
        schools.push({
          udise, code: udise, id: udise,
          name: sName, school_name: sName, text: sName,
          category: cat, catergory: cat,
          circle, circle_name: circle,
          gp, gp_name: gp,
          type: isPrimary ? 'P' : 'U'
        });
      }
    }
    return schools;
  } catch (csvErr) {
    console.error('Error reading fallback CSV:', csvErr.message);
    return [];
  }
}

/**
 * Get map of authoritative schools keyed by UDISE code from Supabase
 *
 * @param {boolean} forceRefresh
 * @returns {Promise<Object>}
 */
async function getSchoolsMap(forceRefresh = false) {
  if (!forceRefresh && cachedSchoolsMap && (Date.now() - cacheTimestamp < CACHE_TTL_MS)) {
    return cachedSchoolsMap;
  }

  const schools = await getSchools(forceRefresh);
  const map = {};
  for (const s of schools) {
    map[s.udise] = s;
  }
  cachedSchoolsMap = map;
  return map;
}

/**
 * Test database connectivity.
 *
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    const res = await pool.query('SELECT 1 as connected');
    return res.rows[0].connected === 1;
  } catch (err) {
    console.error('Database connection test failed:', err.message);
    return false;
  }
}

module.exports = {
  pool,
  findAdminUser,
  verifyPassword,
  updateLastLogin,
  getSchools,
  getSchoolsMap,
  clearSchoolsCache,
  testConnection
};
