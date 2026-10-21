const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { pool, getSchools, getSchoolsMap, clearSchoolsCache } = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');

// Multer memory storage for parsing CSV uploads in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

// Helper for CSV row parsing (handles quotes, commas, CRLF)
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows = [];
  for (const line of lines) {
    const row = [];
    let insideQuotes = false;
    let entry = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          entry += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        row.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    row.push(entry.trim());
    rows.push(row);
  }
  return rows;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[^0-9\-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function toFloat(v) {
  if (v === null || v === undefined || v === '') return 0.0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0.0 : Math.round(n * 100) / 100;
}

function extractUdise(str) {
  if (!str) return '';
  const match = String(str).match(/\(([^)]+)\)/);
  if (match) return match[1].trim();
  const digits = String(str).replace(/\D/g, '');
  if (digits.length >= 10) return digits;
  return String(str).trim();
}

// ==========================================
// 1. Authoritative Schools Master List (Strictly Supabase)
// ==========================================
async function handleSchoolsList(req, res) {
  try {
    const forceRefresh = req.query?.refresh === 'true' || req.query?.refresh === '1';
    const schools = await getSchools(forceRefresh);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(schools);
  } catch (err) {
    console.error('Error loading schools from Supabase:', err.message);
    res.status(502).json({ status: 'error', message: 'Failed to load authoritative school master data from Supabase: ' + err.message });
  }
}

router.get('/schools', handleSchoolsList);
router.get('/get_schools.php', handleSchoolsList);
router.get('/get_schools', handleSchoolsList);
router.get('/student-schools', handleSchoolsList);
router.get('/get_student_schools.php', handleSchoolsList);
router.get('/get_student_schools', handleSchoolsList);

// ==========================================
// 2. Infrastructure Options & Config
// ==========================================
const INFRA_FIELDS = [
  { key: 'kitchen_status', label: 'Kitchen cum Store Status' },
  { key: 'kitchen_year', label: 'Kitchen Store Construction Year' },
  { key: 'repair_grant_status', label: 'Kitchen cum Store Repairing Grant Rs. 10000/- (10 years) received status' },
  { key: 'repair_grant_year', label: 'Repairing Grant (Rs. 10000/-) Receive Year' },
  { key: 'dining_status', label: 'Dining Hall Status' },
  { key: 'dining_fund', label: 'Dining Hall Fund sanctioned from' },
  { key: 'nutrition_status', label: 'Nutrition Garden Status' },
  { key: 'kitchen_device_status', label: 'Kitchen Device Status' },
  { key: 'kitchen_device_year', label: 'Kitchen Device Replacement Grant receive Year' },
  { key: 'toilet_separate', label: 'Separate Toilet for Boys and Girls' },
  { key: 'elec_status', label: 'Electric Connection Status' },
  { key: 'water_facilities', label: 'Drinking Water Facilities' },
  { key: 'water_purifier', label: 'Water Purifier' },
  { key: 'water_remarks', label: 'Remarks (if Any Requirement)' }
];

async function handleGetInfraConfig(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT key, label, is_locked, updated_at FROM public.infrastructure_config ORDER BY key ASC'
    );
    const configMap = {};
    rows.forEach(r => {
      configMap[r.key] = Boolean(r.is_locked);
    });

    for (const f of INFRA_FIELDS) {
      if (configMap[f.key] === undefined) {
        configMap[f.key] = false;
      }
    }

    return res.json({
      status: 'success',
      config: configMap,
      fields: rows
    });
  } catch (err) {
    console.error('Error loading infrastructure config from Supabase:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to load field configuration: ' + err.message });
  }
}

async function handleSaveInfraConfig(req, res) {
  try {
    const payload = req.body || {};
    let incomingConfig = payload.config !== undefined ? payload.config : payload;

    if (Array.isArray(incomingConfig)) {
      const map = {};
      incomingConfig.forEach(item => {
        if (item && item.key) {
          map[item.key] = item.is_locked;
        }
      });
      incomingConfig = map;
    }

    const updatedConfig = {};
    const labelMap = {};
    INFRA_FIELDS.forEach(f => {
      labelMap[f.key] = f.label;
    });

    for (const f of INFRA_FIELDS) {
      const key = f.key;
      let isLocked = false;
      if (incomingConfig[key] !== undefined) {
        const val = incomingConfig[key];
        isLocked = val === true || val === 'true' || val === 1 || val === '1' || val === 'on';
      }
      updatedConfig[key] = isLocked;

      await pool.query(`
        INSERT INTO public.infrastructure_config (key, label, is_locked, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (key) DO UPDATE SET
          label = EXCLUDED.label,
          is_locked = EXCLUDED.is_locked,
          updated_at = NOW();
      `, [key, labelMap[key], isLocked]);
    }

    return res.json({
      status: 'success',
      message: 'Field visibility settings updated successfully!',
      config: updatedConfig
    });
  } catch (err) {
    console.error('Error saving infrastructure config to Supabase:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to save field configuration: ' + err.message });
  }
}

async function handleInfraOptions(req, res) {
  try {
    const rawSchools = await getSchools();
    const schools = rawSchools.map(s => {
      let circle = (s.circle || '').toUpperCase().trim();
      if (!circle.includes('CIRCLE')) circle += ' CIRCLE';
      return {
        name: s.name.replace(/\s*\(\d+\)$/, ''),
        code: s.udise,
        circle: circle,
        category: s.category || 'N/A'
      };
    });

    let fieldConfig = {};
    try {
      const configRes = await pool.query('SELECT key, is_locked FROM public.infrastructure_config');
      configRes.rows.forEach(r => {
        fieldConfig[r.key] = Boolean(r.is_locked);
      });
    } catch (cfgErr) {
      console.warn('Could not load infrastructure_config from Supabase:', cfgErr.message);
    }

    for (const f of INFRA_FIELDS) {
      if (fieldConfig[f.key] === undefined) {
        fieldConfig[f.key] = false;
      }
    }

    res.json({
      status: 'success',
      schools: schools,
      fieldConfig: fieldConfig
    });
  } catch (err) {
    console.error('Error loading infrastructure options:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
}

router.get('/infrastructure/config', handleGetInfraConfig);
router.post('/infrastructure/config', requireAuth('main'), handleSaveInfraConfig);
router.get('/infrastructure/options', requireAuth('infrastructure'), handleInfraOptions);
router.get('/get_infrastructure_options.php', requireAuth('infrastructure'), handleInfraOptions);

// ==========================================
// 3. Infrastructure School Details (Fetch)
// ==========================================
async function handleInfraData(req, res) {
  const udise = (req.body?.u_dise || req.query?.u_dise || '').trim();
  if (!udise) {
    return res.status(400).json({ status: 'error', message: 'Missing UDISE code' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM public.school_infrastructure WHERE u_dise = $1 LIMIT 1',
      [udise]
    );

    if (rows.length > 0) {
      return res.json({ status: 'success', data: rows[0] });
    } else {
      return res.json({ status: 'not_found' });
    }
  } catch (err) {
    console.error('Error fetching infrastructure data for UDISE', udise, err.message);
    return res.status(500).json({ status: 'error', message: 'Database query failed' });
  }
}

router.all('/infrastructure/data', requireAuth('infrastructure'), handleInfraData);
router.all('/get_infrastructure_data.php', requireAuth('infrastructure'), handleInfraData);

// ==========================================
// 4. Infrastructure Data Save / Update
// ==========================================
async function handleInfraSave(req, res) {
  const b = req.body || {};
  const udise = (b.u_dise || '').trim();

  if (!udise) {
    return res.status(400).json({ status: 'error', message: 'UDISE code is required' });
  }

  try {
    // Authoritatively lookup master school details from Supabase
    const schoolMap = await getSchoolsMap();
    const master = schoolMap[udise] || {};
    const schoolName = master.school_name || b.school_name || null;
    const circleName = master.circle_name || b.circle_name || null;
    const category = master.category || b.category || null;

    // Load active field lock settings from Supabase
    let lockConfig = {};
    try {
      const cfgRes = await pool.query('SELECT key, is_locked FROM public.infrastructure_config');
      cfgRes.rows.forEach(r => {
        lockConfig[r.key] = Boolean(r.is_locked);
      });
    } catch (cfgErr) {
      console.warn('Could not read infrastructure_config during save:', cfgErr.message);
    }

    // Check existing school infrastructure record in Supabase
    let existing = null;
    try {
      const existRes = await pool.query('SELECT * FROM public.school_infrastructure WHERE u_dise = $1 LIMIT 1', [udise]);
      if (existRes.rows.length > 0) {
        existing = existRes.rows[0];
      }
    } catch (e) {
      console.warn('Could not query existing infrastructure data:', e.message);
    }

    // Resolver: If field is locked in Supabase and existing value exists, preserve existing value
    const resolveValue = (key, submittedVal, existingVal) => {
      if (lockConfig[key] === true && existing && existingVal !== undefined && existingVal !== null) {
        return existingVal;
      }
      return submittedVal !== undefined && submittedVal !== '' ? submittedVal : null;
    };

    const kitchenStatus = resolveValue('kitchen_status', b.kitchen_status, existing?.kitchen_status);
    const kitchenYear = resolveValue('kitchen_year', b.kitchen_year, existing?.kitchen_year);
    const repairGrantStatus = resolveValue('repair_grant_status', b.repair_grant_status || b.repair_status, existing?.repair_grant_status);
    const repairGrantYear = resolveValue('repair_grant_year', b.repair_grant_year || b.repair_year, existing?.repair_grant_year);
    const diningStatus = resolveValue('dining_status', b.dining_status, existing?.dining_status);
    const diningFund = resolveValue('dining_fund', b.dining_fund, existing?.dining_fund);
    const nutritionGarden = resolveValue('nutrition_status', b.nutrition_garden || b.nutrition, existing?.nutrition_garden);
    const kitchenDeviceStatus = resolveValue('kitchen_device_status', b.kitchen_device_status || b.device_status, existing?.kitchen_device_status);
    const kitchenDeviceYear = resolveValue('kitchen_device_year', b.device_year || b.kitchen_device_year, existing?.kitchen_device_year);
    const toiletSeparate = resolveValue('toilet_separate', b.toilet || b.toilet_separate, existing?.toilet_separate);
    const electricStatus = resolveValue('elec_status', b.electric || b.electric_status, existing?.electric_status);
    const waterFacilities = resolveValue('water_facilities', b.water || b.water_facilities, existing?.water_facilities);
    const waterPurifier = resolveValue('water_purifier', b.purifier || b.water_purifier, existing?.water_purifier);
    const remarks = resolveValue('water_remarks', b.remarks, existing?.remarks);

    const query = `
      INSERT INTO public.school_infrastructure (
        u_dise, school_name, circle_name, category,
        kitchen_status, kitchen_year,
        repair_grant_status, repair_grant_year,
        dining_status, dining_fund,
        nutrition_garden, kitchen_device_status,
        kitchen_device_year, toilet_separate,
        electric_status, water_facilities,
        water_purifier, remarks, last_updated
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, NOW()
      )
      ON CONFLICT (u_dise) DO UPDATE SET
        school_name = EXCLUDED.school_name,
        circle_name = EXCLUDED.circle_name,
        category = EXCLUDED.category,
        kitchen_status = EXCLUDED.kitchen_status,
        kitchen_year = EXCLUDED.kitchen_year,
        repair_grant_status = EXCLUDED.repair_grant_status,
        repair_grant_year = EXCLUDED.repair_grant_year,
        dining_status = EXCLUDED.dining_status,
        dining_fund = EXCLUDED.dining_fund,
        nutrition_garden = EXCLUDED.nutrition_garden,
        kitchen_device_status = EXCLUDED.kitchen_device_status,
        kitchen_device_year = EXCLUDED.kitchen_device_year,
        toilet_separate = EXCLUDED.toilet_separate,
        electric_status = EXCLUDED.electric_status,
        water_facilities = EXCLUDED.water_facilities,
        water_purifier = EXCLUDED.water_purifier,
        remarks = EXCLUDED.remarks,
        last_updated = NOW();
    `;

    const values = [
      udise,
      schoolName,
      circleName,
      category,
      kitchenStatus,
      kitchenYear,
      repairGrantStatus,
      repairGrantYear,
      diningStatus,
      diningFund,
      nutritionGarden,
      kitchenDeviceStatus,
      kitchenDeviceYear,
      toiletSeparate,
      electricStatus,
      waterFacilities,
      waterPurifier,
      remarks
    ];

    await pool.query(query, values);
    return res.json({ status: 'success', message: 'Data saved successfully' });
  } catch (err) {
    console.error('Error saving infrastructure data for UDISE', udise, err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to save data: ' + err.message });
  }
}

router.post('/infrastructure/save', requireAuth('infrastructure'), handleInfraSave);
router.post('/save_infrastructure.php', requireAuth('infrastructure'), handleInfraSave);

// ==========================================
// 5. Infrastructure Excel Export
// ==========================================
async function handleExportInfraExcel(req, res) {
  try {
    const schoolMap = await getSchoolsMap();
    const { rows } = await pool.query('SELECT * FROM public.school_infrastructure ORDER BY u_dise ASC');

    const filename = `Infrastructure_Report_${new Date().toISOString().slice(0, 10)}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    let html = '\uFEFF<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    html += '<style>table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;}th,td{border:1px solid #000;padding:6px;text-align:center;}th{background-color:#0284c7;color:#fff;font-weight:bold;}</style></head><body>';
    html += '<h3 style="text-align:center;">School Infrastructure Report</h3>';
    html += '<table><thead><tr>';
    html += '<th>SL</th><th>U-DISE</th><th>School Name</th><th>Circle Name</th><th>Category</th>';
    html += '<th>Kitchen Status</th><th>Kitchen Year</th><th>Repair Grant Status</th><th>Repair Grant Year</th>';
    html += '<th>Dining Status</th><th>Dining Fund</th><th>Nutrition Garden</th><th>Kitchen Device Status</th>';
    html += '<th>Device Year</th><th>Toilet Separate</th><th>Electric Status</th><th>Water Facilities</th>';
    html += '<th>Water Purifier</th><th>Remarks</th><th>Last Updated</th>';
    html += '</tr></thead><tbody>';

    let sl = 1;
    for (const r of rows) {
      const u = String(r.u_dise || '').trim();
      const master = schoolMap[u] || {};
      const sName = master.school_name || r.school_name || '';
      const circle = master.circle_name || r.circle_name || '';
      const cat = master.category || r.category || '';

      html += `<tr>
        <td>${sl++}</td>
        <td>${u}</td>
        <td style="text-align:left;">${sName}</td>
        <td>${circle}</td>
        <td>${cat}</td>
        <td>${r.kitchen_status || '-'}</td>
        <td>${r.kitchen_year || '-'}</td>
        <td>${r.repair_grant_status || '-'}</td>
        <td>${r.repair_grant_year || '-'}</td>
        <td>${r.dining_status || '-'}</td>
        <td>${r.dining_fund || '-'}</td>
        <td>${r.nutrition_garden || '-'}</td>
        <td>${r.kitchen_device_status || '-'}</td>
        <td>${r.kitchen_device_year || '-'}</td>
        <td>${r.toilet_separate || '-'}</td>
        <td>${r.electric_status || '-'}</td>
        <td>${r.water_facilities || '-'}</td>
        <td>${r.water_purifier || '-'}</td>
        <td>${r.remarks || '-'}</td>
        <td>${r.last_updated ? new Date(r.last_updated).toLocaleString('en-IN') : '-'}</td>
      </tr>`;
    }

    html += '</tbody></table></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Error generating infrastructure Excel:', err.message);
    res.status(500).send('Error generating export: ' + err.message);
  }
}

router.get('/export_all_infra_excel.php', handleExportInfraExcel);
router.get('/infrastructure/export', handleExportInfraExcel);

// ==========================================
// 6. Rice Requirements: Saved Data, Submit, View Stats
// ==========================================
async function handleGetSavedRice(req, res) {
  const schoolParam = (req.body?.school_name || req.query?.school_name || req.body?.u_dise || req.query?.u_dise || '').trim();
  const quarter = (req.body?.quarter || req.query?.quarter || '').trim();

  const udise = extractUdise(schoolParam);
  if (!udise) {
    return res.status(400).json({ status: 'error', message: 'Invalid School Name or UDISE format' });
  }

  try {
    let query = 'SELECT * FROM public.rice_requirements WHERE u_dise = $1';
    const params = [udise];

    if (quarter) {
      query += ' AND quarter = $2';
      params.push(quarter);
    }
    query += ' ORDER BY id DESC LIMIT 1';

    const { rows } = await pool.query(query, params);
    if (rows.length > 0) {
      return res.json({ status: 'success', data: rows[0] });
    } else {
      return res.json({ status: 'not_found' });
    }
  } catch (err) {
    console.error('Error getting saved rice data:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

router.all('/get_saved_data.php', handleGetSavedRice);
router.all('/rice/saved', handleGetSavedRice);

async function handleSubmitRice(req, res) {
  const b = req.body || {};
  const udise = extractUdise(b.u_dise || b.school_name || '');
  const quarter = (b.quarter || '').toUpperCase().trim();
  const year = String(b.year || new Date().getFullYear());

  if (!udise || !quarter) {
    return res.status(400).send('Error: Missing UDISE or Quarter');
  }

  try {
    // Sourced strictly from Supabase master table
    const schoolMap = await getSchoolsMap();
    const master = schoolMap[udise] || {};
    const schoolName = master.school_name || b.school_name || `School (${udise})`;

    const reqBv = toFloat(b.p_bv || b.req_bv || 0);
    const reqC15 = toFloat(b.p_c15 || b.req_c1_5 || 0);
    const totalP = Math.round((reqBv + reqC15) * 100) / 100;

    const reqC5 = toFloat(b.u_c5 || b.req_c5 || 0);
    const reqC68 = toFloat(b.u_c68 || b.req_c6_8 || 0);
    const totalU = Math.round((reqC5 + reqC68) * 100) / 100;

    const query = `
      INSERT INTO public.rice_requirements (
        u_dise, school_name, quarter, year,
        req_bv, req_c1_5, total_primary_kg,
        req_c5, req_c6_8, total_upper_kg,
        submission_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (u_dise, quarter, year) DO UPDATE SET
        school_name = EXCLUDED.school_name,
        req_bv = EXCLUDED.req_bv,
        req_c1_5 = EXCLUDED.req_c1_5,
        total_primary_kg = EXCLUDED.total_primary_kg,
        req_c5 = EXCLUDED.req_c5,
        req_c6_8 = EXCLUDED.req_c6_8,
        total_upper_kg = EXCLUDED.total_upper_kg,
        submission_date = NOW();
    `;

    try {
      await pool.query(query, [udise, schoolName, quarter, year, reqBv, reqC15, totalP, reqC5, reqC68, totalU]);
    } catch (confErr) {
      // Fallback update if unique constraint is just (u_dise, quarter)
      const updateRes = await pool.query(`
        UPDATE public.rice_requirements SET
          school_name = $1, req_bv = $2, req_c1_5 = $3, total_primary_kg = $4,
          req_c5 = $5, req_c6_8 = $6, total_upper_kg = $7, submission_date = NOW()
        WHERE u_dise = $8 AND quarter = $9
      `, [schoolName, reqBv, reqC15, totalP, reqC5, reqC68, totalU, udise, quarter]);

      if (updateRes.rowCount === 0) {
        await pool.query(`
          INSERT INTO public.rice_requirements (
            u_dise, school_name, quarter, year, req_bv, req_c1_5, total_primary_kg, req_c5, req_c6_8, total_upper_kg, submission_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        `, [udise, schoolName, quarter, year, reqBv, reqC15, totalP, reqC5, reqC68, totalU]);
      }
    }

    if (req.headers.accept?.includes('application/json')) {
      return res.json({ status: 'success', message: 'Saved successfully' });
    }
    return res.send('success');
  } catch (err) {
    console.error('Error submitting rice requirement:', err.message);
    return res.status(500).send('Error: ' + err.message);
  }
}

router.post('/submit_rice.php', handleSubmitRice);
router.post('/rice/submit', handleSubmitRice);

// Rice View Data (Quarter statistics)
async function handleRiceStats(req, res) {
  const quarter = (req.query?.q || '').toUpperCase().trim();
  if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(quarter)) {
    return res.status(400).json({ status: 'error', message: 'Invalid quarter' });
  }

  try {
    const [schools, subRes] = await Promise.all([
      getSchools(),
      pool.query(
        'SELECT COUNT(DISTINCT u_dise) as cnt FROM public.rice_requirements WHERE quarter = $1',
        [quarter]
      )
    ]);
    const totalSchools = schools.length;
    const submittedCount = parseInt(subRes.rows[0]?.cnt || '0', 10);
    const pendingCount = Math.max(0, totalSchools - submittedCount);

    return res.json({
      status: 'success',
      quarter: quarter,
      total_schools: totalSchools,
      submitted: submittedCount,
      submitted_schools: submittedCount,
      pending: pendingCount,
      pending_schools: pendingCount,
      export_submitted_url: `/api/rice/export?q=${quarter}`,
      export_pending_url: `/api/rice/export-pending?q=${quarter}`
    });
  } catch (err) {
    console.error('Error fetching rice report data:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

router.get('/rice/data', requireAuth('main'), handleRiceStats);
router.get('/admin_rice_view_data.php', requireAuth('main'), handleRiceStats);

// Export Submitted Rice Excel
async function handleExportSubmittedRice(req, res) {
  const q = (req.query?.q || '').toUpperCase().trim();
  if (!q) return res.status(400).send('Missing quarter');

  try {
    const [schoolMap, { rows }] = await Promise.all([
      getSchoolsMap(),
      pool.query(
        'SELECT * FROM public.rice_requirements WHERE quarter = $1 ORDER BY school_name ASC',
        [q]
      )
    ]);

    const filename = `Submitted_Rice_Report_${q}_${new Date().toISOString().slice(0, 10)}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    let html = '\uFEFF<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    html += '<style>table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;}th,td{border:1px solid #000;padding:8px;text-align:center;}th{background-color:#0d6efd;color:#fff;font-weight:bold;font-size:14px;}</style></head><body>';
    html += `<h3 style="text-align:center;">Submitted School List Report - ${q}</h3>`;
    html += '<table><thead><tr>';
    html += '<th>SL No</th><th>School Name</th><th>Circle</th><th>GP Name</th>';
    html += '<th>Bal Vatika (KG)</th><th>Primary I TO V (KG)</th><th>Primary V (KG)</th><th>Upper Primary (VI-VIII) (KG)</th>';
    html += '<th>Total Rice (KG)</th><th>Total Bags</th><th>Calculation</th>';
    html += '</tr></thead><tbody>';

    let i = 1;
    let sumBv = 0, sumPri = 0, sumV = 0, sumUpp = 0, sumGrand = 0;

    for (const r of rows) {
      const udise = String(r.u_dise || '').trim();
      const master = schoolMap[udise] || {};
      const sName = master.school_name || r.school_name || `School (${udise})`;
      const circle = master.circle_name || 'N/A';
      const gp = master.gp_name || 'N/A';

      const bv = toFloat(r.req_bv);
      const pri = toFloat(r.req_c1_5);
      const v = toFloat(r.req_c5);
      const upp = toFloat(r.req_c6_8);
      const grand = Math.round((bv + pri + v + upp) * 100) / 100;

      sumBv += bv; sumPri += pri; sumV += v; sumUpp += upp; sumGrand += grand;

      const bagsInt = Math.floor(grand / 50);
      const bagsRem = Math.round(grand % 50);
      const bagsDisplay = `${bagsInt}.${String(bagsRem).padStart(2, '0')}`;
      const calcStr = `50 = ${bagsInt} Bal, Rem: ${bagsRem}`;

      html += `<tr>
        <td>${i++}</td>
        <td style="text-align:left;">${sName}</td>
        <td>${circle}</td>
        <td>${gp}</td>
        <td>${bv}</td>
        <td>${pri}</td>
        <td>${v}</td>
        <td>${upp}</td>
        <td style="font-weight:bold;background-color:#e6f2ff;">${grand}</td>
        <td style="font-weight:bold;color:#0d6efd;">${bagsDisplay}</td>
        <td style="font-size:11px;color:#555;">${calcStr}</td>
      </tr>`;
    }

    const totalBagsInt = Math.floor(sumGrand / 50);
    const totalBagsRem = Math.round(sumGrand % 50);
    const totalBagsDisplay = `${totalBagsInt}.${String(totalBagsRem).padStart(2, '0')}`;

    html += `<tr style="font-weight:bold;background-color:#fff3cd;">
      <td colspan="4" style="text-align:right;">TOTAL:</td>
      <td>${sumBv.toFixed(2)}</td>
      <td>${sumPri.toFixed(2)}</td>
      <td>${sumV.toFixed(2)}</td>
      <td>${sumUpp.toFixed(2)}</td>
      <td style="color:#0d6efd;">${sumGrand.toFixed(2)}</td>
      <td style="color:#0d6efd;">${totalBagsDisplay}</td>
      <td>50 = ${totalBagsInt} Bal, Rem: ${totalBagsRem}</td>
    </tr>`;

    html += '</tbody></table></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Error generating submitted rice Excel:', err.message);
    res.status(500).send('Error generating export: ' + err.message);
  }
}

router.get('/export_excel.php', requireAuth('main'), handleExportSubmittedRice);
router.get('/rice/export', requireAuth('main'), handleExportSubmittedRice);

// Export Pending Rice Excel
async function handleExportPendingRice(req, res) {
  const q = (req.query?.q || '').toUpperCase().trim();
  if (!q) return res.status(400).send('Missing quarter');

  try {
    const [schools, { rows }] = await Promise.all([
      getSchools(),
      pool.query(
        'SELECT DISTINCT u_dise FROM public.rice_requirements WHERE quarter = $1',
        [q]
      )
    ]);
    const submittedSet = new Set(rows.map(r => String(r.u_dise || '').trim()));
    const pendingSchools = schools.filter(s => !submittedSet.has(s.udise));

    const filename = `Pending_Schools_${q}_${new Date().toISOString().slice(0, 10)}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    let html = '\uFEFF<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    html += '<style>table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;}th,td{border:1px solid #000;padding:8px;text-align:center;}th{background-color:#dc3545;color:#fff;font-weight:bold;font-size:14px;}</style></head><body>';
    html += `<h3 style="text-align:center;">Pending School List Report - ${q} (Total: ${pendingSchools.length})</h3>`;
    html += '<table><thead><tr>';
    html += '<th>SL No</th><th>UDISE Code</th><th>School Name</th><th>Circle</th><th>GP Name</th><th>Category</th>';
    html += '</tr></thead><tbody>';

    let i = 1;
    for (const s of pendingSchools) {
      html += `<tr>
        <td>${i++}</td>
        <td>${s.udise}</td>
        <td style="text-align:left;">${s.school_name}</td>
        <td>${s.circle_name}</td>
        <td>${s.gp_name}</td>
        <td>${s.category}</td>
      </tr>`;
    }

    html += '</tbody></table></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Error generating pending rice Excel:', err.message);
    res.status(500).send('Error generating export: ' + err.message);
  }
}

router.get('/export_pending_excel.php', requireAuth('main'), handleExportPendingRice);
router.get('/rice/export-pending', requireAuth('main'), handleExportPendingRice);

// Status Table Snippet (Recently submitted rice requirements)
async function handleStatusTable(req, res) {
  try {
    const [schoolMap, { rows }] = await Promise.all([
      getSchoolsMap(),
      pool.query('SELECT * FROM public.rice_requirements ORDER BY submission_date DESC LIMIT 50')
    ]);

    const formattedRows = rows.map(r => {
      const udise = String(r.u_dise || '').trim();
      const master = schoolMap[udise] || {};
      const sName = master.school_name || r.school_name;
      return {
        ...r,
        u_dise: udise,
        school_name: sName
      };
    });

    if (req.query?.format === 'json' || req.headers.accept?.includes('application/json')) {
      return res.json({ status: 'success', data: formattedRows });
    }

    let html = `<div style="margin-top: 40px; background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
      <h3 style="color: #2563eb; margin-bottom: 15px; border-left: 5px solid #2563eb; padding-left: 10px;">
        Recently Submitted Schools
      </h3>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; min-width: 600px;">
          <thead>
            <tr style="background: #f8fafc; color: #334155; text-align: left;">
              <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">School Name</th>
              <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Quarter</th>
              <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Total Rice (KG)</th>
              <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Submitted On</th>
              <th style="padding: 12px; border-bottom: 2px solid #e2e8f0;">Status</th>
            </tr>
          </thead>
          <tbody>`;

    for (const r of formattedRows) {
      const totalKg = toFloat(r.total_primary_kg) > 0 ? r.total_primary_kg : (r.total_upper_kg || 0);
      const dateStr = r.submission_date ? new Date(r.submission_date).toLocaleString('en-IN') : '-';

      html += `<tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 12px; font-weight: 500; color: #1e293b;">
          ${r.school_name}<br><small style="color:#64748b; font-size:11px;">${r.u_dise}</small>
        </td>
        <td style="padding: 12px;"><span style="background: #e0e7ff; color: #4338ca; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">${r.quarter}</span></td>
        <td style="padding: 12px; font-weight: 600; color: #059669;">${totalKg} KG</td>
        <td style="padding: 12px; font-size: 13px; color: #64748b;">${dateStr}</td>
        <td style="padding: 12px;"><span style="color: #16a34a; font-weight: 600; font-size: 13px;"><i class="fas fa-check-circle"></i> Received</span></td>
      </tr>`;
    }

    html += '</tbody></table></div></div>';
    res.send(html);
  } catch (err) {
    res.status(500).send('Error loading status table: ' + err.message);
  }
}

router.get('/status_table.php', handleStatusTable);
router.get(['/api/rice/status-table', '/api/status-table', '/rice/status-table', '/status-table'], handleStatusTable);

// Rice Requirement Report Panel Data
async function handleRicePanelData(req, res) {
  try {
    const schoolMap = await getSchoolsMap();
    let { rows } = await pool.query('SELECT * FROM public.rice_requirement_report ORDER BY id DESC');

    // If table is empty, generate report view rows from rice_requirements
    if (rows.length === 0) {
      const reqRes = await pool.query('SELECT * FROM public.rice_requirements ORDER BY submission_date DESC');
      rows = reqRes.rows.map((r, i) => {
        const pKg = parseFloat(r.total_primary_kg) || 0;
        const uKg = parseFloat(r.total_upper_kg) || 0;
        const total = pKg + uKg;
        return {
          id: i + 1,
          sl_no: i + 1,
          school_name: r.school_name,
          u_dise: r.u_dise,
          circle_name: '',
          gp_name: '',
          rice_req_balvatika: r.req_bv || 0,
          rice_req_primary: pKg,
          rice_req_upperprimary: uKg,
          total_rice: total,
          total_bag: Math.ceil(total / 50),
          month_name: r.quarter
        };
      });
    }

    const data = rows.map((r, idx) => {
      let udise = String(r.u_dise || '').trim();
      let sName = r.school_name || '';
      if (!udise) {
        const m = sName.match(/\(([^)]+)\)/);
        if (m) udise = m[1];
      }
      const master = schoolMap[udise] || {};
      return {
        id: r.id,
        sl_no: idx + 1,
        school_name: master.school_name || sName,
        circle_name: master.circle_name || r.circle_name || '',
        gp_name: master.gp_name || r.gp_name || '',
        u_dise: udise,
        rice_req_balvatika: r.rice_req_balvatika || 0,
        rice_req_primary: r.rice_req_primary || 0,
        rice_req_upperprimary: r.rice_req_upperprimary || 0,
        total_rice: r.total_rice || 0,
        total_bag: r.total_bag || 0,
        month_name: r.month_name || ''
      };
    });

    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Error fetching rice panel data:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

router.get(['/api/rice/panel-data', '/rice/panel-data', '/rice_report_panel.php'], handleRicePanelData);

// ==========================================
// 7. Student Enrolment Endpoints
// ==========================================
async function handleGetStudentEnrolment(req, res) {
  const udise = (req.query?.u_dise || req.body?.u_dise || '').trim();
  if (!udise) {
    return res.status(400).json({ status: 'error', message: 'UDISE Code missing' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM public.student_enrolment WHERE u_dise = $1 LIMIT 1', [udise]);
    if (rows.length > 0) {
      return res.json({ status: 'success', data: rows[0] });
    } else {
      return res.json({ status: 'not_found' });
    }
  } catch (err) {
    console.error('Error fetching student enrolment:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

router.all('/get_student_enrolment.php', handleGetStudentEnrolment);
router.all('/students/enrolment', handleGetStudentEnrolment);

// Bulk student enrolment query for admin_student_view.html and admin reports
router.get(['/api/student/data', '/student/data', '/api/students/data', '/students/data', '/admin_student_view_data.php'], requireAuth('main'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.student_enrolment ORDER BY school_name ASC');
    return res.json({ status: 'success', data: rows });
  } catch (err) {
    console.error('Error fetching student enrolment data:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

async function handleSaveStudentEnrolment(req, res) {
  const b = req.body || {};
  const udise = (b.u_dise || '').trim();

  if (!udise) {
    return res.status(400).json({ status: 'error', message: 'UDISE Code is missing' });
  }

  try {
    // Sourced authoritatively from Supabase school_master
    const schoolMap = await getSchoolsMap();
    const master = schoolMap[udise] || {};
    const schoolName = master.school_name || b.school_name || '';
    const category = master.category || b.category || '';
    const circle = master.circle_name || b.circle || '';
    const gp = master.gp_name || b.gram_panchayat || '';

    const query = `
      INSERT INTO public.student_enrolment (
        u_dise, school_name, category, circle, gp_name,
        pre_primary, class_1, class_2, class_3, class_4, class_5, class_6, class_7, class_8,
        male_sc, male_st, male_obc, male_minority, male_others,
        female_sc, female_st, female_obc, female_minority, female_others,
        total_enrolment, total_male, total_female, grand_total
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24,
        $25, $26, $27, $28
      )
      ON CONFLICT (u_dise) DO UPDATE SET
        school_name = EXCLUDED.school_name,
        category = EXCLUDED.category,
        circle = EXCLUDED.circle,
        gp_name = EXCLUDED.gp_name,
        pre_primary = EXCLUDED.pre_primary,
        class_1 = EXCLUDED.class_1,
        class_2 = EXCLUDED.class_2,
        class_3 = EXCLUDED.class_3,
        class_4 = EXCLUDED.class_4,
        class_5 = EXCLUDED.class_5,
        class_6 = EXCLUDED.class_6,
        class_7 = EXCLUDED.class_7,
        class_8 = EXCLUDED.class_8,
        male_sc = EXCLUDED.male_sc,
        male_st = EXCLUDED.male_st,
        male_obc = EXCLUDED.male_obc,
        male_minority = EXCLUDED.male_minority,
        male_others = EXCLUDED.male_others,
        female_sc = EXCLUDED.female_sc,
        female_st = EXCLUDED.female_st,
        female_obc = EXCLUDED.female_obc,
        female_minority = EXCLUDED.female_minority,
        female_others = EXCLUDED.female_others,
        total_enrolment = EXCLUDED.total_enrolment,
        total_male = EXCLUDED.total_male,
        total_female = EXCLUDED.total_female,
        grand_total = EXCLUDED.grand_total;
    `;

    const values = [
      udise, schoolName, category, circle, gp,
      toInt(b.pre_primary), toInt(b.class_1), toInt(b.class_2), toInt(b.class_3),
      toInt(b.class_4), toInt(b.class_5), toInt(b.class_6), toInt(b.class_7), toInt(b.class_8),
      toInt(b.male_sc), toInt(b.male_st), toInt(b.male_obc), toInt(b.male_minority), toInt(b.male_others),
      toInt(b.female_sc), toInt(b.female_st), toInt(b.female_obc), toInt(b.female_minority), toInt(b.female_others),
      toInt(b.total_enrolment), toInt(b.total_male), toInt(b.total_female), toInt(b.grand_total)
    ];

    await pool.query(query, values);
    return res.json({ status: 'success', message: 'Data successfully saved!' });
  } catch (err) {
    console.error('Error saving student enrolment:', err.message);
    return res.status(500).json({ status: 'error', message: 'Database save failed: ' + err.message });
  }
}

router.post('/save_student_enrolment.php', handleSaveStudentEnrolment);
router.post('/students/save', handleSaveStudentEnrolment);

// Export Student Enrolment Submitted Excel
async function handleExportStudentExcel(req, res) {
  try {
    const [schoolMap, { rows }] = await Promise.all([
      getSchoolsMap(),
      pool.query('SELECT * FROM public.student_enrolment ORDER BY school_name ASC')
    ]);

    const filename = `Student_Enrolment_Report_${new Date().toISOString().slice(0, 10)}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    let html = '\uFEFF<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    html += '<style>table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;}th,td{border:1px solid #000;padding:6px;text-align:center;}th{background-color:#2563eb;color:#fff;font-weight:bold;font-size:12px;}</style></head><body>';
    html += '<h3 style="text-align:center;">Class-wise Student Enrolment Report (Submitted Schools)</h3>';
    html += '<table><thead><tr>';
    html += '<th rowspan="2">SL</th><th rowspan="2">UDISE Code</th><th rowspan="2">School Name</th><th rowspan="2">Category</th><th rowspan="2">Circle</th><th rowspan="2">GP Name</th>';
    html += '<th colspan="9">Class-wise Enrolment</th>';
    html += '<th colspan="5">Male Category</th>';
    html += '<th colspan="5">Female Category</th>';
    html += '<th rowspan="2">Total Enrolment</th><th rowspan="2">Total Male</th><th rowspan="2">Total Female</th><th rowspan="2">Grand Total</th>';
    html += '</tr><tr>';
    html += '<th>PP</th><th>I</th><th>II</th><th>III</th><th>IV</th><th>V</th><th>VI</th><th>VII</th><th>VIII</th>';
    html += '<th>SC</th><th>ST</th><th>OBC</th><th>MIN</th><th>OTH</th>';
    html += '<th>SC</th><th>ST</th><th>OBC</th><th>MIN</th><th>OTH</th>';
    html += '</tr></thead><tbody>';

    let sl = 1;
    for (const r of rows) {
      const udise = String(r.u_dise || '').trim();
      const master = schoolMap[udise] || {};
      const sName = master.school_name || r.school_name;
      const cat = master.category || r.category;
      const circle = master.circle_name || r.circle;
      const gp = master.gp_name || r.gp_name;

      html += `<tr>
        <td>${sl++}</td>
        <td>${udise}</td>
        <td style="text-align:left;">${sName}</td>
        <td>${cat}</td>
        <td>${circle}</td>
        <td>${gp}</td>
        <td>${r.pre_primary || 0}</td><td>${r.class_1 || 0}</td><td>${r.class_2 || 0}</td><td>${r.class_3 || 0}</td><td>${r.class_4 || 0}</td><td>${r.class_5 || 0}</td><td>${r.class_6 || 0}</td><td>${r.class_7 || 0}</td><td>${r.class_8 || 0}</td>
        <td>${r.male_sc || 0}</td><td>${r.male_st || 0}</td><td>${r.male_obc || 0}</td><td>${r.male_minority || 0}</td><td>${r.male_others || 0}</td>
        <td>${r.female_sc || 0}</td><td>${r.female_st || 0}</td><td>${r.female_obc || 0}</td><td>${r.female_minority || 0}</td><td>${r.female_others || 0}</td>
        <td style="font-weight:bold;">${r.total_enrolment || 0}</td>
        <td style="font-weight:bold;">${r.total_male || 0}</td>
        <td style="font-weight:bold;">${r.total_female || 0}</td>
        <td style="font-weight:bold;background-color:#dbeafe;">${r.grand_total || 0}</td>
      </tr>`;
    }

    html += '</tbody></table></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Error exporting student excel:', err.message);
    res.status(500).send('Error generating export: ' + err.message);
  }
}

router.get('/export_student_excel.php', requireAuth('main'), handleExportStudentExcel);
router.get('/students/export', requireAuth('main'), handleExportStudentExcel);

// Export Pending Student Enrolment Excel
async function handleExportStudentPendingExcel(req, res) {
  try {
    const [schools, { rows }] = await Promise.all([
      getSchools(),
      pool.query('SELECT DISTINCT u_dise FROM public.student_enrolment')
    ]);
    const submittedSet = new Set(rows.map(r => String(r.u_dise || '').trim()));
    const pendingSchools = schools.filter(s => !submittedSet.has(s.udise));

    const filename = `Pending_Student_Update_Schools_${new Date().toISOString().slice(0, 10)}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    let html = '\uFEFF<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    html += '<style>table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;}th,td{border:1px solid #000;padding:8px;text-align:center;}th{background-color:#dc2626;color:#fff;font-weight:bold;}</style></head><body>';
    html += `<h3 style="text-align:center;">List of Pending Schools (Student Enrolment Not Updated) - Total: ${pendingSchools.length}</h3>`;
    html += '<table><thead><tr>';
    html += '<th>SL</th><th>UDISE Code</th><th>School Name</th><th>Circle</th><th>GP Name</th><th>Category</th>';
    html += '</tr></thead><tbody>';

    let sl = 1;
    for (const s of pendingSchools) {
      html += `<tr>
        <td>${sl++}</td>
        <td>${s.udise}</td>
        <td style="text-align:left;">${s.school_name}</td>
        <td>${s.circle_name}</td>
        <td>${s.gp_name}</td>
        <td>${s.category}</td>
      </tr>`;
    }

    html += '</tbody></table></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Error exporting student pending excel:', err.message);
    res.status(500).send('Error generating export: ' + err.message);
  }
}

router.get('/export_student_pending_excel.php', requireAuth('main'), handleExportStudentPendingExcel);
router.get('/students/export-pending', requireAuth('main'), handleExportStudentPendingExcel);

// 7b. Student Enrolment List (All submitted schools)
async function handleStudentData(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM public.student_enrolment ORDER BY school_name ASC');
    res.json({ status: 'success', data: rows });
  } catch (err) {
    console.error('Error fetching student enrolment data:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
}

router.get('/student/data', requireAuth('main'), handleStudentData);
router.get('/students/data', requireAuth('main'), handleStudentData);
router.get('/admin_student_view_data.php', requireAuth('main'), handleStudentData);

// ==========================================
// 8. Monthly Report: Query, Save, Template & Closing Balance
// ==========================================
async function handleGetMonthlyReport(req, res) {
  const udise = extractUdise(req.query?.u_dise || req.body?.u_dise || req.query?.school_name || '');
  const month = (req.query?.month_name || req.body?.month_name || req.query?.month || req.body?.month || '').trim();
  const year = (req.query?.year || req.body?.year || '').trim();

  if (!udise || !month) {
    return res.status(400).json({ status: 'error', message: 'Missing required parameters (u_dise, month_name)' });
  }

  try {
    let query;
    let params;
    if (udise && /^\d+$/.test(udise)) {
      // Direct indexed lookup on (u_dise, LOWER(month_name))
      query = 'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND LOWER(month_name) = LOWER($2)';
      params = [udise, month];
    } else {
      query = 'SELECT * FROM public.mdm_monthly_report WHERE (u_dise = $1 OR school_name LIKE $2) AND LOWER(month_name) = LOWER($3)';
      params = [udise, `%${udise}%`, month];
    }

    if (year) {
      query += ` AND year = $${params.length + 1}`;
      params.push(year);
    }
    query += ' ORDER BY id DESC LIMIT 1';

    const { rows } = await pool.query(query, params);
    if (rows.length > 0) {
      return res.json({ status: 'success', data: rows[0] });
    } else {
      return res.json({ status: 'not_found' });
    }
  } catch (err) {
    console.error('Error fetching monthly report:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

router.all('/get_monthly_report.php', handleGetMonthlyReport);
router.all('/monthly-report', handleGetMonthlyReport);

// Save Monthly Report (Single Form Save)
async function handleSaveMonthlyReport(req, res) {
  const b = req.body || {};
  const udise = extractUdise(b.u_dise || b.school_name || '');
  const month = (b.month_name || b.month || '').trim();
  const year = String(b.year || new Date().getFullYear()).trim();

  if (!udise || !month || !year) {
    return res.status(400).json({ status: 'error', message: 'School UDISE, Month and Year are required!' });
  }

  try {
    const schoolMap = await getSchoolsMap();
    const master = schoolMap[udise] || {};
    const schoolName = master.school_name || b.school_name || `School (${udise})`;
    const circleName = master.circle_name || b.circle_name || 'N/A';
    const gpName = master.gp_name || b.gp_name || 'N/A';

    const fundDetailsObj = {
      material_cost_bv: { open: toFloat(b.cc_bv_open), recv: toFloat(b.cc_bv_recv), exp: toFloat(b.cc_bv_exp), close: toFloat(b.cc_bv_close) },
      material_cost_p: { open: toFloat(b.cc_p_open), recv: toFloat(b.cc_p_recv), exp: toFloat(b.cc_p_exp), close: toFloat(b.cc_p_close) },
      material_cost_up: { open: toFloat(b.cc_up_open), recv: toFloat(b.cc_up_recv), exp: toFloat(b.cc_up_exp), close: toFloat(b.cc_up_close) },
      bank_interest: { open: toFloat(b.bi_open), recv: toFloat(b.bi_recv), exp: toFloat(b.bi_exp), close: toFloat(b.bi_close) },
      lpg_subsidy: { open: toFloat(b.lpg_open), recv: toFloat(b.lpg_recv), exp: toFloat(b.lpg_exp), close: toFloat(b.lpg_close) },
      supplementary_nutrition: { open: toFloat(b.nutri_open), recv: toFloat(b.nutri_recv), exp: toFloat(b.nutri_exp), close: toFloat(b.nutri_close) },
      school_expenses_mme: { open: toFloat(b.mme_open), recv: toFloat(b.mme_recv), exp: toFloat(b.mme_exp), close: toFloat(b.mme_close) },
      kitchen_devices: { open: toFloat(b.kd_open), recv: toFloat(b.kd_recv), exp: toFloat(b.kd_exp), close: toFloat(b.kd_close) },
      kitchen_shed_repair: { open: toFloat(b.ks_open), recv: toFloat(b.ks_recv), exp: toFloat(b.ks_exp), close: toFloat(b.ks_close) },
      nutrition_garden: { open: toFloat(b.ng_open), recv: toFloat(b.ng_recv), exp: toFloat(b.ng_exp), close: toFloat(b.ng_close) },
      bank_charges: { open: toFloat(b.bc_open), recv: toFloat(b.bc_recv), exp: toFloat(b.bc_exp), close: toFloat(b.bc_close) },
      bank_match: String(b.bank_match || 'YES').trim(),
      bank_passbook_balance: toFloat(b.bank_passbook_balance),
      bank_balance_date: String(b.bank_balance_date || '').trim(),
      passbook_photo_file_id: b.passbook_photo_file_id || null,
      passbook_photo_url: b.passbook_photo_url || null
    };

    const query = `
      INSERT INTO public.mdm_monthly_report (
        month_name, year, u_dise, school_name, circle_name, gp_name,
        bv_days, p_days, up_days, bv_actual, p_actual, up_actual, bv_meals, p_meals, up_meals,
        cc_bv_open, cc_bv_recv, cc_bv_exp, cc_bv_close,
        cc_p_open, cc_p_recv, cc_p_exp, cc_p_close,
        cc_up_open, cc_up_recv, cc_up_exp, cc_up_close,
        cch_open, cch_recv, cch_exp, cch_close,
        mme_open, mme_recv, mme_exp, mme_close,
        bi_open, bi_recv, bi_exp, bi_close,
        lpg_open, lpg_recv, lpg_exp, lpg_close,
        nutri_open, nutri_recv, nutri_exp, nutri_close,
        kd_open, kd_recv, kd_exp, kd_close,
        ks_open, ks_recv, ks_exp, ks_close,
        ng_open, ng_recv, ng_exp, ng_close,
        bc_open, bc_recv, bc_exp, bc_close,
        bank_match, bank_passbook_balance, bank_balance_date, fund_details_json,
        rice_bv_open, rice_bv_recv, rice_bv_cons, rice_bv_close,
        rice_p_open, rice_p_recv, rice_p_cons, rice_p_close,
        rice_up_open, rice_up_recv, rice_up_cons, rice_up_close,
        passbook_photo_file_id, passbook_photo_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26, $27,
        $28, $29, $30, $31,
        $32, $33, $34, $35,
        $36, $37, $38, $39,
        $40, $41, $42, $43,
        $44, $45, $46, $47,
        $48, $49, $50, $51,
        $52, $53, $54, $55,
        $56, $57, $58, $59,
        $60, $61, $62, $63,
        $64, $65, $66, $67,
        $68, $69, $70, $71,
        $72, $73, $74, $75,
        $76, $77, $78, $79,
        $80, $81
      )
      ON CONFLICT (u_dise, month_name, year) DO UPDATE SET
        school_name = EXCLUDED.school_name,
        circle_name = EXCLUDED.circle_name,
        gp_name = EXCLUDED.gp_name,
        bv_days = EXCLUDED.bv_days,
        p_days = EXCLUDED.p_days,
        up_days = EXCLUDED.up_days,
        bv_actual = EXCLUDED.bv_actual,
        p_actual = EXCLUDED.p_actual,
        up_actual = EXCLUDED.up_actual,
        bv_meals = EXCLUDED.bv_meals,
        p_meals = EXCLUDED.p_meals,
        up_meals = EXCLUDED.up_meals,
        cc_bv_open = EXCLUDED.cc_bv_open, cc_bv_recv = EXCLUDED.cc_bv_recv, cc_bv_exp = EXCLUDED.cc_bv_exp, cc_bv_close = EXCLUDED.cc_bv_close,
        cc_p_open = EXCLUDED.cc_p_open, cc_p_recv = EXCLUDED.cc_p_recv, cc_p_exp = EXCLUDED.cc_p_exp, cc_p_close = EXCLUDED.cc_p_close,
        cc_up_open = EXCLUDED.cc_up_open, cc_up_recv = EXCLUDED.cc_up_recv, cc_up_exp = EXCLUDED.cc_up_exp, cc_up_close = EXCLUDED.cc_up_close,
        cch_open = EXCLUDED.cch_open, cch_recv = EXCLUDED.cch_recv, cch_exp = EXCLUDED.cch_exp, cch_close = EXCLUDED.cch_close,
        mme_open = EXCLUDED.mme_open, mme_recv = EXCLUDED.mme_recv, mme_exp = EXCLUDED.mme_exp, mme_close = EXCLUDED.mme_close,
        bi_open = EXCLUDED.bi_open, bi_recv = EXCLUDED.bi_recv, bi_exp = EXCLUDED.bi_exp, bi_close = EXCLUDED.bi_close,
        lpg_open = EXCLUDED.lpg_open, lpg_recv = EXCLUDED.lpg_recv, lpg_exp = EXCLUDED.lpg_exp, lpg_close = EXCLUDED.lpg_close,
        nutri_open = EXCLUDED.nutri_open, nutri_recv = EXCLUDED.nutri_recv, nutri_exp = EXCLUDED.nutri_exp, nutri_close = EXCLUDED.nutri_close,
        kd_open = EXCLUDED.kd_open, kd_recv = EXCLUDED.kd_recv, kd_exp = EXCLUDED.kd_exp, kd_close = EXCLUDED.kd_close,
        ks_open = EXCLUDED.ks_open, ks_recv = EXCLUDED.ks_recv, ks_exp = EXCLUDED.ks_exp, ks_close = EXCLUDED.ks_close,
        ng_open = EXCLUDED.ng_open, ng_recv = EXCLUDED.ng_recv, ng_exp = EXCLUDED.ng_exp, ng_close = EXCLUDED.ng_close,
        bc_open = EXCLUDED.bc_open, bc_recv = EXCLUDED.bc_recv, bc_exp = EXCLUDED.bc_exp, bc_close = EXCLUDED.bc_close,
        bank_match = EXCLUDED.bank_match, bank_passbook_balance = EXCLUDED.bank_passbook_balance, bank_balance_date = EXCLUDED.bank_balance_date, fund_details_json = EXCLUDED.fund_details_json,
        rice_bv_open = EXCLUDED.rice_bv_open, rice_bv_recv = EXCLUDED.rice_bv_recv, rice_bv_cons = EXCLUDED.rice_bv_cons, rice_bv_close = EXCLUDED.rice_bv_close,
        rice_p_open = EXCLUDED.rice_p_open, rice_p_recv = EXCLUDED.rice_p_recv, rice_p_cons = EXCLUDED.rice_p_cons, rice_p_close = EXCLUDED.rice_p_close,
        rice_up_open = EXCLUDED.rice_up_open, rice_up_recv = EXCLUDED.rice_up_recv, rice_up_cons = EXCLUDED.rice_up_cons, rice_up_close = EXCLUDED.rice_up_close,
        passbook_photo_file_id = COALESCE(EXCLUDED.passbook_photo_file_id, public.mdm_monthly_report.passbook_photo_file_id),
        passbook_photo_url = COALESCE(EXCLUDED.passbook_photo_url, public.mdm_monthly_report.passbook_photo_url);
    `;

    const values = [
      month, year, udise, schoolName, circleName, gpName,
      toInt(b.bv_days), toInt(b.p_days), toInt(b.up_days),
      toInt(b.bv_actual), toInt(b.p_actual), toInt(b.up_actual),
      toInt(b.bv_meals), toInt(b.p_meals), toInt(b.up_meals),
      toFloat(b.cc_bv_open), toFloat(b.cc_bv_recv), toFloat(b.cc_bv_exp), toFloat(b.cc_bv_close),
      toFloat(b.cc_p_open), toFloat(b.cc_p_recv), toFloat(b.cc_p_exp), toFloat(b.cc_p_close),
      toFloat(b.cc_up_open), toFloat(b.cc_up_recv), toFloat(b.cc_up_exp), toFloat(b.cc_up_close),
      toFloat(b.cch_open), toFloat(b.cch_recv), toFloat(b.cch_exp), toFloat(b.cch_close),
      toFloat(b.mme_open), toFloat(b.mme_recv), toFloat(b.mme_exp), toFloat(b.mme_close),
      toFloat(b.bi_open), toFloat(b.bi_recv), toFloat(b.bi_exp), toFloat(b.bi_close),
      toFloat(b.lpg_open), toFloat(b.lpg_recv), toFloat(b.lpg_exp), toFloat(b.lpg_close),
      toFloat(b.nutri_open), toFloat(b.nutri_recv), toFloat(b.nutri_exp), toFloat(b.nutri_close),
      toFloat(b.kd_open), toFloat(b.kd_recv), toFloat(b.kd_exp), toFloat(b.kd_close),
      toFloat(b.ks_open), toFloat(b.ks_recv), toFloat(b.ks_exp), toFloat(b.ks_close),
      toFloat(b.ng_open), toFloat(b.ng_recv), toFloat(b.ng_exp), toFloat(b.ng_close),
      toFloat(b.bc_open), toFloat(b.bc_recv), toFloat(b.bc_exp), toFloat(b.bc_close),
      String(b.bank_match || 'YES').trim(), toFloat(b.bank_passbook_balance), String(b.bank_balance_date || '').trim(), JSON.stringify(fundDetailsObj),
      toFloat(b.rice_bv_open), toFloat(b.rice_bv_recv), toFloat(b.rice_bv_cons), toFloat(b.rice_bv_close),
      toFloat(b.rice_p_open), toFloat(b.rice_p_recv), toFloat(b.rice_p_cons), toFloat(b.rice_p_close),
      toFloat(b.rice_up_open), toFloat(b.rice_up_recv), toFloat(b.rice_up_cons), toFloat(b.rice_up_close),
      b.passbook_photo_file_id ? String(b.passbook_photo_file_id).trim() : null,
      b.passbook_photo_url ? String(b.passbook_photo_url).trim() : null
    ];

    try {
      await pool.query(query, values);
    } catch (confErr) {
      // Fallback update if unique constraint is missing
      const updRes = await pool.query(
        'UPDATE public.mdm_monthly_report SET school_name = $1, p_days = $2, p_actual = $3, p_meals = $4, rice_p_close = $5 WHERE u_dise = $6 AND month_name = $7 AND year = $8',
        [schoolName, toInt(b.p_days), toInt(b.p_actual), toInt(b.p_meals), toFloat(b.rice_p_close), udise, month, year]
      );
      if (updRes.rowCount === 0) {
        await pool.query(
          'INSERT INTO public.mdm_monthly_report (month_name, year, u_dise, school_name, circle_name, gp_name, p_days, p_actual, p_meals, rice_p_close) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [month, year, udise, schoolName, circleName, gpName, toInt(b.p_days), toInt(b.p_actual), toInt(b.p_meals), toFloat(b.rice_p_close)]
        );
      }
    }

    return res.json({ status: 'success', message: 'Report saved successfully' });
  } catch (err) {
    console.error('Error saving monthly report:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to save report: ' + err.message });
  }
}

router.post('/save_monthly_report.php', handleSaveMonthlyReport);
router.post('/monthly-report/save', handleSaveMonthlyReport);

/**
 * Direct Google Drive Passbook Photo Uploader Endpoint
 * Securely validates file type, size, magic bytes, school UDISE, and transmits
 * to private Google Drive folder via Google Apps Script Web App without exposing credentials.
 */
async function handleUploadPassbookPhoto(req, res) {
  try {
    const file = req.file;
    const body = req.body || {};

    let buffer = null;
    let mimeType = '';
    let fileName = '';

    if (file && file.buffer) {
      buffer = file.buffer;
      mimeType = (file.mimetype || '').toLowerCase();
      fileName = file.originalname || 'passbook.jpg';
    } else if (body.fileBase64) {
      const cleanBase64 = String(body.fileBase64).replace(/^data:[a-zA-Z0-9\/+-]+;base64,/, '');
      buffer = Buffer.from(cleanBase64, 'base64');
      mimeType = (body.mimeType || 'image/jpeg').toLowerCase();
      fileName = body.fileName || 'passbook.jpg';
    } else {
      return res.status(400).json({ status: 'error', message: 'No photo file received.' });
    }

    const udise = extractUdise(body.u_dise || body.udise || '');
    const month = (body.month_name || body.month || '').trim();
    const year = String(body.year || new Date().getFullYear()).trim();

    // 1. Strict Input Validation
    if (!udise) {
      return res.status(400).json({ status: 'error', message: 'School UDISE code is required.' });
    }
    if (!month || !year) {
      return res.status(400).json({ status: 'error', message: 'Reporting Month and Year are required.' });
    }

    const schoolMap = await getSchoolsMap();
    const master = schoolMap[udise];
    if (!master) {
      return res.status(400).json({ status: 'error', message: `Unauthorized or invalid school: UDISE ${udise} was not found in master records.` });
    }
    const schoolName = master.school_name || `School (${udise})`;

    // 2. Strict MIME Type Validation (JPG, JPEG, PNG, WEBP)
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(mimeType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid file format. Only JPG, JPEG, PNG, and WebP images are allowed.'
      });
    }

    // 3. File Size Limit (Max 10MB)
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ status: 'error', message: 'File size exceeds maximum allowed limit of 10MB.' });
    }

    // 4. Magic Bytes Inspection (Anti-disguise security validation)
    const isJpeg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const isPng = buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isWebp = buffer.length > 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;

    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json({
        status: 'error',
        message: 'Corrupted image file: File content does not match genuine JPG, PNG, or WebP image headers.'
      });
    }

    // 5. Google Drive Integration (Google Apps Script Web App Gateway)
    const gasUrl = process.env.GOOGLE_DRIVE_WEBAPP_URL;
    const gasToken = process.env.GOOGLE_DRIVE_UPLOAD_TOKEN || '';

    if (!gasUrl) {
      return res.status(503).json({
        status: 'error',
        code: 'DRIVE_CONFIG_REQUIRED',
        message: 'Google Drive Web App URL is not configured. Please add GOOGLE_DRIVE_WEBAPP_URL to your .env or Vercel Environment Variables.'
      });
    }

    const drivePayload = {
      token: gasToken,
      fileBase64: buffer.toString('base64'),
      mimeType: isPng ? 'image/png' : (isWebp ? 'image/webp' : 'image/jpeg'),
      fileName: fileName,
      udise: udise,
      month: month,
      year: year,
      schoolName: schoolName
    };

    let driveRes;
    try {
      driveRes = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(drivePayload)
      });
    } catch (netErr) {
      console.error('Failed to connect to Google Apps Script Web App:', netErr.message);
      return res.status(502).json({
        status: 'error',
        message: 'Failed to connect to Google Drive service: ' + netErr.message
      });
    }

    const driveText = await driveRes.text();
    let driveJson;
    try {
      driveJson = JSON.parse(driveText);
    } catch (parseErr) {
      console.error('Google Apps Script returned non-JSON response:', driveText.slice(0, 200));
      return res.status(502).json({
        status: 'error',
        message: 'Google Drive upload returned an invalid response. Please verify Google Apps Script deployment permissions.'
      });
    }

    if (!driveRes.ok || driveJson.status !== 'success') {
      return res.status(driveRes.status >= 400 ? driveRes.status : 500).json({
        status: 'error',
        message: driveJson.message || 'Google Drive rejected the photo upload.'
      });
    }

    const fileId = driveJson.fileId;
    const fileUrl = driveJson.viewUrl || driveJson.fileUrl || `https://drive.google.com/file/d/${fileId}/view`;

    // 6. Save Google Drive Photo Reference in Supabase PostgreSQL
    try {
      const photoMetaObj = {
        file_id: fileId,
        file_url: fileUrl,
        file_name: fileName,
        uploaded_at: new Date().toISOString()
      };

      const updateQuery = `
        UPDATE public.mdm_monthly_report 
        SET passbook_photo_file_id = $1,
            passbook_photo_url = $2,
            fund_details_json = jsonb_set(
              COALESCE(fund_details_json, '{}'::jsonb),
              '{passbook_photo}',
              $3::jsonb
            )
        WHERE u_dise = $4 AND LOWER(month_name) = LOWER($5) AND year = $6
      `;
      const updateRes = await pool.query(updateQuery, [fileId, fileUrl, JSON.stringify(photoMetaObj), udise, month, year]);

      if (updateRes.rowCount === 0) {
        const circleName = master.circle_name || 'N/A';
        const gpName = master.gp_name || 'N/A';
        const insertQuery = `
          INSERT INTO public.mdm_monthly_report (
            month_name, year, u_dise, school_name, circle_name, gp_name,
            passbook_photo_file_id, passbook_photo_url, fund_details_json
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9
          )
          ON CONFLICT (u_dise, month_name, year) DO UPDATE SET
            passbook_photo_file_id = EXCLUDED.passbook_photo_file_id,
            passbook_photo_url = EXCLUDED.passbook_photo_url,
            fund_details_json = jsonb_set(
              COALESCE(public.mdm_monthly_report.fund_details_json, '{}'::jsonb),
              '{passbook_photo}',
              $10::jsonb
            )
        `;
        await pool.query(insertQuery, [
          month, year, udise, schoolName, circleName, gpName,
          fileId, fileUrl, JSON.stringify({ passbook_photo: photoMetaObj }),
          JSON.stringify(photoMetaObj)
        ]);
      }
    } catch (dbErr) {
      console.error('Warning: could not update Supabase photo columns:', dbErr.message);
    }

    return res.json({
      status: 'success',
      message: 'Bank passbook photo saved directly to Google Drive successfully.',
      fileId: fileId,
      fileUrl: fileUrl,
      fileName: fileName
    });

  } catch (err) {
    console.error('Error handling passbook photo upload:', err.message);
    return res.status(500).json({
      status: 'error',
      message: 'Server error processing Google Drive upload: ' + err.message
    });
  }
}

router.post('/monthly-report/upload-passbook', upload.single('photo'), handleUploadPassbookPhoto);
router.post('/monthly-report/upload-passbook.php', upload.single('photo'), handleUploadPassbookPhoto);

// Download Monthly Template CSV (All 246 schools from Supabase)
async function handleDownloadTemplate(req, res) {
  const type = req.query?.type || 'all';
  const month = req.query?.month || new Date().toLocaleString('en-US', { month: 'long' });
  const year = req.query?.year || String(new Date().getFullYear());

  const headers = [
    'u_dise', 'school_name', 'category', 'circle_name', 'gp_name', 'month_name', 'year',
    'bv_days', 'p_days', 'up_days', 'bv_actual', 'p_actual', 'up_actual', 'bv_meals', 'p_meals', 'up_meals',
    'cc_bv_open', 'cc_bv_recv', 'cc_bv_exp', 'cc_bv_close',
    'cc_p_open', 'cc_p_recv', 'cc_p_exp', 'cc_p_close',
    'cc_up_open', 'cc_up_recv', 'cc_up_exp', 'cc_up_close',
    'bi_open', 'bi_recv', 'bi_exp', 'bi_close',
    'lpg_open', 'lpg_recv', 'lpg_exp', 'lpg_close',
    'nutri_open', 'nutri_recv', 'nutri_exp', 'nutri_close',
    'mme_open', 'mme_recv', 'mme_exp', 'mme_close',
    'kd_open', 'kd_recv', 'kd_exp', 'kd_close',
    'ks_open', 'ks_recv', 'ks_exp', 'ks_close',
    'ng_open', 'ng_recv', 'ng_exp', 'ng_close',
    'bc_open', 'bc_recv', 'bc_exp', 'bc_close',
    'bank_passbook_balance', 'bank_balance_date', 'bank_match',
    'rice_bv_open', 'rice_bv_recv', 'rice_bv_cons', 'rice_bv_close',
    'rice_p_open', 'rice_p_recv', 'rice_p_cons', 'rice_p_close',
    'rice_up_open', 'rice_up_recv', 'rice_up_cons', 'rice_up_close'
  ];

  const filename = type === 'blank' ? 'monthly_report_template_blank.csv' : `monthly_report_template_${month.toLowerCase()}_${year}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  let csvContent = '\uFEFF' + headers.join(',') + '\n';

  if (type === 'blank') {
    csvContent += '19120502701,"CHOWBERA PRIMARY SCHOOL (19120502701)","PRIMARY ONLY","BOINCHEE","BANTIKA BOINCHI",' +
      `"${month}","${year}",10,10,0,10,10,0,25,20,0,` +
      '2000.00,2000.00,5000.00,-1000.00,2000.00,2000.00,1000000.00,-9996000.00,0.00,0.00,0.00,0.00,' +
      '0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,' +
      '0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,' +
      `0.00,${new Date().toISOString().slice(0, 10)},YES,` +
      '100.00,2000.00,500.00,1600.00,1222.00,2000.00,2200.00,1022.00,0.00,0.00,0.00,0.00\n';
    return res.send(csvContent);
  }

  try {
    const schools = await getSchools();
    for (const s of schools) {
      const row = [
        s.udise,
        `"${s.school_name.replace(/"/g, '""')}"`,
        `"${s.category}"`,
        `"${s.circle_name}"`,
        `"${s.gp_name}"`,
        `"${month}"`,
        `"${year}"`,
        // Meals default 0
        0, 0, 0, 0, 0, 0, 0, 0, 0,
        // Funds default 0.00 (11 components * 4)
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        // Bank details
        '0.00', new Date().toISOString().slice(0, 10), 'YES',
        // Rice default 0.00
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00',
        '0.00', '0.00', '0.00', '0.00'
      ];
      csvContent += row.join(',') + '\n';
    }
    res.send(csvContent);
  } catch (err) {
    console.error('Error generating template CSV:', err.message);
    res.status(500).send('Error generating template: ' + err.message);
  }
}

router.get('/download_monthly_template.php', handleDownloadTemplate);
router.get('/monthly-report/template', handleDownloadTemplate);

// Closing Balance Report Rendering (Handles closingbalance.php and API)
async function handleClosingBalance(req, res) {
  const month = (req.query?.month || '').trim();
  const school = (req.query?.school || '').trim();
  const isReportBody = req.query?.render === 'report_body';

  if (!isReportBody) {
    if (req.path === '/closingbalance.php') {
      const queryIdx = req.url.indexOf('?');
      const queryString = queryIdx !== -1 ? req.url.slice(queryIdx) : '';
      return res.redirect(308, '/closingbalance' + queryString);
    }
    // If browser visits /closingbalance directly, serve the HTML page
    return res.sendFile(path.join(__dirname, '..', 'closingbalance.html'));
  }

  if (!month || !school) {
    return res.send('<div style="text-align:center; padding:50px; background:white; margin-top:20px; border-radius:10px;"><p style="color:#64748b;">Please select a month and school.</p></div>');
  }

  try {
    const udise = extractUdise(school);
    let query;
    let params;
    if (udise && /^\d+$/.test(udise)) {
      query = 'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND LOWER(month_name) = LOWER($2) ORDER BY id DESC LIMIT 1';
      params = [udise, month];
    } else {
      query = 'SELECT * FROM public.mdm_monthly_report WHERE (u_dise = $1 OR school_name LIKE $2) AND LOWER(month_name) = LOWER($3) ORDER BY id DESC LIMIT 1';
      params = [udise, `%${udise}%`, month];
    }

    const [schoolMap, { rows }] = await Promise.all([
      getSchoolsMap(),
      pool.query(query, params)
    ]);

    const master = schoolMap[udise] || {};
    const cat = master.category || '';
    const isUpper = (cat.toUpperCase().includes('UPPER') || cat.toUpperCase().includes('HIGH'));
    const isPrimaryOnly = !isUpper;

    const showBv = isPrimaryOnly;
    const showPrimary = true;
    const showUpper = isUpper;

    if (rows.length === 0) {
      return res.send(`
        <div style="text-align:center; padding:50px; background:white; margin-top:20px; border-radius:10px;">
          <i class="fas fa-exclamation-circle" style="font-size:40px; color:#ef4444; margin-bottom:10px;"></i>
          <h3 style="color:#1e293b;">No Data Found!</h3>
          <p style="color:#64748b;">No report uploaded for <b>${school}</b> in ${month}.</p>
        </div>
      `);
    }

    const d = rows[0];
    const sName = master.school_name || d.school_name || school;
    const circle = master.circle_name || d.circle_name || 'N/A';
    const gp = master.gp_name || d.gp_name || 'N/A';

    const fmt = v => Number(toFloat(v)).toFixed(2);
    const showVal = (v, active) => active ? (v !== null && v !== '' ? v : 0) : '---';

    const fOpenTotal = toFloat(d.cc_bv_open) + toFloat(d.cc_p_open) + toFloat(d.cc_up_open) + toFloat(d.bi_open) + toFloat(d.lpg_open) + toFloat(d.nutri_open) + toFloat(d.mme_open) + toFloat(d.kd_open) + toFloat(d.ks_open) + toFloat(d.ng_open) + toFloat(d.bc_open);
    const fRecvTotal = toFloat(d.cc_bv_recv) + toFloat(d.cc_p_recv) + toFloat(d.cc_up_recv) + toFloat(d.bi_recv) + toFloat(d.lpg_recv) + toFloat(d.nutri_recv) + toFloat(d.mme_recv) + toFloat(d.kd_recv) + toFloat(d.ks_recv) + toFloat(d.ng_recv) + toFloat(d.bc_recv);
    const fExpTotal = toFloat(d.cc_bv_exp) + toFloat(d.cc_p_exp) + toFloat(d.cc_up_exp) + toFloat(d.bi_exp) + toFloat(d.lpg_exp) + toFloat(d.nutri_exp) + toFloat(d.mme_exp) + toFloat(d.kd_exp) + toFloat(d.ks_exp) + toFloat(d.ng_exp) + toFloat(d.bc_exp);
    const fCloseTotal = toFloat(d.cc_bv_close) + toFloat(d.cc_p_close) + toFloat(d.cc_up_close) + toFloat(d.bi_close) + toFloat(d.lpg_close) + toFloat(d.nutri_close) + toFloat(d.mme_close) + toFloat(d.kd_close) + toFloat(d.ks_close) + toFloat(d.ng_close) + toFloat(d.bc_close);

    let html = `
      <div class="report-card">
        <div class="report-header">
          <div>
            <h1 class="school-name">${sName}</h1>
            <div style="font-weight: 600; color: #475569; font-size: 15px; margin-top: 2px;">
              Circle: <span style="color: #1e293b;">${circle}</span> | GP: <span style="color: #1e293b;">${gp}</span>
            </div>
            <div class="report-meta">Monthly Report - ${d.month_name} ${d.year}</div>
          </div>
          <div class="header-actions">
            <button class="btn-desktop" id="desktopBtn" onclick="toggleDesktopView()">Desktop View</button>
          </div>
        </div>

        <div class="sec-title">2. Meal Availed Status</div>
        <table>
          <thead>
            <tr>
              <th>DESCRIPTION</th>
              ${showBv ? '<th>BAL VATIKA</th>' : ''}
              <th>PRIMARY</th>
              ${showUpper ? '<th>UPPER PRIMARY</th>' : ''}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Number of School Days during Month</td>
              ${showBv ? `<td>${showVal(d.bv_days, true)}</td>` : ''}
              <td>${d.p_days || 0}</td>
              ${showUpper ? `<td>${showVal(d.up_days, true)}</td>` : ''}
            </tr>
            <tr>
              <td>Actual Number of Days Mid Day Meal Served</td>
              ${showBv ? `<td>${showVal(d.bv_actual, true)}</td>` : ''}
              <td>${d.p_actual || 0}</td>
              ${showUpper ? `<td>${showVal(d.up_actual, true)}</td>` : ''}
            </tr>
            <tr>
              <td>Total Meals Served during the Month</td>
              ${showBv ? `<td>${showVal(d.bv_meals, true)}</td>` : ''}
              <td>${d.p_meals || 0}</td>
              ${showUpper ? `<td>${showVal(d.up_meals, true)}</td>` : ''}
            </tr>
          </tbody>
        </table>

        <div class="sec-title">3. Fund Details (in Rs.)</div>
        <table>
          <thead>
            <tr style="background:#e2e8f0;">
              <th style="text-align:left;">COMPONENT</th>
              <th>OPENING BALANCE</th>
              <th>RECEIVED</th>
              <th>EXPENDITURE</th>
              <th>CLOSING BALANCE</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style="text-align:left;">MATERIAL COST BAL VATIKA</td><td>${fmt(d.cc_bv_open)}</td><td>${fmt(d.cc_bv_recv)}</td><td>${fmt(d.cc_bv_exp)}</td><td>${fmt(d.cc_bv_close)}</td></tr>
            <tr><td style="text-align:left;">MATERIAL COST PRIMARY</td><td>${fmt(d.cc_p_open)}</td><td>${fmt(d.cc_p_recv)}</td><td>${fmt(d.cc_p_exp)}</td><td>${fmt(d.cc_p_close)}</td></tr>
            <tr><td style="text-align:left;">MATERIAL COST UPPER PRIMARY</td><td>${fmt(d.cc_up_open)}</td><td>${fmt(d.cc_up_recv)}</td><td>${fmt(d.cc_up_exp)}</td><td>${fmt(d.cc_up_close)}</td></tr>
            <tr><td style="text-align:left;">BANK INTEREST</td><td>${fmt(d.bi_open)}</td><td>${fmt(d.bi_recv)}</td><td>${fmt(d.bi_exp)}</td><td>${fmt(d.bi_close)}</td></tr>
            <tr><td style="text-align:left;">LPG SUBSIDY</td><td>${fmt(d.lpg_open)}</td><td>${fmt(d.lpg_recv)}</td><td>${fmt(d.lpg_exp)}</td><td>${fmt(d.lpg_close)}</td></tr>
            <tr><td style="text-align:left;">SUPPLEMENTARY / EXTRA NUTRITION</td><td>${fmt(d.nutri_open)}</td><td>${fmt(d.nutri_recv)}</td><td>${fmt(d.nutri_exp)}</td><td>${fmt(d.nutri_close)}</td></tr>
            <tr><td style="text-align:left;">SCHOOL EXPENSES (MME)</td><td>${fmt(d.mme_open)}</td><td>${fmt(d.mme_recv)}</td><td>${fmt(d.mme_exp)}</td><td>${fmt(d.mme_close)}</td></tr>
            <tr><td style="text-align:left;">KITCHEN DEVICES</td><td>${fmt(d.kd_open)}</td><td>${fmt(d.kd_recv)}</td><td>${fmt(d.kd_exp)}</td><td>${fmt(d.kd_close)}</td></tr>
            <tr><td style="text-align:left;">KITCHEN SHED REPAIR</td><td>${fmt(d.ks_open)}</td><td>${fmt(d.ks_recv)}</td><td>${fmt(d.ks_exp)}</td><td>${fmt(d.ks_close)}</td></tr>
            <tr><td style="text-align:left;">NUTRITION GARDEN</td><td>${fmt(d.ng_open)}</td><td>${fmt(d.ng_recv)}</td><td>${fmt(d.ng_exp)}</td><td>${fmt(d.ng_close)}</td></tr>
            <tr><td style="text-align:left;">BANK CHARGES (SMS/CHEQUE BOOK)</td><td>${fmt(d.bc_open)}</td><td>${fmt(d.bc_recv)}</td><td>${fmt(d.bc_exp)}</td><td>${fmt(d.bc_close)}</td></tr>
            <tr style="background:#f1f5f9; font-weight:800;">
              <td style="text-align:left;">TOTAL</td>
              <td>${fOpenTotal.toFixed(2)}</td>
              <td>${fRecvTotal.toFixed(2)}</td>
              <td>${fExpTotal.toFixed(2)}</td>
              <td>${fCloseTotal.toFixed(2)}</td>
            </tr>
            <tr style="background:#ffffff;">
              <td colspan="4" style="text-align:left; font-weight:600; padding:10px;">Bank Pass Book Balance As On Date/Month/Year:</td>
              <td style="font-weight:800; text-align:center;">${fmt(d.bank_passbook_balance || 0)}</td>
            </tr>
            <tr style="background:#ffffff;">
              <td colspan="4" style="text-align:left; font-weight:600; padding:10px;">Whether the Sum of above Closing Balance matches with Bank Account Closing Balance:</td>
              <td style="font-weight:800; text-align:center;">${d.bank_match || 'YES'}</td>
            </tr>
          </tbody>
        </table>

        <div class="sec-title">5. Food Grains Details (in KG)</div>
        <table>
          <thead>
            <tr>
              <th>CATEGORY</th><th>FOOD ITEM</th><th>OPENING BALANCE</th><th>RECEIVED DURING THE MONTH</th><th>CONSUMPTION DURING THE MONTH</th><th>CLOSING BALANCE</th>
            </tr>
          </thead>
          <tbody>
            ${showBv ? `
            <tr><td rowspan="2" style="vertical-align:middle"><b>Bal Vatika</b></td><td>Wheat</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
            <tr><td>Rice</td><td>${showVal(d.rice_bv_open, true)}</td><td>${showVal(d.rice_bv_recv, true)}</td><td>${showVal(d.rice_bv_cons, true)}</td><td>${showVal(d.rice_bv_close, true)}</td></tr>
            ` : ''}
            <tr><td rowspan="2" style="vertical-align:middle"><b>Primary</b></td><td>Wheat</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
            <tr><td>Rice</td><td>${d.rice_p_open || 0}</td><td>${d.rice_p_recv || 0}</td><td>${d.rice_p_cons || 0}</td><td>${d.rice_p_close || 0}</td></tr>
            ${showUpper ? `
            <tr><td rowspan="2" style="vertical-align:middle"><b>Upper Primary</b></td><td>Wheat</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
            <tr><td>Rice</td><td>${showVal(d.rice_up_open, true)}</td><td>${showVal(d.rice_up_recv, true)}</td><td>${showVal(d.rice_up_cons, true)}</td><td>${showVal(d.rice_up_close, true)}</td></tr>
            ` : ''}
          </tbody>
        </table>
      </div>
    `;

    res.send(html);
  } catch (err) {
    console.error('Error rendering closing balance report:', err.message);
    res.status(500).send('<div style="text-align:center; padding:50px; color:#ef4444;"><p>Error rendering report.</p></div>');
  }
}

router.all('/closingbalance.php', handleClosingBalance);
router.all('/closingbalance', handleClosingBalance);

// ==========================================
// 9. CSV Upload Handler (Admin Upload Monthly Report)
// ==========================================
const handleUploadCsv = async (req, res) => {
  const isAjax = req.headers.accept?.includes('application/json') || req.body?.ajax === '1' || req.is('json');

  const isPrimary = Boolean(
    req.files?.file_primary || 
    req.body?.upload_primary || 
    req.body?.type === 'primary' || 
    req.query?.type === 'primary'
  );
  const fileObj = req.files?.file_primary?.[0] || req.files?.file_upper?.[0] || req.files?.file?.[0];
  const month = (isPrimary ? (req.body?.month || req.body?.month_u) : (req.body?.month_u || req.body?.month || '')).trim();
  const year = (isPrimary ? (req.body?.year || req.body?.year_u) : (req.body?.year_u || req.body?.year || '')).trim();

  const sendUploadResponse = (status, msg, count = 0, details = {}) => {
    if (isAjax) {
      return res.json({ status, message: msg, count, ...details });
    }
    const param = (status === 'success' ? 'msg_' : 'err_') + (isPrimary ? 'primary' : 'upper');
    return res.redirect(`/upload_csv?${param}=${encodeURIComponent(msg)}`);
  };

  if (!month || month === 'Select Month' || !year) {
    return sendUploadResponse('error', 'Please select a valid month and year.');
  }

  try {
    let dataRows = [];
    if (Array.isArray(req.body?.rows) && req.body.rows.length > 0) {
      dataRows = req.body.rows;
    } else if (fileObj && fileObj.buffer) {
      const text = fileObj.buffer.toString('utf8');
      const allRows = parseCSV(text);
      if (allRows.length < 2) {
        return sendUploadResponse('error', 'CSV file is empty or missing data rows.');
      }
      dataRows = allRows.slice(1); // Skip header row matching original PHP
    } else {
      return sendUploadResponse('error', 'No file was uploaded.');
    }

    const schoolMap = await getSchoolsMap();
    let processed = 0;
    let insertedCount = 0;
    let updatedCount = 0;

    for (const col of dataRows) {
      if (col.length < 2 || !col[1]) continue;
      const udise = String(col[1]).trim();
      if (!udise) continue;

      const master = schoolMap[udise] || {};
      const schoolName = master.school_name || col[2] || `School (${udise})`;
      const circleName = master.circle_name || col[3] || 'N/A';
      const gpName = master.gp_name || col[4] || 'N/A';

      // Safe numeric values (0 as original defaults)
      let bvDays = 0, pDays = 0, upDays = 0;
      let bvAct = 0, pAct = 0, upAct = 0;
      let bvMeals = 0, pMeals = 0, upMeals = 0;
      let ccBvOpen = 0, ccBvRecv = 0, ccBvExp = 0, ccBvClose = 0;
      let ccPOpen = 0, ccPRecv = 0, ccPExp = 0, ccPClose = 0;
      let ccUpOpen = 0, ccUpRecv = 0, ccUpExp = 0, ccUpClose = 0;
      let cchOpen = 0, cchRecv = 0, cchExp = 0, cchClose = 0;
      let mmeOpen = 0, mmeRecv = 0, mmeExp = 0, mmeClose = 0;
      let rBvOpen = 0, rBvRecv = 0, rBvCons = 0, rBvClose = 0;
      let rPOpen = 0, rPRecv = 0, rPCons = 0, rPClose = 0;
      let rUpOpen = 0, rUpRecv = 0, rUpCons = 0, rUpClose = 0;

      if (isPrimary) {
        bvDays = toInt(col[5]); pDays = toInt(col[6]);
        bvAct = toInt(col[7]); pAct = toInt(col[8]);
        bvMeals = toInt(col[9]); pMeals = toInt(col[10]);

        ccBvOpen = toFloat(col[11]); ccBvRecv = toFloat(col[12]); ccBvExp = toFloat(col[13]); ccBvClose = toFloat(col[14]);
        ccPOpen = toFloat(col[15]); ccPRecv = toFloat(col[16]); ccPExp = toFloat(col[17]); ccPClose = toFloat(col[18]);
        cchOpen = toFloat(col[19]); cchRecv = toFloat(col[20]); cchExp = toFloat(col[21]); cchClose = toFloat(col[22]);
        mmeOpen = toFloat(col[23]); mmeRecv = toFloat(col[24]); mmeExp = toFloat(col[25]); mmeClose = toFloat(col[26]);

        rBvOpen = toFloat(col[27]); rBvRecv = toFloat(col[28]); rBvCons = toFloat(col[29]); rBvClose = toFloat(col[30]);
        rPOpen = toFloat(col[31]); rPRecv = toFloat(col[32]); rPCons = toFloat(col[33]); rPClose = toFloat(col[34]);
      } else {
        pDays = toInt(col[5]); upDays = toInt(col[6]);
        pAct = toInt(col[7]); upAct = toInt(col[8]);
        pMeals = toInt(col[9]); upMeals = toInt(col[10]);

        ccPOpen = toFloat(col[11]); ccPRecv = toFloat(col[12]); ccPExp = toFloat(col[13]); ccPClose = toFloat(col[14]);
        ccUpOpen = toFloat(col[15]); ccUpRecv = toFloat(col[16]); ccUpExp = toFloat(col[17]); ccUpClose = toFloat(col[18]);
        cchOpen = toFloat(col[19]); cchRecv = toFloat(col[20]); cchExp = toFloat(col[21]); cchClose = toFloat(col[22]);
        mmeOpen = toFloat(col[23]); mmeRecv = toFloat(col[24]); mmeExp = toFloat(col[25]); mmeClose = toFloat(col[26]);

        rPOpen = toFloat(col[27]); rPRecv = toFloat(col[28]); rPCons = toFloat(col[29]); rPClose = toFloat(col[30]);
        rUpOpen = toFloat(col[31]); rUpRecv = toFloat(col[32]); rUpCons = toFloat(col[33]); rUpClose = toFloat(col[34]);
      }

      const q = `
        INSERT INTO public.mdm_monthly_report (
          month_name, year, u_dise, school_name, circle_name, gp_name,
          bv_days, p_days, up_days, bv_actual, p_actual, up_actual, bv_meals, p_meals, up_meals,
          cc_bv_open, cc_bv_recv, cc_bv_exp, cc_bv_close,
          cc_p_open, cc_p_recv, cc_p_exp, cc_p_close,
          cc_up_open, cc_up_recv, cc_up_exp, cc_up_close,
          cch_open, cch_recv, cch_exp, cch_close,
          mme_open, mme_recv, mme_exp, mme_close,
          rice_bv_open, rice_bv_recv, rice_bv_cons, rice_bv_close,
          rice_p_open, rice_p_recv, rice_p_cons, rice_p_close,
          rice_up_open, rice_up_recv, rice_up_cons, rice_up_close
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
          $28, $29, $30, $31, $32, $33, $34, $35,
          $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47
        )
        ON CONFLICT (u_dise, month_name, year) DO UPDATE SET
          school_name = EXCLUDED.school_name,
          circle_name = EXCLUDED.circle_name,
          gp_name = EXCLUDED.gp_name,
          bv_days = EXCLUDED.bv_days, p_days = EXCLUDED.p_days, up_days = EXCLUDED.up_days,
          bv_actual = EXCLUDED.bv_actual, p_actual = EXCLUDED.p_actual, up_actual = EXCLUDED.up_actual,
          bv_meals = EXCLUDED.bv_meals, p_meals = EXCLUDED.p_meals, up_meals = EXCLUDED.up_meals,
          cc_bv_open = EXCLUDED.cc_bv_open, cc_bv_recv = EXCLUDED.cc_bv_recv, cc_bv_exp = EXCLUDED.cc_bv_exp, cc_bv_close = EXCLUDED.cc_bv_close,
          cc_p_open = EXCLUDED.cc_p_open, cc_p_recv = EXCLUDED.cc_p_recv, cc_p_exp = EXCLUDED.cc_p_exp, cc_p_close = EXCLUDED.cc_p_close,
          cc_up_open = EXCLUDED.cc_up_open, cc_up_recv = EXCLUDED.cc_up_recv, cc_up_exp = EXCLUDED.cc_up_exp, cc_up_close = EXCLUDED.cc_up_close,
          cch_open = EXCLUDED.cch_open, cch_recv = EXCLUDED.cch_recv, cch_exp = EXCLUDED.cch_exp, cch_close = EXCLUDED.cch_close,
          mme_open = EXCLUDED.mme_open, mme_recv = EXCLUDED.mme_recv, mme_exp = EXCLUDED.mme_exp, mme_close = EXCLUDED.mme_close,
          rice_bv_open = EXCLUDED.rice_bv_open, rice_bv_recv = EXCLUDED.rice_bv_recv, rice_bv_cons = EXCLUDED.rice_bv_cons, rice_bv_close = EXCLUDED.rice_bv_close,
          rice_p_open = EXCLUDED.rice_p_open, rice_p_recv = EXCLUDED.rice_p_recv, rice_p_cons = EXCLUDED.rice_p_cons, rice_p_close = EXCLUDED.rice_p_close,
          rice_up_open = EXCLUDED.rice_up_open, rice_up_recv = EXCLUDED.rice_up_recv, rice_up_cons = EXCLUDED.rice_up_cons, rice_up_close = EXCLUDED.rice_up_close
        RETURNING (xmax = 0) AS was_inserted;
      `;

      const vals = [
        month, year, udise, schoolName, circleName, gpName,
        bvDays, pDays, upDays, bvAct, pAct, upAct, bvMeals, pMeals, upMeals,
        ccBvOpen, ccBvRecv, ccBvExp, ccBvClose,
        ccPOpen, ccPRecv, ccPExp, ccPClose,
        ccUpOpen, ccUpRecv, ccUpExp, ccUpClose,
        cchOpen, cchRecv, cchExp, cchClose,
        mmeOpen, mmeRecv, mmeExp, mmeClose,
        rBvOpen, rBvRecv, rBvCons, rBvClose,
        rPOpen, rPRecv, rPCons, rPClose,
        rUpOpen, rUpRecv, rUpCons, rUpClose
      ];

      let wasInserted = true;
      try {
        const insertRes = await pool.query(q, vals);
        if (insertRes.rows.length > 0) {
          wasInserted = Boolean(insertRes.rows[0].was_inserted);
        }
      } catch (upsertErr) {
        // Fallback update if conflict handling encountered non-unique index
        await pool.query(
          'UPDATE public.mdm_monthly_report SET school_name = $1, p_days = $2, p_actual = $3, p_meals = $4, rice_p_close = $5 WHERE u_dise = $6 AND month_name = $7 AND year = $8',
          [schoolName, pDays, pAct, pMeals, rPClose, udise, month, year]
        );
        wasInserted = false;
      }
      processed++;
      if (wasInserted) {
        insertedCount++;
      } else {
        updatedCount++;
      }
    }

    return sendUploadResponse('success', `File uploaded successfully! (${processed} records: ${insertedCount} inserted, ${updatedCount} updated)`, processed, {
      total: processed,
      inserted: insertedCount,
      updated: updatedCount
    });
  } catch (err) {
    console.error('Error handling CSV upload:', err.message);
    return sendUploadResponse('error', 'Error processing CSV: ' + err.message);
  }
};

const uploadCsvMulter = upload.fields([
  { name: 'file_primary', maxCount: 1 },
  { name: 'file_upper', maxCount: 1 },
  { name: 'file', maxCount: 1 }
]);

router.post('/upload_csv_handler.php', requireAuth('main'), uploadCsvMulter, handleUploadCsv);
router.post('/upload_csv.php', requireAuth('main'), uploadCsvMulter, handleUploadCsv);
router.post('/upload_csv', requireAuth('main'), uploadCsvMulter, handleUploadCsv);
router.post('/monthly-report/upload-csv', requireAuth('main'), uploadCsvMulter, handleUploadCsv);

// ==========================================
// 10. Recent Monthly Reports Query
// ==========================================
router.get('/monthly-report/recent', async (req, res) => {
  const month = (req.query?.month || '').trim();
  const year = (req.query?.year || '').trim();

  try {
    let q = 'SELECT * FROM public.mdm_monthly_report';
    const params = [];
    if (month && year) {
      q += ' WHERE LOWER(month_name) = LOWER($1) AND year = $2';
      params.push(month, year);
    } else if (month) {
      q += ' WHERE LOWER(month_name) = LOWER($1)';
      params.push(month);
    }
    q += ' ORDER BY id DESC LIMIT 50';

    const { rows } = await pool.query(q, params);
    return res.json({ status: 'success', data: rows });
  } catch (err) {
    console.error('Error fetching recent monthly reports:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// Legacy save_data.php handler (insert into mdcf_data)
async function handleSaveLegacyMdcfData(req, res) {
  const monthName = (req.body?.month_name || '').trim();
  const schoolName = (req.body?.school_name || '').trim();
  const riceReceived = toFloat(req.body?.rice_received || 0);
  const riceConsumed = toFloat(req.body?.rice_consumed || 0);
  const closingBalance = toFloat(req.body?.closing_balance || 0);

  try {
    await pool.query(
      `INSERT INTO public.mdcf_data (month_name, school_name, rice_received, rice_consumed, closing_balance)
       VALUES ($1, $2, $3, $4, $5)`,
      [monthName, schoolName, riceReceived, riceConsumed, closingBalance]
    );
    if (req.headers.accept?.includes('application/json')) {
      return res.json({ status: 'success', message: 'Data saved successfully!' });
    }
    return res.send("<script>alert('Data saved successfully!'); window.location.href = '/';</script>");
  } catch (err) {
    console.error('Error saving mdcf_data:', err.message);
    if (req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ status: 'error', message: err.message });
    }
    return res.status(500).send("Error saving data: " + err.message);
  }
}

router.post(['/save_data.php', '/save-data', '/api/save-data', '/api/mdcf/save'], upload.none(), handleSaveLegacyMdcfData);

// Full MDCF monthly CSV upload endpoint
router.post(['/upload_monthly_report.php', '/api/monthly-report/upload-full-csv', '/monthly-report/upload-full-csv'], requireAuth('main'), upload.single('csv_file'), async (req, res) => {
  const fileObj = req.file;
  const month = (req.body?.month || new Date().toLocaleString('en-US', { month: 'long' })).trim();
  const year = (req.body?.year || String(new Date().getFullYear())).trim();
  const isAjax = req.headers.accept?.includes('application/json') || req.body?.ajax === '1';

  const sendResp = (status, msg, inserted = 0, updated = 0) => {
    if (isAjax) {
      return res.json({ status, message: msg, inserted, updated });
    }
    const param = status === 'success' ? 'msg' : 'err';
    return res.redirect(`/upload_monthly_report?${param}=${encodeURIComponent(msg)}&month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`);
  };

  if (!fileObj || !fileObj.buffer) {
    return sendResp('error', 'No file was uploaded.');
  }

  try {
    const text = fileObj.buffer.toString('utf8');
    const rows = parseCSV(text);
    if (rows.length < 2) {
      return sendResp('error', 'CSV file is empty or missing data rows.');
    }

    const schoolMap = await getSchoolsMap();
    const header = rows[0];
    const colIndex = {};
    header.forEach((col, idx) => {
      const cleanKey = col.toLowerCase().replace(/[^a-zA-Z0-9_]/g, '_').trim();
      colIndex[cleanKey] = idx;
    });

    const getVal = (row, key, fallbackIdx) => {
      if (colIndex[key] !== undefined && row[colIndex[key]] !== undefined) {
        return row[colIndex[key]];
      }
      return fallbackIdx !== undefined && row[fallbackIdx] !== undefined ? row[fallbackIdx] : '';
    };

    let processed = 0;
    const dataRows = rows.slice(1);
    for (const r of dataRows) {
      const udise = extractUdise(getVal(r, 'u_dise', 0) || getVal(r, 'udise_code', 0) || getVal(r, 'udise', 0));
      if (!udise) continue;

      const master = schoolMap[udise] || {};
      const schoolName = master.school_name || getVal(r, 'school_name', 1) || `School (${udise})`;
      const circleName = master.circle_name || getVal(r, 'circle_name', 3) || 'N/A';
      const gpName = master.gp_name || getVal(r, 'gp_name', 4) || 'N/A';
      const rowMonth = getVal(r, 'month_name', 5) || month;
      const rowYear = getVal(r, 'year', 6) || year;

      const q = `
        INSERT INTO public.mdm_monthly_report (
          month_name, year, u_dise, school_name, circle_name, gp_name,
          bv_days, p_days, up_days, bv_actual, p_actual, up_actual, bv_meals, p_meals, up_meals,
          cc_bv_open, cc_bv_recv, cc_bv_exp, cc_bv_close,
          cc_p_open, cc_p_recv, cc_p_exp, cc_p_close,
          cc_up_open, cc_up_recv, cc_up_exp, cc_up_close,
          cch_open, cch_recv, cch_exp, cch_close,
          mme_open, mme_recv, mme_exp, mme_close,
          bi_open, bi_recv, bi_exp, bi_close,
          lpg_open, lpg_recv, lpg_exp, lpg_close,
          nutri_open, nutri_recv, nutri_exp, nutri_close,
          kd_open, kd_recv, kd_exp, kd_close,
          ks_open, ks_recv, ks_exp, ks_close,
          ng_open, ng_recv, ng_exp, ng_close,
          bc_open, bc_recv, bc_exp, bc_close,
          bank_match, bank_passbook_balance, bank_balance_date,
          rice_bv_open, rice_bv_recv, rice_bv_cons, rice_bv_close,
          rice_p_open, rice_p_recv, rice_p_cons, rice_p_close,
          rice_up_open, rice_up_recv, rice_up_cons, rice_up_close
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
          $28, $29, $30, $31, $32, $33, $34, $35,
          $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47,
          $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59,
          $60, $61, $62,
          $63, $64, $65, $66, $67, $68, $69, $70, $71, $72, $73, $74
        )
        ON CONFLICT (u_dise, month_name, year) DO UPDATE SET
          school_name = EXCLUDED.school_name, circle_name = EXCLUDED.circle_name, gp_name = EXCLUDED.gp_name,
          bv_days = EXCLUDED.bv_days, p_days = EXCLUDED.p_days, up_days = EXCLUDED.up_days,
          bv_actual = EXCLUDED.bv_actual, p_actual = EXCLUDED.p_actual, up_actual = EXCLUDED.up_actual,
          bv_meals = EXCLUDED.bv_meals, p_meals = EXCLUDED.p_meals, up_meals = EXCLUDED.up_meals,
          cc_bv_open = EXCLUDED.cc_bv_open, cc_bv_recv = EXCLUDED.cc_bv_recv, cc_bv_exp = EXCLUDED.cc_bv_exp, cc_bv_close = EXCLUDED.cc_bv_close,
          cc_p_open = EXCLUDED.cc_p_open, cc_p_recv = EXCLUDED.cc_p_recv, cc_p_exp = EXCLUDED.cc_p_exp, cc_p_close = EXCLUDED.cc_p_close,
          cc_up_open = EXCLUDED.cc_up_open, cc_up_recv = EXCLUDED.cc_up_recv, cc_up_exp = EXCLUDED.cc_up_exp, cc_up_close = EXCLUDED.cc_up_close,
          cch_open = EXCLUDED.cch_open, cch_recv = EXCLUDED.cch_recv, cch_exp = EXCLUDED.cch_exp, cch_close = EXCLUDED.cch_close,
          mme_open = EXCLUDED.mme_open, mme_recv = EXCLUDED.mme_recv, mme_exp = EXCLUDED.mme_exp, mme_close = EXCLUDED.mme_close,
          bi_open = EXCLUDED.bi_open, bi_recv = EXCLUDED.bi_recv, bi_exp = EXCLUDED.bi_exp, bi_close = EXCLUDED.bi_close,
          lpg_open = EXCLUDED.lpg_open, lpg_recv = EXCLUDED.lpg_recv, lpg_exp = EXCLUDED.lpg_exp, lpg_close = EXCLUDED.lpg_close,
          nutri_open = EXCLUDED.nutri_open, nutri_recv = EXCLUDED.nutri_recv, nutri_exp = EXCLUDED.nutri_exp, nutri_close = EXCLUDED.nutri_close,
          kd_open = EXCLUDED.kd_open, kd_recv = EXCLUDED.kd_recv, kd_exp = EXCLUDED.kd_exp, kd_close = EXCLUDED.kd_close,
          ks_open = EXCLUDED.ks_open, ks_recv = EXCLUDED.ks_recv, ks_exp = EXCLUDED.ks_exp, ks_close = EXCLUDED.ks_close,
          ng_open = EXCLUDED.ng_open, ng_recv = EXCLUDED.ng_recv, ng_exp = EXCLUDED.ng_exp, ng_close = EXCLUDED.ng_close,
          bc_open = EXCLUDED.bc_open, bc_recv = EXCLUDED.bc_recv, bc_exp = EXCLUDED.bc_exp, bc_close = EXCLUDED.bc_close,
          bank_match = EXCLUDED.bank_match, bank_passbook_balance = EXCLUDED.bank_passbook_balance, bank_balance_date = EXCLUDED.bank_balance_date,
          rice_bv_open = EXCLUDED.rice_bv_open, rice_bv_recv = EXCLUDED.rice_bv_recv, rice_bv_cons = EXCLUDED.rice_bv_cons, rice_bv_close = EXCLUDED.rice_bv_close,
          rice_p_open = EXCLUDED.rice_p_open, rice_p_recv = EXCLUDED.rice_p_recv, rice_p_cons = EXCLUDED.rice_p_cons, rice_p_close = EXCLUDED.rice_p_close,
          rice_up_open = EXCLUDED.rice_up_open, rice_up_recv = EXCLUDED.rice_up_recv, rice_up_cons = EXCLUDED.rice_up_cons, rice_up_close = EXCLUDED.rice_up_close;
      `;

      const vals = [
        rowMonth, rowYear, udise, schoolName, circleName, gpName,
        toInt(getVal(r, 'bv_days', 7)), toInt(getVal(r, 'p_days', 8)), toInt(getVal(r, 'up_days', 9)),
        toInt(getVal(r, 'bv_actual', 10)), toInt(getVal(r, 'p_actual', 11)), toInt(getVal(r, 'up_actual', 12)),
        toInt(getVal(r, 'bv_meals', 13)), toInt(getVal(r, 'p_meals', 14)), toInt(getVal(r, 'up_meals', 15)),
        toFloat(getVal(r, 'cc_bv_open', 16)), toFloat(getVal(r, 'cc_bv_recv', 17)), toFloat(getVal(r, 'cc_bv_exp', 18)), toFloat(getVal(r, 'cc_bv_close', 19)),
        toFloat(getVal(r, 'cc_p_open', 20)), toFloat(getVal(r, 'cc_p_recv', 21)), toFloat(getVal(r, 'cc_p_exp', 22)), toFloat(getVal(r, 'cc_p_close', 23)),
        toFloat(getVal(r, 'cc_up_open', 24)), toFloat(getVal(r, 'cc_up_recv', 25)), toFloat(getVal(r, 'cc_up_exp', 26)), toFloat(getVal(r, 'cc_up_close', 27)),
        toFloat(getVal(r, 'cch_open')), toFloat(getVal(r, 'cch_recv')), toFloat(getVal(r, 'cch_exp')), toFloat(getVal(r, 'cch_close')),
        toFloat(getVal(r, 'mme_open', 40)), toFloat(getVal(r, 'mme_recv', 41)), toFloat(getVal(r, 'mme_exp', 42)), toFloat(getVal(r, 'mme_close', 43)),
        toFloat(getVal(r, 'bi_open', 28)), toFloat(getVal(r, 'bi_recv', 29)), toFloat(getVal(r, 'bi_exp', 30)), toFloat(getVal(r, 'bi_close', 31)),
        toFloat(getVal(r, 'lpg_open', 32)), toFloat(getVal(r, 'lpg_recv', 33)), toFloat(getVal(r, 'lpg_exp', 34)), toFloat(getVal(r, 'lpg_close', 35)),
        toFloat(getVal(r, 'nutri_open', 36)), toFloat(getVal(r, 'nutri_recv', 37)), toFloat(getVal(r, 'nutri_exp', 38)), toFloat(getVal(r, 'nutri_close', 39)),
        toFloat(getVal(r, 'kd_open', 44)), toFloat(getVal(r, 'kd_recv', 45)), toFloat(getVal(r, 'kd_exp', 46)), toFloat(getVal(r, 'kd_close', 47)),
        toFloat(getVal(r, 'ks_open', 48)), toFloat(getVal(r, 'ks_recv', 49)), toFloat(getVal(r, 'ks_exp', 50)), toFloat(getVal(r, 'ks_close', 51)),
        toFloat(getVal(r, 'ng_open', 52)), toFloat(getVal(r, 'ng_recv', 53)), toFloat(getVal(r, 'ng_exp', 54)), toFloat(getVal(r, 'ng_close', 55)),
        toFloat(getVal(r, 'bc_open', 56)), toFloat(getVal(r, 'bc_recv', 57)), toFloat(getVal(r, 'bc_exp', 58)), toFloat(getVal(r, 'bc_close', 59)),
        getVal(r, 'bank_match', 62) || 'YES', toFloat(getVal(r, 'bank_passbook_balance', 60)), getVal(r, 'bank_balance_date', 61) || new Date().toISOString().slice(0, 10),
        toFloat(getVal(r, 'rice_bv_open', 63)), toFloat(getVal(r, 'rice_bv_recv', 64)), toFloat(getVal(r, 'rice_bv_cons', 65)), toFloat(getVal(r, 'rice_bv_close', 66)),
        toFloat(getVal(r, 'rice_p_open', 67)), toFloat(getVal(r, 'rice_p_recv', 68)), toFloat(getVal(r, 'rice_p_cons', 69)), toFloat(getVal(r, 'rice_p_close', 70)),
        toFloat(getVal(r, 'rice_up_open', 71)), toFloat(getVal(r, 'rice_up_recv', 72)), toFloat(getVal(r, 'rice_up_cons', 73)), toFloat(getVal(r, 'rice_up_close', 74))
      ];

      try {
        await pool.query(q, vals);
      } catch (upsertErr) {
        // Fallback update
        await pool.query(
          'UPDATE public.mdm_monthly_report SET school_name = $1, p_days = $2, p_actual = $3, p_meals = $4, rice_p_close = $5 WHERE u_dise = $6 AND month_name = $7 AND year = $8',
          [schoolName, toInt(getVal(r, 'p_days')), toInt(getVal(r, 'p_actual')), toInt(getVal(r, 'p_meals')), toFloat(getVal(r, 'rice_p_close')), udise, rowMonth, rowYear]
        );
      }
      processed++;
    }

    return sendResp('success', `Successfully processed ${processed} school records.`, processed);
  } catch (err) {
    console.error('Error handling monthly report CSV upload:', err.message);
    return sendResp('error', 'Error processing CSV: ' + err.message);
  }
});

// ==========================================
// 11. Infrastructure Helper Routes (Fast Recent Updates & Config)
// ==========================================
async function handleRecentInfra(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT u_dise, school_name, circle_name, last_updated FROM public.school_infrastructure ORDER BY last_updated DESC LIMIT 10'
    );
    return res.json({ status: 'success', data: rows });
  } catch (err) {
    console.error('Error fetching recent infrastructure updates:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

router.get('/infrastructure/recent', handleRecentInfra);

router.get('/infrastructure/config', (req, res) => {
  const configPath = path.join(__dirname, '..', 'infrastructure_fields_config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return res.json({ status: 'success', data: cfg, config: cfg });
    } catch (e) {}
  }
  return res.json({ status: 'success', data: {}, config: {} });
});

router.post('/infrastructure/config', requireAuth('main'), (req, res) => {
  try {
    const configPath = path.join(__dirname, '..', 'infrastructure_fields_config.json');
    const toSave = req.body?.config || req.body || {};
    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf8');
    return res.json({ status: 'success', message: 'Configuration saved' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

module.exports = router;
