const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { pool, getSchools, getSchoolsMap, clearSchoolsCache } = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { uploadToGoogleDriveDirect, getGoogleAccessToken } = require('../services/googleDriveService');
const {
  getSafeGoogleDriveStatus,
  verifyGoogleDriveConnection,
  saveGoogleDriveToken,
  getDecryptedRefreshToken,
  updateGoogleDriveTokenStatus,
  getGoogleDriveTokenRecord
} = require('../services/googleDriveTokenManager');

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
// 2.5 Monthly Report Field Lock Config (Meal Availed Status)
// ==========================================
const MONTHLY_REPORT_LOCK_FIELDS = [
  { key: 'pri_bv_days', category: 'primary', field_name: 'bv_days', label: 'Number of School Days during Month (Bal Vatika PP)' },
  { key: 'pri_p_days', category: 'primary', field_name: 'p_days', label: 'Number of School Days during Month (Primary I-IV)' },
  { key: 'pri_bv_actual', category: 'primary', field_name: 'bv_actual', label: 'Actual Number of Days MDM Served (Bal Vatika PP)' },
  { key: 'pri_p_actual', category: 'primary', field_name: 'p_actual', label: 'Actual Number of Days MDM Served (Primary I-IV)' },
  { key: 'pri_bv_meals', category: 'primary', field_name: 'bv_meals', label: 'Total Meals Served during Month (Bal Vatika PP)' },
  { key: 'pri_p_meals', category: 'primary', field_name: 'p_meals', label: 'Total Meals Served during Month (Primary I-IV)' },
  { key: 'upr_p_days', category: 'upper_primary', field_name: 'p_days', label: 'Number of School Days during Month (Primary V)' },
  { key: 'upr_up_days', category: 'upper_primary', field_name: 'up_days', label: 'Number of School Days during Month (Upper Primary VI-VIII)' },
  { key: 'upr_p_actual', category: 'upper_primary', field_name: 'p_actual', label: 'Actual Number of Days MDM Served (Primary V)' },
  { key: 'upr_up_actual', category: 'upper_primary', field_name: 'up_actual', label: 'Actual Number of Days MDM Served (Upper Primary VI-VIII)' },
  { key: 'upr_p_meals', category: 'upper_primary', field_name: 'p_meals', label: 'Total Meals Served during Month (Primary V)' },
  { key: 'upr_up_meals', category: 'upper_primary', field_name: 'up_meals', label: 'Total Meals Served during Month (Upper Primary VI-VIII)' }
];

async function handleGetMonthlyReportLockConfig(req, res) {
  try {
    const category = (req.query.category || '').toLowerCase().trim();
    let query = 'SELECT key, category, field_name, label, is_locked, updated_at FROM public.monthly_report_field_config';
    const params = [];
    if (category) {
      query += ' WHERE category = $1';
      params.push(category);
    }
    query += ' ORDER BY key ASC';

    const { rows } = await pool.query(query, params);
    const configMap = {};
    rows.forEach(r => {
      configMap[r.key] = Boolean(r.is_locked);
    });

    MONTHLY_REPORT_LOCK_FIELDS.forEach(f => {
      if ((!category || f.category === category) && configMap[f.key] === undefined) {
        configMap[f.key] = false;
      }
    });

    return res.json({
      status: 'success',
      category: category || 'all',
      config: configMap,
      fields: rows.length > 0 ? rows : MONTHLY_REPORT_LOCK_FIELDS.filter(f => !category || f.category === category)
    });
  } catch (err) {
    console.error('Error loading monthly report field lock config:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to load lock settings: ' + err.message });
  }
}

async function handleSaveMonthlyReportLockConfig(req, res) {
  try {
    const payload = req.body || {};
    let incomingConfig = payload.config !== undefined ? payload.config : payload.locks !== undefined ? payload.locks : payload;

    if (Array.isArray(incomingConfig)) {
      const map = {};
      incomingConfig.forEach(item => {
        if (item && item.key) {
          map[item.key] = item.is_locked;
        }
      });
      incomingConfig = map;
    }

    const keys = Object.keys(incomingConfig || {});
    if (keys.length === 0) {
      return res.json({
        status: 'success',
        message: 'Monthly report lock settings updated successfully!',
        config: {}
      });
    }

    const updatedConfig = {};
    const keyArray = [];
    const lockArray = [];
    const categoryArray = [];
    const fieldNameArray = [];

    for (const key of keys) {
      const val = incomingConfig[key];
      const isLocked = val === true || val === 'true' || val === 1 || val === '1' || val === 'on';
      updatedConfig[key] = isLocked;

      const isPri = key.startsWith('pri_');
      const category = isPri ? 'primary' : 'upper_primary';
      const field_name = key.replace(/^(pri_|upr_)/, '');

      keyArray.push(key);
      lockArray.push(isLocked);
      categoryArray.push(category);
      fieldNameArray.push(field_name);
    }

    // High-performance single-query bulk upsert using PostgreSQL UNNEST
    await pool.query(`
      INSERT INTO public.monthly_report_field_config (key, category, field_name, label, is_locked, updated_at)
      SELECT 
        v.k,
        v.cat,
        v.fn,
        v.k,
        v.locked,
        NOW()
      FROM (
        SELECT 
          UNNEST($1::text[]) AS k,
          UNNEST($2::text[]) AS cat,
          UNNEST($3::text[]) AS fn,
          UNNEST($4::boolean[]) AS locked
      ) AS v
      ON CONFLICT (key) DO UPDATE SET 
        is_locked = EXCLUDED.is_locked, 
        updated_at = NOW()
    `, [keyArray, categoryArray, fieldNameArray, lockArray]);

    return res.json({
      status: 'success',
      message: 'Monthly report lock settings updated successfully!',
      config: updatedConfig
    });
  } catch (err) {
    console.error('Error saving monthly report field lock config:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to save lock settings: ' + err.message });
  }
}

router.get(['/monthly-report/lock-config', '/api/monthly-report/lock-config'], handleGetMonthlyReportLockConfig);
router.post(['/monthly-report/lock-config', '/api/monthly-report/lock-config'], requireAuth('main'), handleSaveMonthlyReportLockConfig);

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

    // Lock enforcement for Meal Availed Status and Fund Details fields
    try {
      const cat = (master.school_category || master.category || '').toUpperCase();
      const isPrimary = (cat.includes('PRIMARY') && !cat.includes('UPPER')) || cat === 'PRIMARY';
      const categoryType = isPrimary ? 'primary' : 'upper_primary';

      const { rows: lockRows } = await pool.query(
        'SELECT key, field_name, is_locked FROM public.monthly_report_field_config WHERE category = $1',
        [categoryType]
      );
      const lockMap = {};
      lockRows.forEach(lr => {
        lockMap[lr.field_name] = Boolean(lr.is_locked);
      });

      const { rows: existingRows } = await pool.query(
        'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3 LIMIT 1',
        [udise, month, year]
      );
      const existing = existingRows[0] || null;

      if (existing) {
        Object.keys(lockMap).forEach(fn => {
          if (lockMap[fn] && existing[fn] !== null && existing[fn] !== undefined) {
            b[fn] = existing[fn];
          }
        });
      }
    } catch (lockCheckErr) {
      console.warn('Could not enforce field lock checks on monthly report save:', lockCheckErr.message);
    }

    const fundDetailsObj = {
      material_cost_bv: { open: toFloat(b.cc_bv_open), recv: toFloat(b.cc_bv_recv), exp: toFloat(b.cc_bv_exp), close: toFloat(b.cc_bv_close) },
      material_cost_p: { open: toFloat(b.cc_p_open), recv: toFloat(b.cc_p_recv), exp: toFloat(b.cc_p_exp), close: toFloat(b.cc_p_close) },
      cook_cum_helper: { open: toFloat(b.cch_open), recv: toFloat(b.cch_recv), exp: toFloat(b.cch_exp), close: toFloat(b.cch_close) },
      material_cost_up: { open: toFloat(b.cc_up_open), recv: toFloat(b.cc_up_recv), exp: toFloat(b.cc_up_exp), close: toFloat(b.cc_up_close) },
      bank_interest: { open: toFloat(b.bi_open), recv: toFloat(b.bi_recv), exp: toFloat(b.bi_exp), close: toFloat(b.bi_close) },
      lpg_subsidy: { open: toFloat(b.lpg_open), recv: toFloat(b.lpg_recv), exp: toFloat(b.lpg_exp), close: toFloat(b.lpg_close) },
      supplementary_nutrition: { open: toFloat(b.nutri_open), recv: toFloat(b.nutri_recv), exp: toFloat(b.nutri_exp), close: toFloat(b.nutri_close) },
      school_expenses_mme: { open: toFloat(b.mme_open), recv: toFloat(b.mme_recv), exp: toFloat(b.mme_exp), close: toFloat(b.mme_close) },
      kitchen_devices: { open: toFloat(b.kd_open), recv: toFloat(b.kd_recv), exp: toFloat(b.kd_exp), close: toFloat(b.kd_close) },
      kitchen_shed_repair: { open: toFloat(b.ks_open), recv: toFloat(b.ks_recv), exp: toFloat(b.ks_exp), close: toFloat(b.ks_close) },
      nutrition_garden: { open: toFloat(b.ng_open), recv: toFloat(b.ng_recv), exp: toFloat(b.ng_exp), close: toFloat(b.ng_close) },
      bank_charges: { open: toFloat(b.bc_open), recv: toFloat(b.bc_recv), exp: toFloat(b.bc_exp), close: toFloat(b.bc_close) },
      others: { open: toFloat(b.oth_open || b.others_open), recv: toFloat(b.oth_recv || b.others_recv), exp: toFloat(b.oth_exp || b.others_exp), close: toFloat(b.oth_close || b.others_close) },
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
        oth_open, oth_recv, oth_exp, oth_close,
        bank_match, bank_passbook_balance, bank_balance_date, fund_details_json,
        rice_bv_open, rice_bv_recv, rice_bv_cons, rice_bv_close,
        rice_p_open, rice_p_recv, rice_p_cons, rice_p_close,
        rice_up_open, rice_up_recv, rice_up_cons, rice_up_close,
        passbook_photo_file_id, passbook_photo_url,
        ifa_boys, ifa_girls, rbsk_screened, rbsk_referred,
        inspection_done, insp_task_force, insp_district_officials, insp_block_officials, insp_smc_members,
        untoward_incidents
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
        $80, $81, $82, $83,
        $84, $85,
        $86, $87, $88, $89,
        $90, $91, $92, $93, $94,
        $95
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
        oth_open = EXCLUDED.oth_open, oth_recv = EXCLUDED.oth_recv, oth_exp = EXCLUDED.oth_exp, oth_close = EXCLUDED.oth_close,
        bank_match = EXCLUDED.bank_match, bank_passbook_balance = EXCLUDED.bank_passbook_balance, bank_balance_date = EXCLUDED.bank_balance_date, fund_details_json = EXCLUDED.fund_details_json,
        rice_bv_open = EXCLUDED.rice_bv_open, rice_bv_recv = EXCLUDED.rice_bv_recv, rice_bv_cons = EXCLUDED.rice_bv_cons, rice_bv_close = EXCLUDED.rice_bv_close,
        rice_p_open = EXCLUDED.rice_p_open, rice_p_recv = EXCLUDED.rice_p_recv, rice_p_cons = EXCLUDED.rice_p_cons, rice_p_close = EXCLUDED.rice_p_close,
        rice_up_open = EXCLUDED.rice_up_open, rice_up_recv = EXCLUDED.rice_up_recv, rice_up_cons = EXCLUDED.rice_up_cons, rice_up_close = EXCLUDED.rice_up_close,
        passbook_photo_file_id = COALESCE(EXCLUDED.passbook_photo_file_id, public.mdm_monthly_report.passbook_photo_file_id),
        passbook_photo_url = COALESCE(EXCLUDED.passbook_photo_url, public.mdm_monthly_report.passbook_photo_url),
        ifa_boys = EXCLUDED.ifa_boys,
        ifa_girls = EXCLUDED.ifa_girls,
        rbsk_screened = EXCLUDED.rbsk_screened,
        rbsk_referred = EXCLUDED.rbsk_referred,
        inspection_done = EXCLUDED.inspection_done,
        insp_task_force = EXCLUDED.insp_task_force,
        insp_district_officials = EXCLUDED.insp_district_officials,
        insp_block_officials = EXCLUDED.insp_block_officials,
        insp_smc_members = EXCLUDED.insp_smc_members,
        untoward_incidents = EXCLUDED.untoward_incidents;
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
      toFloat(b.oth_open || b.others_open), toFloat(b.oth_recv || b.others_recv), toFloat(b.oth_exp || b.others_exp), toFloat(b.oth_close || b.others_close),
      String(b.bank_match || 'YES').trim(), toFloat(b.bank_passbook_balance), String(b.bank_balance_date || '').trim(), JSON.stringify(fundDetailsObj),
      toFloat(b.rice_bv_open), toFloat(b.rice_bv_recv), toFloat(b.rice_bv_cons), toFloat(b.rice_bv_close),
      toFloat(b.rice_p_open), toFloat(b.rice_p_recv), toFloat(b.rice_p_cons), toFloat(b.rice_p_close),
      toFloat(b.rice_up_open), toFloat(b.rice_up_recv), toFloat(b.rice_up_cons), toFloat(b.rice_up_close),
      b.passbook_photo_file_id ? String(b.passbook_photo_file_id).trim() : null,
      b.passbook_photo_url ? String(b.passbook_photo_url).trim() : null,
      toInt(b.ifa_boys),
      toInt(b.ifa_girls),
      toInt(b.rbsk_screened),
      toInt(b.rbsk_referred),
      String(b.inspection_done || 'No').trim(),
      toInt(b.insp_task_force),
      toInt(b.insp_district_officials),
      toInt(b.insp_block_officials),
      toInt(b.insp_smc_members),
      toInt(b.untoward_incidents)
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

    if (b.passbook_photo_file_id) {
      try {
        await pool.query(`
          INSERT INTO public.bank_passbook_submissions (
            school_id, school_name, drive_file_id, file_name, file_url, submission_status, submitted_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, 'Submitted', NOW(), NOW()
          )
          ON CONFLICT (school_id) DO UPDATE SET
            school_name = EXCLUDED.school_name,
            drive_file_id = EXCLUDED.drive_file_id,
            file_url = EXCLUDED.file_url,
            submission_status = 'Submitted',
            updated_at = NOW();
        `, [
          udise,
          schoolName,
          String(b.passbook_photo_file_id).trim(),
          b.bank_passbook_photo_name || `${(schoolName || ('School_' + udise)).replace(/[\\/:*?"<>|]/g, '-').trim()}.jpg`,
          b.passbook_photo_url || `https://drive.google.com/file/d/${String(b.passbook_photo_file_id).trim()}/view`
        ]);
      } catch (subErr) {
        console.warn('Warning: could not update bank_passbook_submissions from save report:', subErr.message);
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

    // 5. Direct Google Drive API Upload (No Google Script Required)
    let fileId = null;
    let fileUrl = null;
    const tServerStart = Date.now();
    let driveDuration = 0;
    let dbDuration = 0;

    const normalizedExt = isPng ? 'png' : (isWebp ? 'webp' : 'jpg');
    // Save file as school name.format (e.g., "ABADPARA PRIMARY SCHOOL.jpg")
    const sanitizedSchoolName = (schoolName || `School_${udise}`).replace(/[\\/:*?"<>|]/g, '-').trim();
    const driveFileName = `${sanitizedSchoolName}.${normalizedExt}`;

    const hasServiceAccount = !!(
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || 
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) ||
      fs.existsSync(path.join(process.cwd(), 'google-service-account.json')) ||
      fs.existsSync(path.join(process.cwd(), 'service-account.json')) ||
      fs.existsSync(path.join(process.cwd(), 'credentials.json'))
    );
    const hasOAuth = !!((process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) || process.env.GOOGLE_REFRESH_TOKEN);
    const gasUrl = process.env.GOOGLE_DRIVE_WEBAPP_URL;

    if (hasServiceAccount || hasOAuth) {
      // Direct Google Drive API v3 (Official REST API with Service Account or OAuth2)
      try {
        const tDriveStart = Date.now();
        const driveResult = await uploadToGoogleDriveDirect({
          buffer,
          mimeType: isPng ? 'image/png' : (isWebp ? 'image/webp' : 'image/jpeg'),
          fileName: driveFileName,
          folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '1-RN90axSxvIkYQMIrCp9BESAbw_ty2m6',
          description: `Bank Passbook Photo\nUDISE: ${udise}\nSchool: ${schoolName}\nPeriod: ${month} ${year}`
        });
        driveDuration = Date.now() - tDriveStart;
        fileId = driveResult.fileId;
        fileUrl = driveResult.viewUrl || driveResult.fileUrl;
      } catch (driveErr) {
        console.error('Google Drive direct upload error:', driveErr.message);
        return res.status(502).json({
          status: 'error',
          message: 'Google Drive API upload failed: ' + driveErr.message
        });
      }
    } else if (gasUrl) {
      // Fallback: Google Apps Script Web App Gateway if configured
      const gasToken = process.env.GOOGLE_DRIVE_UPLOAD_TOKEN || '';
      const drivePayload = {
        token: gasToken,
        fileBase64: buffer.toString('base64'),
        mimeType: isPng ? 'image/png' : (isWebp ? 'image/webp' : 'image/jpeg'),
        fileName: driveFileName,
        udise: udise,
        month: month,
        year: year,
        schoolName: schoolName
      };

      try {
        const tDriveStart = Date.now();
        const driveRes = await fetch(gasUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(drivePayload)
        });
        driveDuration = Date.now() - tDriveStart;
        const driveText = await driveRes.text();
        const driveJson = JSON.parse(driveText);
        if (!driveRes.ok || driveJson.status !== 'success') {
          return res.status(driveRes.status >= 400 ? driveRes.status : 500).json({
            status: 'error',
            message: driveJson.message || 'Google Drive rejected photo upload.'
          });
        }
        fileId = driveJson.fileId;
        fileUrl = driveJson.viewUrl || driveJson.fileUrl || `https://drive.google.com/file/d/${fileId}/view`;
      } catch (gasErr) {
        return res.status(502).json({
          status: 'error',
          message: 'Google Drive upload error: ' + gasErr.message
        });
      }
    } else {
      return res.status(503).json({
        status: 'error',
        code: 'DRIVE_CONFIG_REQUIRED',
        message: 'Google Drive credentials not configured. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY, and GOOGLE_DRIVE_FOLDER_ID in your .env or Vercel Environment Variables.'
      });
    }

    // 6. Save Google Drive Photo Reference in Supabase PostgreSQL
    try {
      const tDbStart = Date.now();
      const photoMetaObj = {
        file_id: fileId,
        file_url: fileUrl,
        file_name: driveFileName,
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

      // Upsert authoritative bank_passbook_submissions table
      const trackerQuery = `
        INSERT INTO public.bank_passbook_submissions (
          school_id, school_name, drive_file_id, file_name, file_url, submission_status, submitted_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, 'Submitted', NOW(), NOW()
        )
        ON CONFLICT (school_id) DO UPDATE SET
          school_name = EXCLUDED.school_name,
          drive_file_id = EXCLUDED.drive_file_id,
          file_name = EXCLUDED.file_name,
          file_url = EXCLUDED.file_url,
          submission_status = 'Submitted',
          updated_at = NOW();
      `;

      const updateMdmPromise = pool.query(updateQuery, [fileId, fileUrl, JSON.stringify(photoMetaObj), udise, month, year])
        .then(async (updateRes) => {
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
        });

      await Promise.all([
        updateMdmPromise,
        pool.query(trackerQuery, [udise, schoolName, fileId, driveFileName, fileUrl])
      ]);
      dbDuration = Date.now() - tDbStart;
    } catch (dbErr) {
      console.error('Warning: could not update Supabase photo columns:', dbErr.message);
    }

    const totalServerDuration = Date.now() - tServerStart;

    return res.json({
      status: 'success',
      message: 'Bank passbook photo saved directly to Google Drive successfully.',
      fileId: fileId,
      fileUrl: fileUrl,
      fileName: driveFileName,
      submissionStatus: 'Submitted',
      submittedAt: new Date().toISOString(),
      timing: {
        drive_ms: driveDuration,
        db_ms: dbDuration,
        total_server_ms: totalServerDuration
      }
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

// Get Passbook Photo Status for a School (Used by update_monthly_report.html)
router.get(['/monthly-report/passbook-status', '/api/monthly-report/passbook-status'], async (req, res) => {
  try {
    const schoolId = String(req.query.school_id || req.query.udise || req.query.u_dise || '').trim();
    if (!schoolId) {
      return res.status(400).json({ status: 'error', message: 'school_id parameter is required' });
    }

    const { rows } = await pool.query(`
      SELECT school_id, school_name, drive_file_id, file_name, file_url, submission_status, submitted_at, updated_at
      FROM public.bank_passbook_submissions
      WHERE school_id = $1
      LIMIT 1
    `, [schoolId]);

    if (rows.length > 0 && rows[0].submission_status === 'Submitted') {
      return res.json({
        status: 'success',
        submission: rows[0]
      });
    }

    // Fallback check in mdm_monthly_report
    const mdmRes = await pool.query(`
      SELECT u_dise as school_id, school_name, passbook_photo_file_id as drive_file_id, passbook_photo_url as file_url,
             fund_details_json
      FROM public.mdm_monthly_report
      WHERE u_dise = $1 AND passbook_photo_file_id IS NOT NULL AND passbook_photo_file_id != ''
      ORDER BY id DESC LIMIT 1
    `, [schoolId]);

    if (mdmRes.rows.length > 0) {
      const r = mdmRes.rows[0];
      const fj = (typeof r.fund_details_json === 'string' ? JSON.parse(r.fund_details_json) : r.fund_details_json) || {};
      const sub = {
        school_id: r.school_id,
        school_name: r.school_name,
        drive_file_id: r.drive_file_id,
        file_name: (fj.passbook_photo && fj.passbook_photo.file_name && !fj.passbook_photo.file_name.toLowerCase().startsWith('passbook_')) ? fj.passbook_photo.file_name : `${(r.school_name || ('School_' + r.school_id)).replace(/[\\/:*?"<>|]/g, '-').trim()}.jpg`,
        file_url: r.file_url || `https://drive.google.com/file/d/${r.drive_file_id}/view`,
        submission_status: 'Submitted',
        submitted_at: (fj.passbook_photo && fj.passbook_photo.uploaded_at) || new Date().toISOString()
      };
      return res.json({
        status: 'success',
        submission: sub
      });
    }

    return res.json({
      status: 'success',
      submission: {
        school_id: schoolId,
        submission_status: 'Not Submitted',
        drive_file_id: null,
        file_url: null
      }
    });
  } catch (err) {
    console.error('Error fetching passbook status:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// Authenticated Stream for Passbook Image from Google Drive (for thumbnails and previews)
router.get(['/monthly-report/passbook-image', '/api/monthly-report/passbook-image'], async (req, res) => {
  try {
    const fileId = String(req.query.file_id || req.query.id || '').trim();
    if (!fileId) {
      return res.status(400).send('File ID is required');
    }

    const accessToken = await getGoogleAccessToken();
    const driveMediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

    const gRes = await fetch(driveMediaUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!gRes.ok) {
      return res.status(gRes.status >= 400 && gRes.status < 500 ? gRes.status : 502).send('Image unavailable');
    }

    const contentType = gRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    const arrayBuffer = await gRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Error streaming passbook image:', err.message);
    return res.status(500).send('Error loading image');
  }
});

// Admin Passbook Tracker API (Used by upload_monthly_report.html)
router.get(['/monthly-report/passbook-tracker', '/api/monthly-report/passbook-tracker'], requireAuth('main'), async (req, res) => {
  try {
    const masterSchools = await getSchools();

    const subRes = await pool.query(`
      SELECT school_id, school_name, drive_file_id, file_name, file_url, submission_status, submitted_at, updated_at
      FROM public.bank_passbook_submissions
    `);
    const subMap = new Map();
    for (const r of subRes.rows) {
      if (r.school_id) {
        subMap.set(String(r.school_id).trim(), r);
      }
    }

    // Sync any from mdm_monthly_report if not in bank_passbook_submissions
    const mdmPhotoRes = await pool.query(`
      SELECT u_dise, school_name, passbook_photo_file_id, passbook_photo_url, fund_details_json
      FROM public.mdm_monthly_report
      WHERE passbook_photo_file_id IS NOT NULL AND passbook_photo_file_id != ''
    `);
    for (const r of mdmPhotoRes.rows) {
      const udise = String(r.u_dise || '').trim();
      if (udise && !subMap.has(udise)) {
        const fj = (typeof r.fund_details_json === 'string' ? JSON.parse(r.fund_details_json) : r.fund_details_json) || {};
        const syntheticSub = {
          school_id: udise,
          school_name: r.school_name,
          drive_file_id: r.passbook_photo_file_id,
          file_name: (fj.passbook_photo && fj.passbook_photo.file_name && !fj.passbook_photo.file_name.toLowerCase().startsWith('passbook_')) ? fj.passbook_photo.file_name : `${(r.school_name || ('School_' + udise)).replace(/[\\/:*?"<>|]/g, '-').trim()}.jpg`,
          file_url: r.passbook_photo_url || `https://drive.google.com/file/d/${r.passbook_photo_file_id}/view`,
          submission_status: 'Submitted',
          submitted_at: (fj.passbook_photo && fj.passbook_photo.uploaded_at) || new Date().toISOString()
        };
        subMap.set(udise, syntheticSub);
        try {
          await pool.query(`
            INSERT INTO public.bank_passbook_submissions (
              school_id, school_name, drive_file_id, file_name, file_url, submission_status, submitted_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'Submitted', $6, NOW())
            ON CONFLICT (school_id) DO NOTHING
          `, [udise, syntheticSub.school_name, syntheticSub.drive_file_id, syntheticSub.file_name, syntheticSub.file_url, syntheticSub.submitted_at]);
        } catch (syncErr) {
          // ignore
        }
      }
    }

    let submittedCount = 0;
    const schoolsList = masterSchools.map((s, idx) => {
      const udise = String(s.udise || s.code || s.id || '').trim();
      const sub = subMap.get(udise);
      const isSubmitted = !!(sub && (sub.submission_status === 'Submitted' || sub.drive_file_id));
      if (isSubmitted) {
        submittedCount++;
      }

      return {
        sl_no: idx + 1,
        school_id: udise,
        udise_code: udise,
        school_name: s.name || s.school_name,
        category: s.category || 'N/A',
        circle_name: s.circle_name || s.circle || 'N/A',
        gp_name: s.gp_name || s.gp || 'N/A',
        status: isSubmitted ? 'Submitted' : 'Not Submitted',
        submitted_at: (isSubmitted && sub && sub.submitted_at) ? sub.submitted_at : null,
        drive_file_id: (isSubmitted && sub && sub.drive_file_id) ? sub.drive_file_id : null,
        file_url: (isSubmitted && sub && (sub.file_url || (sub.drive_file_id ? `https://drive.google.com/file/d/${sub.drive_file_id}/view` : null))) || null,
        file_name: (isSubmitted && sub && sub.file_name) ? sub.file_name : null
      };
    });

    const totalSchools = masterSchools.length;
    const notSubmittedCount = totalSchools - submittedCount;

    return res.json({
      status: 'success',
      summary: {
        total_schools: totalSchools,
        submitted: submittedCount,
        not_submitted: notSubmittedCount
      },
      generated_at: new Date().toISOString(),
      schools: schoolsList
    });
  } catch (err) {
    console.error('Error fetching passbook tracker data:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to retrieve passbook tracker data: ' + err.message });
  }
});

// Admin Passbook Tracker Excel Export Endpoint
router.get(['/monthly-report/passbook-tracker/excel', '/api/monthly-report/passbook-tracker/excel'], requireAuth('main'), async (req, res) => {
  try {
    const masterSchools = await getSchools();
    const subRes = await pool.query(`SELECT school_id, drive_file_id, file_url, submission_status, submitted_at FROM public.bank_passbook_submissions`);
    const subMap = new Map();
    for (const r of subRes.rows) {
      if (r.school_id) subMap.set(String(r.school_id).trim(), r);
    }

    const filename = `Bank_Passbook_Submission_Report_${new Date().toISOString().slice(0, 10)}.xls`;
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    let html = '\uFEFF<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    html += '<style>table{border-collapse:collapse;width:100%;font-family:Arial,sans-serif;}th,td{border:1px solid #000;padding:8px;}th{background-color:#0d9488;color:#fff;font-weight:bold;text-align:center;}td{text-align:left;}.center{text-align:center;}.sub{color:#166534;font-weight:bold;}.notsub{color:#991b1b;}</style></head><body>';
    html += `<h3 style="text-align:center;">Bank Passbook Submission Report</h3>`;
    html += `<p style="text-align:center;font-size:12px;color:#555;">Report Generated: ${new Date().toLocaleString('en-US')} | Total Schools: ${masterSchools.length}</p>`;
    html += '<table><thead><tr>';
    html += '<th>id</th><th>School Name</th><th>Category</th><th>udise_code</th><th>Circle Name</th><th>GP Name</th><th>Passbook Submission Status</th><th>Submission Date and Time</th><th>Passbook Photo Link</th>';
    html += '</tr></thead><tbody>';

    let sl = 1;
    for (const s of masterSchools) {
      const udise = String(s.udise || s.code || s.id || '').trim();
      const sub = subMap.get(udise);
      const isSub = !!(sub && (sub.submission_status === 'Submitted' || sub.drive_file_id));
      const dateStr = (isSub && sub.submitted_at) ? new Date(sub.submitted_at).toLocaleString('en-US') : 'Not Submitted';
      const photoLink = (isSub && (sub.file_url || (sub.drive_file_id ? `https://drive.google.com/file/d/${sub.drive_file_id}/view` : ''))) || 'N/A';

      html += `<tr>
        <td class="center">${sl++}</td>
        <td>${s.name || s.school_name || ''}</td>
        <td>${s.category || ''}</td>
        <td class="center">${udise}</td>
        <td>${s.circle_name || s.circle || ''}</td>
        <td>${s.gp_name || s.gp || ''}</td>
        <td class="center ${isSub ? 'sub' : 'notsub'}">${isSub ? 'Submitted' : 'Not Submitted'}</td>
        <td class="center">${dateStr}</td>
        <td>${photoLink !== 'N/A' ? `<a href="${photoLink}">${photoLink}</a>` : 'N/A'}</td>
      </tr>`;
    }

    html += '</tbody></table></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Error generating passbook tracker excel:', err.message);
    res.status(500).send('Error generating report: ' + err.message);
  }
});

// Download Monthly Template CSV (Supports All 246 schools, Primary 194 schools, Upper Primary 52 schools, or Blank)
async function handleDownloadTemplate(req, res) {
  const type = (req.query?.type || 'all').toLowerCase();
  const category = (req.query?.category || req.query?.school_type || '').toLowerCase();
  const month = (req.query?.month || new Date().toLocaleString('en-US', { month: 'long' })).trim();
  const year = (req.query?.year || String(new Date().getFullYear())).trim();

  const isPrimary = (category === 'primary' || type === 'primary');
  const isUpper = (category === 'upper' || category === 'upper_primary' || type === 'upper' || type === 'upper_primary');
  const isBlank = (type === 'blank');

  // Common MDCF components present in all school categories (32 columns)
  const commonFundHeaders = [
    'bi_open', 'bi_recv', 'bi_exp', 'bi_close',
    'lpg_open', 'lpg_recv', 'lpg_exp', 'lpg_close',
    'nutri_open', 'nutri_recv', 'nutri_exp', 'nutri_close',
    'mme_open', 'mme_recv', 'mme_exp', 'mme_close',
    'kd_open', 'kd_recv', 'kd_exp', 'kd_close',
    'ks_open', 'ks_recv', 'ks_exp', 'ks_close',
    'ng_open', 'ng_recv', 'ng_exp', 'ng_close',
    'bc_open', 'bc_recv', 'bc_exp', 'bc_close'
  ];

  // Common school info, bank, health, inspection columns
  const schoolInfoHeaders = ['u_dise', 'school_name', 'category', 'circle_name', 'gp_name', 'month_name', 'year'];
  const bankHeaders = ['bank_passbook_balance', 'bank_balance_date', 'bank_match'];
  const healthAndInspHeaders = [
    'ifa_boys', 'ifa_girls', 'rbsk_screened', 'rbsk_referred',
    'inspection_done', 'insp_task_force', 'insp_district_officials', 'insp_block_officials', 'insp_smc_members',
    'untoward_incidents'
  ];

  // Primary Schools (194 schools): ONLY Primary fields (Bal Vatika PP & Primary I-V) - 74 columns
  const primaryHeaders = [
    ...schoolInfoHeaders,
    'bv_days', 'p_days', 'bv_actual', 'p_actual', 'bv_meals', 'p_meals',
    'cc_bv_open', 'cc_bv_recv', 'cc_bv_exp', 'cc_bv_close',
    'cc_p_open', 'cc_p_recv', 'cc_p_exp', 'cc_p_close',
    ...commonFundHeaders,
    ...bankHeaders,
    'rice_bv_open', 'rice_bv_recv', 'rice_bv_cons', 'rice_bv_close',
    'rice_p_open', 'rice_p_recv', 'rice_p_cons', 'rice_p_close',
    ...healthAndInspHeaders
  ];

  // Upper Primary Schools (52 schools): ONLY Upper Primary fields (VI-VIII) - 63 columns
  const upperHeaders = [
    ...schoolInfoHeaders,
    'up_days', 'up_actual', 'up_meals',
    'cc_up_open', 'cc_up_recv', 'cc_up_exp', 'cc_up_close',
    ...commonFundHeaders,
    ...bankHeaders,
    'rice_up_open', 'rice_up_recv', 'rice_up_cons', 'rice_up_close',
    ...healthAndInspHeaders
  ];

  // Master All Schools template - 85 columns
  const allHeaders = [
    ...schoolInfoHeaders,
    'bv_days', 'p_days', 'up_days', 'bv_actual', 'p_actual', 'up_actual', 'bv_meals', 'p_meals', 'up_meals',
    'cc_bv_open', 'cc_bv_recv', 'cc_bv_exp', 'cc_bv_close',
    'cc_p_open', 'cc_p_recv', 'cc_p_exp', 'cc_p_close',
    'cc_up_open', 'cc_up_recv', 'cc_up_exp', 'cc_up_close',
    ...commonFundHeaders,
    ...bankHeaders,
    'rice_bv_open', 'rice_bv_recv', 'rice_bv_cons', 'rice_bv_close',
    'rice_p_open', 'rice_p_recv', 'rice_p_cons', 'rice_p_close',
    'rice_up_open', 'rice_up_recv', 'rice_up_cons', 'rice_up_close',
    ...healthAndInspHeaders
  ];

  const headers = isPrimary ? primaryHeaders : (isUpper ? upperHeaders : allHeaders);

  let filename = '';
  if (isBlank) {
    if (isPrimary) filename = 'monthly_report_template_primary_blank.csv';
    else if (isUpper) filename = 'monthly_report_template_upper_blank.csv';
    else filename = 'monthly_report_template_blank.csv';
  } else {
    if (isPrimary) filename = 'monthly_report_template_primary_' + month.toLowerCase() + '_' + year + '.csv';
    else if (isUpper) filename = 'monthly_report_template_upper_' + month.toLowerCase() + '_' + year + '.csv';
    else filename = 'monthly_report_template_' + month.toLowerCase() + '_' + year + '.csv';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');

  let csvContent = '\uFEFF' + headers.join(',') + '\n';

  if (isBlank) {
    const today = new Date().toISOString().slice(0, 10);
    if (isUpper) {
      // 63 columns with strictly Upper Primary (VI-VIII) fields only
      csvContent += '19120512203,"AINCHGARH JR. HIGH SCHOOL (19120512203)","UPPER PRIMARY ONLY","BOINCHEE","BANTIKA BOINCHI",' +
        '"' + month + '","' + year + '",' +
        '15,15,30,' + // up_days, up_actual, up_meals
        '3000.00,3000.00,6000.00,0.00,' + // cc_up_open, cc_up_recv, cc_up_exp, cc_up_close
        '0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,' + // 16 zeroes
        '0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,' + // 16 zeroes (total 32 common funds)
        '0.00,' + today + ',YES,' + // bank details
        '1500.00,2500.00,2800.00,1200.00,' + // rice_up_open, rice_up_recv, rice_up_cons, rice_up_close
        '0,0,40,2,Yes,1,0,1,2,0\n'; // health & inspection
    } else {
      // 74 columns with strictly Primary fields only (Bal Vatika PP & Primary I-V)
      csvContent += '19120502701,"CHOWBERA PRIMARY SCHOOL (19120502701)","PRIMARY ONLY","BOINCHEE","BANTIKA BOINCHI",' +
        '"' + month + '","' + year + '",' +
        '10,10,10,10,25,20,' + // bv_days, p_days, bv_actual, p_actual, bv_meals, p_meals
        '2000.00,2000.00,5000.00,-1000.00,2000.00,2000.00,1000000.00,-9996000.00,' + // cc_bv_*, cc_p_*
        '0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,' + // 16 zeroes
        '0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,' + // 16 zeroes (total 32 common funds)
        '0.00,' + today + ',YES,' + // bank details
        '100.00,2000.00,500.00,1600.00,1222.00,2000.00,2200.00,1022.00,' + // rice_bv_*, rice_p_*
        '15,18,40,2,Yes,1,0,1,2,0\n'; // health & inspection
    }
    return res.send(csvContent);
  }

  try {
    const allSchools = await getSchools();
    let schools = allSchools;

    if (isPrimary) {
      schools = allSchools.filter(s => {
        const cat = (s.category || '').toUpperCase();
        return !cat.includes('UPPER') && !cat.includes('HIGH');
      });
    } else if (isUpper) {
      schools = allSchools.filter(s => {
        const cat = (s.category || '').toUpperCase();
        return cat.includes('UPPER') || cat.includes('HIGH');
      });
    }

    // Query existing saved monthly reports from update_monthly_report.html
    const { rows: savedReports } = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE LOWER(month_name) = LOWER($1) AND year = $2',
      [month, year]
    );

    const reportMap = new Map();
    for (const r of savedReports) {
      if (r.u_dise) {
        reportMap.set(String(r.u_dise).trim(), r);
      }
    }

    const fmtNum = (val, isDecimal = true) => {
      if (val === null || val === undefined || val === '') {
        return isDecimal ? '0.00' : '0';
      }
      const num = Number(val);
      if (isNaN(num)) return isDecimal ? '0.00' : '0';
      return isDecimal ? num.toFixed(2) : String(Math.round(num));
    };

    for (const s of schools) {
      const rep = reportMap.get(String(s.udise).trim()) || {};
      const commonFundVals = [
        fmtNum(rep.bi_open), fmtNum(rep.bi_recv), fmtNum(rep.bi_exp), fmtNum(rep.bi_close),
        fmtNum(rep.lpg_open), fmtNum(rep.lpg_recv), fmtNum(rep.lpg_exp), fmtNum(rep.lpg_close),
        fmtNum(rep.nutri_open), fmtNum(rep.nutri_recv), fmtNum(rep.nutri_exp), fmtNum(rep.nutri_close),
        fmtNum(rep.mme_open), fmtNum(rep.mme_recv), fmtNum(rep.mme_exp), fmtNum(rep.mme_close),
        fmtNum(rep.kd_open), fmtNum(rep.kd_recv), fmtNum(rep.kd_exp), fmtNum(rep.kd_close),
        fmtNum(rep.ks_open), fmtNum(rep.ks_recv), fmtNum(rep.ks_exp), fmtNum(rep.ks_close),
        fmtNum(rep.ng_open), fmtNum(rep.ng_recv), fmtNum(rep.ng_exp), fmtNum(rep.ng_close),
        fmtNum(rep.bc_open), fmtNum(rep.bc_recv), fmtNum(rep.bc_exp), fmtNum(rep.bc_close)
      ];

      const bankVals = [
        fmtNum(rep.bank_passbook_balance),
        rep.bank_balance_date || new Date().toISOString().slice(0, 10),
        rep.bank_match || 'YES'
      ];

      const healthAndInspVals = [
        fmtNum(rep.ifa_boys, false),
        fmtNum(rep.ifa_girls, false),
        fmtNum(rep.rbsk_screened, false),
        fmtNum(rep.rbsk_referred, false),
        rep.inspection_done || 'No',
        fmtNum(rep.insp_task_force, false),
        fmtNum(rep.insp_district_officials, false),
        fmtNum(rep.insp_block_officials, false),
        fmtNum(rep.insp_smc_members, false),
        fmtNum(rep.untoward_incidents, false)
      ];

      let row = [];
      if (isPrimary) {
        // Strictly Primary fields (Bal Vatika PP & Primary I-V) - 74 columns
        row = [
          s.udise,
          '"' + (s.school_name || '').replace(/"/g, '""') + '"',
          '"' + (s.category || '').replace(/"/g, '""') + '"',
          '"' + (s.circle_name || '').replace(/"/g, '""') + '"',
          '"' + (s.gp_name || '').replace(/"/g, '""') + '"',
          '"' + month + '"',
          '"' + year + '"',
          fmtNum(rep.bv_days, false),
          fmtNum(rep.p_days, false),
          fmtNum(rep.bv_actual, false),
          fmtNum(rep.p_actual, false),
          fmtNum(rep.bv_meals, false),
          fmtNum(rep.p_meals, false),
          fmtNum(rep.cc_bv_open), fmtNum(rep.cc_bv_recv), fmtNum(rep.cc_bv_exp), fmtNum(rep.cc_bv_close),
          fmtNum(rep.cc_p_open), fmtNum(rep.cc_p_recv), fmtNum(rep.cc_p_exp), fmtNum(rep.cc_p_close),
          ...commonFundVals,
          ...bankVals,
          fmtNum(rep.rice_bv_open), fmtNum(rep.rice_bv_recv), fmtNum(rep.rice_bv_cons), fmtNum(rep.rice_bv_close),
          fmtNum(rep.rice_p_open), fmtNum(rep.rice_p_recv), fmtNum(rep.rice_p_cons), fmtNum(rep.rice_p_close),
          ...healthAndInspVals
        ];
      } else if (isUpper) {
        // Strictly Upper Primary fields (VI-VIII) - 63 columns
        row = [
          s.udise,
          '"' + (s.school_name || '').replace(/"/g, '""') + '"',
          '"' + (s.category || '').replace(/"/g, '""') + '"',
          '"' + (s.circle_name || '').replace(/"/g, '""') + '"',
          '"' + (s.gp_name || '').replace(/"/g, '""') + '"',
          '"' + month + '"',
          '"' + year + '"',
          fmtNum(rep.up_days, false),
          fmtNum(rep.up_actual, false),
          fmtNum(rep.up_meals, false),
          fmtNum(rep.cc_up_open), fmtNum(rep.cc_up_recv), fmtNum(rep.cc_up_exp), fmtNum(rep.cc_up_close),
          ...commonFundVals,
          ...bankVals,
          fmtNum(rep.rice_up_open), fmtNum(rep.rice_up_recv), fmtNum(rep.rice_up_cons), fmtNum(rep.rice_up_close),
          ...healthAndInspVals
        ];
      } else {
        // Master all 85 columns
        row = [
          s.udise,
          '"' + (s.school_name || '').replace(/"/g, '""') + '"',
          '"' + (s.category || '').replace(/"/g, '""') + '"',
          '"' + (s.circle_name || '').replace(/"/g, '""') + '"',
          '"' + (s.gp_name || '').replace(/"/g, '""') + '"',
          '"' + month + '"',
          '"' + year + '"',
          fmtNum(rep.bv_days, false),
          fmtNum(rep.p_days, false),
          fmtNum(rep.up_days, false),
          fmtNum(rep.bv_actual, false),
          fmtNum(rep.p_actual, false),
          fmtNum(rep.up_actual, false),
          fmtNum(rep.bv_meals, false),
          fmtNum(rep.p_meals, false),
          fmtNum(rep.up_meals, false),
          fmtNum(rep.cc_bv_open), fmtNum(rep.cc_bv_recv), fmtNum(rep.cc_bv_exp), fmtNum(rep.cc_bv_close),
          fmtNum(rep.cc_p_open), fmtNum(rep.cc_p_recv), fmtNum(rep.cc_p_exp), fmtNum(rep.cc_p_close),
          fmtNum(rep.cc_up_open), fmtNum(rep.cc_up_recv), fmtNum(rep.cc_up_exp), fmtNum(rep.cc_up_close),
          ...commonFundVals,
          ...bankVals,
          fmtNum(rep.rice_bv_open), fmtNum(rep.rice_bv_recv), fmtNum(rep.rice_bv_cons), fmtNum(rep.rice_bv_close),
          fmtNum(rep.rice_p_open), fmtNum(rep.rice_p_recv), fmtNum(rep.rice_p_cons), fmtNum(rep.rice_p_close),
          fmtNum(rep.rice_up_open), fmtNum(rep.rice_up_recv), fmtNum(rep.rice_up_cons), fmtNum(rep.rice_up_close),
          ...healthAndInspVals
        ];
      }
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

    const fOpenTotal = toFloat(d.cc_bv_open) + toFloat(d.cc_p_open) + toFloat(d.cc_up_open) + toFloat(d.bi_open) + toFloat(d.lpg_open) + toFloat(d.nutri_open) + toFloat(d.mme_open) + toFloat(d.kd_open) + toFloat(d.ks_open) + toFloat(d.ng_open) + toFloat(d.bc_open) + toFloat(d.oth_open);
    const fRecvTotal = toFloat(d.cc_bv_recv) + toFloat(d.cc_p_recv) + toFloat(d.cc_up_recv) + toFloat(d.bi_recv) + toFloat(d.lpg_recv) + toFloat(d.nutri_recv) + toFloat(d.mme_recv) + toFloat(d.kd_recv) + toFloat(d.ks_recv) + toFloat(d.ng_recv) + toFloat(d.bc_recv) + toFloat(d.oth_recv);
    const fExpTotal = toFloat(d.cc_bv_exp) + toFloat(d.cc_p_exp) + toFloat(d.cc_up_exp) + toFloat(d.bi_exp) + toFloat(d.lpg_exp) + toFloat(d.nutri_exp) + toFloat(d.mme_exp) + toFloat(d.kd_exp) + toFloat(d.ks_exp) + toFloat(d.ng_exp) + toFloat(d.bc_exp) + toFloat(d.oth_exp);
    const fCloseTotal = toFloat(d.cc_bv_close) + toFloat(d.cc_p_close) + toFloat(d.cc_up_close) + toFloat(d.bi_close) + toFloat(d.lpg_close) + toFloat(d.nutri_close) + toFloat(d.mme_close) + toFloat(d.kd_close) + toFloat(d.ks_close) + toFloat(d.ng_close) + toFloat(d.bc_close) + toFloat(d.oth_close);

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
            <tr><td style="text-align:left;">OTHERS</td><td>${fmt(d.oth_open)}</td><td>${fmt(d.oth_recv)}</td><td>${fmt(d.oth_exp)}</td><td>${fmt(d.oth_close)}</td></tr>
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
      } catch (upsertErr) { console.error('upsertErr in upload-full-csv:', upsertErr.message);
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

// Full MDCF monthly CSV upload endpoint (supports separate Primary and Upper Primary files or single file)
const uploadMonthlyFullMulter = upload.fields([
  { name: 'csv_file', maxCount: 1 },
  { name: 'file_primary', maxCount: 1 },
  { name: 'primary_csv', maxCount: 1 },
  { name: 'file_upper', maxCount: 1 },
  { name: 'upper_csv', maxCount: 1 }
]);

async function processMonthlyCsvRows(rows, type, defaultMonth, defaultYear, schoolMap) {
  if (!rows || rows.length < 2) return 0;
  const header = rows[0];
  const colIndex = {};
  header.forEach((col, idx) => {
    const cleanKey = String(col).toLowerCase().replace(/[^a-zA-Z0-9_]/g, '_').trim();
    colIndex[cleanKey] = idx;
  });

  const isMdcfTemplate = (
    colIndex['bi_open'] !== undefined ||
    colIndex['month_name'] !== undefined ||
    header.length >= 50
  );

  const isPrimary = (type === 'primary');
  let processed = 0;
  const dataRows = rows.slice(1);

  const getUdiseFromRow = (r) => {
    if (colIndex['u_dise'] !== undefined && r[colIndex['u_dise']]) {
      const u = extractUdise(r[colIndex['u_dise']]);
      if (u) return u;
    }
    if (colIndex['udise'] !== undefined && r[colIndex['udise']]) {
      const u = extractUdise(r[colIndex['udise']]);
      if (u) return u;
    }
    if (colIndex['udise_code'] !== undefined && r[colIndex['udise_code']]) {
      const u = extractUdise(r[colIndex['udise_code']]);
      if (u) return u;
    }
    return extractUdise(r[1]) || extractUdise(r[0]);
  };

  for (const r of dataRows) {
    if (!r || r.length < 2) continue;
    const udise = getUdiseFromRow(r);
    if (!udise) continue;

    const master = schoolMap[udise] || {};
    let schoolName = master.school_name || '';
    let circleName = master.circle_name || 'N/A';
    let gpName = master.gp_name || 'N/A';
    let rowMonth = defaultMonth;
    let rowYear = defaultYear;

    let bvDays = 0, pDays = 0, upDays = 0;
    let bvAct = 0, pAct = 0, upAct = 0;
    let bvMeals = 0, pMeals = 0, upMeals = 0;
    let ccBvOpen = 0, ccBvRecv = 0, ccBvExp = 0, ccBvClose = 0;
    let ccPOpen = 0, ccPRecv = 0, ccPExp = 0, ccPClose = 0;
    let ccUpOpen = 0, ccUpRecv = 0, ccUpExp = 0, ccUpClose = 0;
    let cchOpen = 0, cchRecv = 0, cchExp = 0, cchClose = 0;
    let mmeOpen = 0, mmeRecv = 0, mmeExp = 0, mmeClose = 0;
    let biOpen = 0, biRecv = 0, biExp = 0, biClose = 0;
    let lpgOpen = 0, lpgRecv = 0, lpgExp = 0, lpgClose = 0;
    let nutriOpen = 0, nutriRecv = 0, nutriExp = 0, nutriClose = 0;
    let kdOpen = 0, kdRecv = 0, kdExp = 0, kdClose = 0;
    let ksOpen = 0, ksRecv = 0, ksExp = 0, ksClose = 0;
    let ngOpen = 0, ngRecv = 0, ngExp = 0, ngClose = 0;
    let bcOpen = 0, bcRecv = 0, bcExp = 0, bcClose = 0;
    let bankMatch = 'YES', bankPassbookBal = 0, bankBalDate = new Date().toISOString().slice(0, 10);
    let rBvOpen = 0, rBvRecv = 0, rBvCons = 0, rBvClose = 0;
    let rPOpen = 0, rPRecv = 0, rPCons = 0, rPClose = 0;
    let rUpOpen = 0, rUpRecv = 0, rUpCons = 0, rUpClose = 0;
    let ifaBoys = 0, ifaGirls = 0, rbskScreened = 0, rbskReferred = 0;
    let inspDone = 'No', inspTf = 0, inspDist = 0, inspBlock = 0, inspSmc = 0, untoward = 0;

    const getVal = (key, fallbackIdx) => {
      if (colIndex[key] !== undefined && r[colIndex[key]] !== undefined) {
        return r[colIndex[key]];
      }
      return fallbackIdx !== undefined && r[fallbackIdx] !== undefined ? r[fallbackIdx] : '';
    };

    if (isMdcfTemplate) {
      if (!schoolName) schoolName = getVal('school_name', 1) || `School (${udise})`;
      if (circleName === 'N/A') circleName = getVal('circle_name', 3) || 'N/A';
      if (gpName === 'N/A') gpName = getVal('gp_name', 4) || 'N/A';
      if (colIndex['month_name'] !== undefined && r[colIndex['month_name']]) {
        rowMonth = String(r[colIndex['month_name']]).trim() || defaultMonth;
      }
      if (colIndex['year'] !== undefined && r[colIndex['year']]) {
        rowYear = String(r[colIndex['year']]).trim() || defaultYear;
      }

      bvDays = toInt(getVal('bv_days')); pDays = toInt(getVal('p_days')); upDays = toInt(getVal('up_days'));
      bvAct = toInt(getVal('bv_actual')); pAct = toInt(getVal('p_actual')); upAct = toInt(getVal('up_actual'));
      bvMeals = toInt(getVal('bv_meals')); pMeals = toInt(getVal('p_meals')); upMeals = toInt(getVal('up_meals'));

      ccBvOpen = toFloat(getVal('cc_bv_open')); ccBvRecv = toFloat(getVal('cc_bv_recv')); ccBvExp = toFloat(getVal('cc_bv_exp')); ccBvClose = toFloat(getVal('cc_bv_close'));
      ccPOpen = toFloat(getVal('cc_p_open')); ccPRecv = toFloat(getVal('cc_p_recv')); ccPExp = toFloat(getVal('cc_p_exp')); ccPClose = toFloat(getVal('cc_p_close'));
      ccUpOpen = toFloat(getVal('cc_up_open')); ccUpRecv = toFloat(getVal('cc_up_recv')); ccUpExp = toFloat(getVal('cc_up_exp')); ccUpClose = toFloat(getVal('cc_up_close'));
      cchOpen = toFloat(getVal('cch_open')); cchRecv = toFloat(getVal('cch_recv')); cchExp = toFloat(getVal('cch_exp')); cchClose = toFloat(getVal('cch_close'));
      mmeOpen = toFloat(getVal('mme_open')); mmeRecv = toFloat(getVal('mme_recv')); mmeExp = toFloat(getVal('mme_exp')); mmeClose = toFloat(getVal('mme_close'));
      biOpen = toFloat(getVal('bi_open')); biRecv = toFloat(getVal('bi_recv')); biExp = toFloat(getVal('bi_exp')); biClose = toFloat(getVal('bi_close'));
      lpgOpen = toFloat(getVal('lpg_open')); lpgRecv = toFloat(getVal('lpg_recv')); lpgExp = toFloat(getVal('lpg_exp')); lpgClose = toFloat(getVal('lpg_close'));
      nutriOpen = toFloat(getVal('nutri_open')); nutriRecv = toFloat(getVal('nutri_recv')); nutriExp = toFloat(getVal('nutri_exp')); nutriClose = toFloat(getVal('nutri_close'));
      kdOpen = toFloat(getVal('kd_open')); kdRecv = toFloat(getVal('kd_recv')); kdExp = toFloat(getVal('kd_exp')); kdClose = toFloat(getVal('kd_close'));
      ksOpen = toFloat(getVal('ks_open')); ksRecv = toFloat(getVal('ks_recv')); ksExp = toFloat(getVal('ks_exp')); ksClose = toFloat(getVal('ks_close'));
      ngOpen = toFloat(getVal('ng_open')); ngRecv = toFloat(getVal('ng_recv')); ngExp = toFloat(getVal('ng_exp')); ngClose = toFloat(getVal('ng_close'));
      bcOpen = toFloat(getVal('bc_open')); bcRecv = toFloat(getVal('bc_recv')); bcExp = toFloat(getVal('bc_exp')); bcClose = toFloat(getVal('bc_close'));
      bankMatch = getVal('bank_match') || 'YES';
      bankPassbookBal = toFloat(getVal('bank_passbook_balance'));
      bankBalDate = getVal('bank_balance_date') || new Date().toISOString().slice(0, 10);
      rBvOpen = toFloat(getVal('rice_bv_open')); rBvRecv = toFloat(getVal('rice_bv_recv')); rBvCons = toFloat(getVal('rice_bv_cons')); rBvClose = toFloat(getVal('rice_bv_close'));
      rPOpen = toFloat(getVal('rice_p_open')); rPRecv = toFloat(getVal('rice_p_recv')); rPCons = toFloat(getVal('rice_p_cons')); rPClose = toFloat(getVal('rice_p_close'));
      rUpOpen = toFloat(getVal('rice_up_open')); rUpRecv = toFloat(getVal('rice_up_recv')); rUpCons = toFloat(getVal('rice_up_cons')); rUpClose = toFloat(getVal('rice_up_close'));
      ifaBoys = toInt(getVal('ifa_boys')); ifaGirls = toInt(getVal('ifa_girls'));
      rbskScreened = toInt(getVal('rbsk_screened')); rbskReferred = toInt(getVal('rbsk_referred'));
      inspDone = getVal('inspection_done') || 'No';
      inspTf = toInt(getVal('insp_task_force')); inspDist = toInt(getVal('insp_district_officials'));
      inspBlock = toInt(getVal('insp_block_officials')); inspSmc = toInt(getVal('insp_smc_members'));
      untoward = toInt(getVal('untoward_incidents'));
    } else {
      // 35-column portal format
      if (!schoolName) schoolName = r[2] || `School (${udise})`;
      if (circleName === 'N/A') circleName = r[3] || 'N/A';
      if (gpName === 'N/A') gpName = r[4] || 'N/A';

      if (isPrimary) {
        bvDays = toInt(r[5]); pDays = toInt(r[6]);
        bvAct = toInt(r[7]); pAct = toInt(r[8]);
        bvMeals = toInt(r[9]); pMeals = toInt(r[10]);
        ccBvOpen = toFloat(r[11]); ccBvRecv = toFloat(r[12]); ccBvExp = toFloat(r[13]); ccBvClose = toFloat(r[14]);
        ccPOpen = toFloat(r[15]); ccPRecv = toFloat(r[16]); ccPExp = toFloat(r[17]); ccPClose = toFloat(r[18]);
        cchOpen = toFloat(r[19]); cchRecv = toFloat(r[20]); cchExp = toFloat(r[21]); cchClose = toFloat(r[22]);
        mmeOpen = toFloat(r[23]); mmeRecv = toFloat(r[24]); mmeExp = toFloat(r[25]); mmeClose = toFloat(r[26]);
        rBvOpen = toFloat(r[27]); rBvRecv = toFloat(r[28]); rBvCons = toFloat(r[29]); rBvClose = toFloat(r[30]);
        rPOpen = toFloat(r[31]); rPRecv = toFloat(r[32]); rPCons = toFloat(r[33]); rPClose = toFloat(r[34]);
      } else {
        pDays = toInt(r[5]); upDays = toInt(r[6]);
        pAct = toInt(r[7]); upAct = toInt(r[8]);
        pMeals = toInt(r[9]); upMeals = toInt(r[10]);
        ccPOpen = toFloat(r[11]); ccPRecv = toFloat(r[12]); ccPExp = toFloat(r[13]); ccPClose = toFloat(r[14]);
        ccUpOpen = toFloat(r[15]); ccUpRecv = toFloat(r[16]); ccUpExp = toFloat(r[17]); ccUpClose = toFloat(r[18]);
        cchOpen = toFloat(r[19]); cchRecv = toFloat(r[20]); cchExp = toFloat(r[21]); cchClose = toFloat(r[22]);
        mmeOpen = toFloat(r[23]); mmeRecv = toFloat(r[24]); mmeExp = toFloat(r[25]); mmeClose = toFloat(r[26]);
        rPOpen = toFloat(r[27]); rPRecv = toFloat(r[28]); rPCons = toFloat(r[29]); rPClose = toFloat(r[30]);
        rUpOpen = toFloat(r[31]); rUpRecv = toFloat(r[32]); rUpCons = toFloat(r[33]); rUpClose = toFloat(r[34]);
      }
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
        rice_up_open, rice_up_recv, rice_up_cons, rice_up_close,
        ifa_boys, ifa_girls, rbsk_screened, rbsk_referred,
        inspection_done, insp_task_force, insp_district_officials, insp_block_officials, insp_smc_members,
        untoward_incidents
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
        $28, $29, $30, $31, $32, $33, $34, $35,
        $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47,
        $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59,
        $60, $61, $62,
        $63, $64, $65, $66,
        $67, $68, $69, $70, $71, $72, $73, $74, $75, $76, $77, $78,
        $79, $80, $81, $82,
        $83, $84, $85, $86, $87,
        $88
      )
      ON CONFLICT (u_dise, month_name, year) DO UPDATE SET
        ${type === 'primary' ? `
        school_name = EXCLUDED.school_name, circle_name = EXCLUDED.circle_name, gp_name = EXCLUDED.gp_name,
        bv_days = EXCLUDED.bv_days, p_days = EXCLUDED.p_days,
        bv_actual = EXCLUDED.bv_actual, p_actual = EXCLUDED.p_actual,
        bv_meals = EXCLUDED.bv_meals, p_meals = EXCLUDED.p_meals,
        cc_bv_open = EXCLUDED.cc_bv_open, cc_bv_recv = EXCLUDED.cc_bv_recv, cc_bv_exp = EXCLUDED.cc_bv_exp, cc_bv_close = EXCLUDED.cc_bv_close,
        cc_p_open = EXCLUDED.cc_p_open, cc_p_recv = EXCLUDED.cc_p_recv, cc_p_exp = EXCLUDED.cc_p_exp, cc_p_close = EXCLUDED.cc_p_close,
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
        ifa_boys = EXCLUDED.ifa_boys, ifa_girls = EXCLUDED.ifa_girls,
        rbsk_screened = EXCLUDED.rbsk_screened, rbsk_referred = EXCLUDED.rbsk_referred,
        inspection_done = EXCLUDED.inspection_done, insp_task_force = EXCLUDED.insp_task_force,
        insp_district_officials = EXCLUDED.insp_district_officials, insp_block_officials = EXCLUDED.insp_block_officials,
        insp_smc_members = EXCLUDED.insp_smc_members, untoward_incidents = EXCLUDED.untoward_incidents
        ` : (type === 'upper' ? `
        school_name = EXCLUDED.school_name, circle_name = EXCLUDED.circle_name, gp_name = EXCLUDED.gp_name,
        up_days = EXCLUDED.up_days, up_actual = EXCLUDED.up_actual, up_meals = EXCLUDED.up_meals,
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
        rice_up_open = EXCLUDED.rice_up_open, rice_up_recv = EXCLUDED.rice_up_recv, rice_up_cons = EXCLUDED.rice_up_cons, rice_up_close = EXCLUDED.rice_up_close,
        ifa_boys = EXCLUDED.ifa_boys, ifa_girls = EXCLUDED.ifa_girls,
        rbsk_screened = EXCLUDED.rbsk_screened, rbsk_referred = EXCLUDED.rbsk_referred,
        inspection_done = EXCLUDED.inspection_done, insp_task_force = EXCLUDED.insp_task_force,
        insp_district_officials = EXCLUDED.insp_district_officials, insp_block_officials = EXCLUDED.insp_block_officials,
        insp_smc_members = EXCLUDED.insp_smc_members, untoward_incidents = EXCLUDED.untoward_incidents
        ` : `
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
        rice_up_open = EXCLUDED.rice_up_open, rice_up_recv = EXCLUDED.rice_up_recv, rice_up_cons = EXCLUDED.rice_up_cons, rice_up_close = EXCLUDED.rice_up_close,
        ifa_boys = EXCLUDED.ifa_boys, ifa_girls = EXCLUDED.ifa_girls,
        rbsk_screened = EXCLUDED.rbsk_screened, rbsk_referred = EXCLUDED.rbsk_referred,
        inspection_done = EXCLUDED.inspection_done, insp_task_force = EXCLUDED.insp_task_force,
        insp_district_officials = EXCLUDED.insp_district_officials, insp_block_officials = EXCLUDED.insp_block_officials,
        insp_smc_members = EXCLUDED.insp_smc_members, untoward_incidents = EXCLUDED.untoward_incidents
        `)};
    `;

    const vals = [
      rowMonth, rowYear, udise, schoolName, circleName, gpName,
      bvDays, pDays, upDays,
      bvAct, pAct, upAct,
      bvMeals, pMeals, upMeals,
      ccBvOpen, ccBvRecv, ccBvExp, ccBvClose,
      ccPOpen, ccPRecv, ccPExp, ccPClose,
      ccUpOpen, ccUpRecv, ccUpExp, ccUpClose,
      cchOpen, cchRecv, cchExp, cchClose,
      mmeOpen, mmeRecv, mmeExp, mmeClose,
      biOpen, biRecv, biExp, biClose,
      lpgOpen, lpgRecv, lpgExp, lpgClose,
      nutriOpen, nutriRecv, nutriExp, nutriClose,
      kdOpen, kdRecv, kdExp, kdClose,
      ksOpen, ksRecv, ksExp, ksClose,
      ngOpen, ngRecv, ngExp, ngClose,
      bcOpen, bcRecv, bcExp, bcClose,
      bankMatch, bankPassbookBal, bankBalDate,
      rBvOpen, rBvRecv, rBvCons, rBvClose,
      rPOpen, rPRecv, rPCons, rPClose,
      rUpOpen, rUpRecv, rUpCons, rUpClose,
      ifaBoys, ifaGirls, rbskScreened, rbskReferred,
      inspDone, inspTf, inspDist, inspBlock, inspSmc,
      untoward
    ];

    try {
      await pool.query(q, vals);
    } catch (upsertErr) {
      console.error("upsertErr in processMonthlyCsvRows:", upsertErr.message);
      await pool.query(
        'UPDATE public.mdm_monthly_report SET school_name = $1, p_days = $2, p_actual = $3, p_meals = $4, rice_p_close = $5 WHERE u_dise = $6 AND month_name = $7 AND year = $8',
        [schoolName, pDays, pAct, pMeals, rPClose, udise, rowMonth, rowYear]
      );
    }
    processed++;
  }
  return processed;
}

router.post(['/upload_monthly_report.php', '/api/monthly-report/upload-full-csv', '/monthly-report/upload-full-csv'], requireAuth('main'), uploadMonthlyFullMulter, async (req, res) => {
  const primaryFile = req.files?.file_primary?.[0] || req.files?.primary_csv?.[0];
  const upperFile = req.files?.file_upper?.[0] || req.files?.upper_csv?.[0];
  const singleFile = req.files?.csv_file?.[0] || req.file;

  const month = (req.body?.month || new Date().toLocaleString('en-US', { month: 'long' })).trim();
  const year = (req.body?.year || String(new Date().getFullYear())).trim();
  const isAjax = req.headers.accept?.includes('application/json') || req.body?.ajax === '1';

  const sendResp = (status, msg, inserted = 0, updated = 0, extra = {}) => {
    if (isAjax) {
      return res.json({ status, message: msg, inserted, updated, ...extra });
    }
    const param = status === 'success' ? 'msg' : 'err';
    return res.redirect(`/upload_monthly_report?${param}=${encodeURIComponent(msg)}&month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`);
  };

  if (!primaryFile && !upperFile && !singleFile) {
    return sendResp('error', 'Please select at least one CSV file to upload.');
  }

  try {
    const schoolMap = await getSchoolsMap();
    let primaryProcessed = 0;
    let upperProcessed = 0;
    let singleProcessed = 0;

    if (primaryFile && primaryFile.buffer) {
      const text = primaryFile.buffer.toString('utf8');
      const rows = parseCSV(text);
      if (rows.length >= 2) {
        primaryProcessed = await processMonthlyCsvRows(rows, 'primary', month, year, schoolMap);
      }
    }

    if (upperFile && upperFile.buffer) {
      const text = upperFile.buffer.toString('utf8');
      const rows = parseCSV(text);
      if (rows.length >= 2) {
        upperProcessed = await processMonthlyCsvRows(rows, 'upper', month, year, schoolMap);
      }
    }

    if (singleFile && singleFile.buffer && !primaryFile && !upperFile) {
      const text = singleFile.buffer.toString('utf8');
      const rows = parseCSV(text);
      if (rows.length >= 2) {
        const fileType = req.body?.upload_type || req.body?.type || 'all';
        singleProcessed = await processMonthlyCsvRows(rows, fileType, month, year, schoolMap);
      }
    }

    const totalProcessed = primaryProcessed + upperProcessed + singleProcessed;
    if (totalProcessed === 0) {
      return sendResp('error', 'CSV file(s) are empty or contained no valid school records.');
    }

    let successMsg = '';
    if (primaryProcessed > 0 && upperProcessed > 0) {
      successMsg = `Successfully processed ${primaryProcessed} Primary and ${upperProcessed} Upper Primary school records.`;
    } else if (primaryProcessed > 0) {
      successMsg = `Successfully processed ${primaryProcessed} Primary school records.`;
    } else if (upperProcessed > 0) {
      successMsg = `Successfully processed ${upperProcessed} Upper Primary school records.`;
    } else {
      successMsg = `Successfully processed ${singleProcessed} school records.`;
    }

    return sendResp('success', successMsg, totalProcessed, 0, {
      total: totalProcessed,
      primaryCount: primaryProcessed,
      upperCount: upperProcessed
    });
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

// ==========================================
// 12. Google Drive OAuth Token Management Routes (AES-256-GCM in Supabase)
// ==========================================

function getOAuthRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/api/google/callback`;
}

/**
 * GET /admin/google-drive/status
 * Returns sanitized connection metadata for admin dashboard. Never returns raw/encrypted tokens.
 */
router.get('/admin/google-drive/status', requireAuth('main'), async (req, res) => {
  try {
    const status = await getSafeGoogleDriveStatus();
    return res.json({ status: 'success', data: status });
  } catch (err) {
    console.error('Error fetching Google Drive token status:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /admin/google-drive/verify
 * Tests Google Drive folder connectivity and token validity server-side.
 */
router.post('/admin/google-drive/verify', requireAuth('main'), async (req, res) => {
  try {
    const result = await verifyGoogleDriveConnection();
    return res.json({
      status: result.success ? 'success' : 'error',
      data: result
    });
  } catch (err) {
    console.error('Error verifying Google Drive connection:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /google/connect
 * Redirects admin to Google OAuth consent screen to authorize / reconnect.
 */
router.get('/google/connect', requireAuth('main'), (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Server error: GOOGLE_CLIENT_ID is not configured in .env');
  }

  const redirectUri = getOAuthRedirectUri(req);
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email');
  // Include both consent and select_account to strictly force Google to issue a brand-new refresh token
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent%20select_account`;

  return res.redirect(authUrl);
});

/**
 * GET /google/callback
 * Handles OAuth callback from Google, exchanges code for refresh token,
 * securely encrypts and stores in Supabase, and updates status.
 */
router.get('/google/callback', async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;

  if (error) {
    console.error('Google OAuth callback error:', error);
    return res.status(400).send(`Google OAuth Authorization failed: ${error}`);
  }

  if (!code) {
    return res.status(400).send('Missing authorization code in Google callback.');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('Server error: Google OAuth client credentials not configured.');
  }

  const redirectUri = getOAuthRedirectUri(req);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || (!tokenData.refresh_token && !tokenData.access_token)) {
      const errMsg = tokenData.error_description || tokenData.error || 'Failed to exchange authorization code';
      console.error('Google token exchange failed:', errMsg);
      return res.status(400).send(`Failed to exchange code: ${errMsg}`);
    }

    // Attempt to discover account email using the access token
    let accountEmail = 'dasarnima94@gmail.com';
    if (tokenData.access_token) {
      try {
        const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        if (userInfoRes.ok) {
          const userInfo = await userInfoRes.json();
          if (userInfo.email) {
            accountEmail = userInfo.email;
          }
        }
      } catch (uErr) {
        console.warn('Could not fetch user profile info:', uErr.message);
      }
    }

    if (tokenData.refresh_token) {
      // New refresh token provided: Encrypt and persist to Supabase
      await saveGoogleDriveToken({
        refreshToken: tokenData.refresh_token,
        accountEmail: accountEmail,
        isTestingMode: true,
        issuedAt: new Date()
      });

      // Verify connection immediately so status, folder access and timestamps are fresh
      await verifyGoogleDriveConnection();
    } else {
      // Re-authorization where Google did not return a replacement refresh token:
      // Verify if existing token is valid. If not, inform admin to revoke app permission first.
      const existing = await getGoogleDriveTokenRecord();
      let isValidExisting = false;
      if (existing) {
        const verifyRes = await verifyGoogleDriveConnection();
        isValidExisting = Boolean(verifyRes && verifyRes.success);
      }

      if (!isValidExisting) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Reconnection Action Needed</title>
            <style>
              body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
              .card { background: #1e293b; border: 1px solid #334155; padding: 2.5rem; border-radius: 16px; max-width: 520px; line-height: 1.6; }
              h2 { color: #f59e0b; margin-top: 0; }
              a.btn { display: inline-block; background: #0d9488; color: #fff; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 15px; }
              code { background: #334155; padding: 2px 6px; border-radius: 4px; color: #38bdf8; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>⚠️ Google Did Not Return a Refresh Token</h2>
              <p>Google reused your previous login session and did not generate a new 7-day refresh token.</p>
              <p><strong>To fix this in 10 seconds:</strong></p>
              <ol>
                <li>Open <a href="https://myaccount.google.com/connections" target="_blank" style="color: #38bdf8;">Google Account Connections</a>.</li>
                <li>Find your app and click <strong>Delete all connections / Remove access</strong>.</li>
                <li>Return to the Admin Dashboard and click <strong>Reconnect Google Drive</strong>. Google will then issue a brand new 7-day refresh token.</li>
              </ol>
              <a href="/admin_dashboard" class="btn">Return to Admin Dashboard</a>
            </div>
          </body>
          </html>
        `);
      }
    }

    // Success response with auto-redirect to Admin Dashboard
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Google Drive Connected</title>
        <meta http-equiv="refresh" content="3;url=/admin_dashboard">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0f172a;
            color: #f8fafc;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .card {
            background: #1e293b;
            border: 1px solid #334155;
            padding: 2.5rem;
            border-radius: 16px;
            text-align: center;
            max-width: 440px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4);
          }
          .icon {
            font-size: 3rem;
            color: #10b981;
            margin-bottom: 1rem;
          }
          h2 { margin: 0 0 0.5rem; color: #f8fafc; font-size: 1.5rem; }
          p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem; }
          .btn {
            display: inline-block;
            background: #2563eb;
            color: #ffffff;
            text-decoration: none;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            font-weight: 600;
            transition: background 0.2s;
          }
          .btn:hover { background: #1d4ed8; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h2>Google Drive Connected</h2>
          <p>The refresh token for <strong>${accountEmail}</strong> was safely encrypted with AES-256-GCM and stored in Supabase.</p>
          <a href="/admin_dashboard" class="btn">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Error handling Google OAuth callback:', err);
    return res.status(500).send(`Server error saving Google Drive authorization: ${err.message}`);
  }
});

module.exports = router;
