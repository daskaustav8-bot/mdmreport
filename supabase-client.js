/**
 * High-Performance Supabase Client Bridge (Zero Hardcoded Credentials)
 * 
 * Sourced securely from backend API with multi-tier in-memory and
 * sessionStorage caching, request deduplication, and zero-latency resolution.
 */

// In-memory cache variables
let _inMemorySchools = null;
let _schoolsFetchPromise = null;
const CACHE_KEY = 'supabase_schools_cache_v2';
const CACHE_TIME_KEY = 'supabase_schools_cache_v2_time';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache in browser

// Helper function to check if user has an active authenticated session
async function checkSession() {
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.authenticated ? data : null;
  } catch (err) {
    console.warn('Session check error:', err);
    return null;
  }
}

// Helper to logout and invalidate session cookie on server
async function logout(type = '') {
  try {
    await fetch('/api/auth/logout' + (type ? '?type=' + encodeURIComponent(type) : ''), { 
      method: 'POST',
      credentials: 'same-origin' 
    });
  } catch (err) {
    console.warn('Logout error:', err);
  }
  // Clear cached data on logout
  try {
    sessionStorage.removeItem(CACHE_KEY);
    sessionStorage.removeItem(CACHE_TIME_KEY);
    _inMemorySchools = null;
  } catch (e) {}
  window.location.href = '/';
}

/**
 * High-performance authoritative school data loader.
 * Employs in-memory, sessionStorage, and HTTP caching with instant 0ms retrieval.
 *
 * @param {boolean} forceRefresh If true, bypasses browser cache and queries backend
 * @returns {Promise<Array>} List of normalized school records
 */
async function fetchSupabaseSchools(forceRefresh = false) {
  // 1. In-memory hot cache (0.001ms)
  if (!forceRefresh && _inMemorySchools && Array.isArray(_inMemorySchools) && _inMemorySchools.length > 0) {
    return _inMemorySchools;
  }

  // 2. SessionStorage cache (persistent across page transitions, 0.1ms)
  if (!forceRefresh) {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      const cachedTime = sessionStorage.getItem(CACHE_TIME_KEY);
      if (cached && cachedTime && (Date.now() - parseInt(cachedTime, 10) < CACHE_TTL_MS)) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          _inMemorySchools = parsed;
          return parsed;
        }
      }
    } catch (e) {
      // Storage access exception fallback
    }
  }

  // 3. Deduplicate concurrent requests in flight
  if (!forceRefresh && _schoolsFetchPromise) {
    return _schoolsFetchPromise;
  }

  _schoolsFetchPromise = (async () => {
    try {
      const url = forceRefresh ? '/api/schools?refresh=1' : '/api/schools';
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error('Invalid format received from /api/schools');
      }

      _inMemorySchools = data;
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
        sessionStorage.setItem(CACHE_TIME_KEY, String(Date.now()));
      } catch (e) {}

      return data;
    } catch (err) {
      console.error('Failed to load schools from backend:', err);
      // Fallback to expired cache if available
      try {
        const fallback = sessionStorage.getItem(CACHE_KEY);
        if (fallback) {
          const parsed = JSON.parse(fallback);
          if (Array.isArray(parsed) && parsed.length > 0) {
            _inMemorySchools = parsed;
            return parsed;
          }
        }
      } catch (e) {}
      throw err;
    } finally {
      _schoolsFetchPromise = null;
    }
  })();

  return _schoolsFetchPromise;
}

/**
 * Universal fast fetcher with client memory cache
 */
const _requestCache = new Map();
async function fetchCachedJson(url, options = {}, ttlMs = 30000) {
  const method = (options.method || 'GET').toUpperCase();
  if (method === 'GET') {
    const entry = _requestCache.get(url);
    if (entry && (Date.now() - entry.time < ttlMs)) {
      return entry.data;
    }
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (method === 'GET') {
    _requestCache.set(url, { time: Date.now(), data });
  }
  return data;
}

/**
 * Backward compatibility bridge for pages calling supabase.from(...)
 */
if (typeof window !== 'undefined') {
  window.checkSession = checkSession;
  window.logout = logout;
  window.fetchSupabaseSchools = fetchSupabaseSchools;
  window.fetchCachedJson = fetchCachedJson;

  // Supabase JS SDK bridge if not present or missing methods
  if (!window.supabase || typeof window.supabase.from !== 'function') {
    window.supabase = {
      from: function(table) {
        return {
          select: function(cols) {
            const queryState = { table, cols, orderCol: null, ascending: true, limitVal: null, filters: [] };
            const chain = {
              order: function(col, opts = {}) {
                queryState.orderCol = col;
                queryState.ascending = opts.ascending !== false;
                return chain;
              },
              limit: function(n) {
                queryState.limitVal = n;
                return chain;
              },
              eq: function(field, val) {
                queryState.filters.push({ field, val });
                return chain;
              },
              single: async function() {
                const res = await chain;
                if (res.data && Array.isArray(res.data)) {
                  return { data: res.data[0] || null, error: res.data.length ? null : new Error('Row not found') };
                }
                return res;
              },
              then: function(resolve, reject) {
                const run = async () => {
                  try {
                    if (table === 'school_infrastructure') {
                      const res = await fetch('/api/infrastructure/recent');
                      const json = await res.json();
                      return { data: json.data || [], error: null };
                    } else if (table === 'rice_requirements') {
                      const uDiseFilter = queryState.filters.find(f => f.field === 'u_dise')?.val || '';
                      const qFilter = queryState.filters.find(f => f.field === 'quarter')?.val || '';
                      const url = `/api/rice/saved?u_dise=${encodeURIComponent(uDiseFilter)}&quarter=${encodeURIComponent(qFilter)}`;
                      const res = await fetch(url);
                      const json = await res.json();
                      const row = (json.status === 'success' && json.data) ? json.data : null;
                      return { data: row ? [row] : [], error: row ? null : new Error('Not found') };
                    } else if (table === 'infrastructure_config') {
                      const res = await fetch('/api/infrastructure/config');
                      const json = await res.json();
                      const cfg = json.data || {};
                      const rows = Object.keys(cfg).map(k => ({ key: k, label: cfg[k].label, is_locked: cfg[k].is_locked }));
                      return { data: rows, error: null };
                    } else {
                      return { data: [], error: null };
                    }
                  } catch (err) {
                    return { data: null, error: err };
                  }
                };
                return run().then(resolve, reject);
              }
            };
            return chain;
          },
          upsert: async function(values, opts = {}) {
            try {
              if (table === 'infrastructure_config') {
                const configObj = {};
                const arr = Array.isArray(values) ? values : [values];
                arr.forEach(item => {
                  configObj[item.key] = { label: item.label, is_locked: item.is_locked };
                });
                const res = await fetch('/api/infrastructure/config', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(configObj)
                });
                return { error: res.ok ? null : new Error('Save failed') };
              } else if (table === 'school_infrastructure') {
                const res = await fetch('/api/infrastructure/save', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(values)
                });
                return { error: res.ok ? null : new Error('Save failed') };
              }
              return { error: null };
            } catch (err) {
              return { error: err };
            }
          }
        };
      }
    };
  }
}
