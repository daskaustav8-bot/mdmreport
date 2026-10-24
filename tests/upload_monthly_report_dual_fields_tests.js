/**
 * Integration Test: upload_monthly_report.html Dual Primary & Upper Upload Fields
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, getSchoolsMap } = require('../db/supabase');
const { createSessionToken } = require('../middleware/auth');
const app = require('../server');

const TEST_PORT = 3559;
let serverInstance;
let testsPassed = 0;
let testsFailed = 0;

function logResult(title, passed, detail = '') {
  if (passed) {
    testsPassed++;
    console.log(`✅ PASS: ${title}${detail ? ' - ' + detail : ''}`);
  } else {
    testsFailed++;
    console.error(`❌ FAIL: ${title}${detail ? ' - ' + detail : ''}`);
  }
}

function makeMultipartRequest(urlPath, boundary, bodyBuffer, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length,
        'Accept': 'application/json'
      }
    };

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

function makeGetRequest(urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: urlPath,
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'Accept': 'text/csv, */*'
      }
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseCSV(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentCell += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += char;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function buildMultipartBody(boundary, fields, files) {
  const chunks = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${val}\r\n`
    ));
  }

  for (const f of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${f.fieldName}"; filename="${f.fileName}"\r\n` +
      `Content-Type: text/csv\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function runTests() {
  console.log('================================================================');
  console.log('  TESTING: UPLOAD_MONTHLY_REPORT DUAL PRIMARY & UPPER FIELDS');
  console.log('================================================================\n');

  // 1. Verify Markup in upload_monthly_report.html
  const htmlPath = path.join(__dirname, '..', 'upload_monthly_report.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  const hasPrimaryField = html.includes('id="primaryCsvInput"') && html.includes('name="file_primary"');
  const hasUpperField = html.includes('id="upperCsvInput"') && html.includes('name="file_upper"');
  const hasPrimaryDropzone = html.includes('id="dropzonePrimary"');
  const hasUpperDropzone = html.includes('id="dropzoneUpper"');
  const hasTabs = !html.includes('id="tabBoth"') && html.includes('id="tabPrimary"') && html.includes('id="tabUpper"');
  const bothButtonRemoved = !html.includes('Both Fields');
  const hasIndividualButtons = html.includes('id="btnUploadPrimary"') && html.includes('id="btnUploadUpper"');
  const hasUnifiedButton = html.includes('id="uploadBtn"');

  logResult(
    'upload_monthly_report.html contains different upload fields for Primary and Upper Primary',
    hasPrimaryField && hasUpperField && hasPrimaryDropzone && hasUpperDropzone && hasTabs && hasIndividualButtons && bothButtonRemoved
  );

  const hasPrimaryTemplate = html.includes('id="btnDownloadPrimary"') && html.includes("downloadTemplate('primary')") && html.includes('194 Schools');
  const hasUpperTemplate = html.includes('id="btnDownloadUpper"') && html.includes("downloadTemplate('upper')") && html.includes('52 Schools');
  const hasMasterRemoved = !html.includes('id="btnDownloadPrefilled"') && !html.includes('Download Master Template (All 246 Schools)');
  const hasBlankPrimary = html.includes('id="btnDownloadBlankPrimary"') && html.includes("downloadBlank('primary')");
  const hasBlankUpper = html.includes('id="btnDownloadBlankUpper"') && html.includes("downloadBlank('upper')");

  logResult(
    'upload_monthly_report.html contains separated template and blank sample download cards for Primary and Upper Primary',
    hasPrimaryTemplate && hasUpperTemplate && hasMasterRemoved && hasBlankPrimary && hasBlankUpper
  );

  // 2. Start server
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, resolve);
  });

  const mainAdminToken = createSessionToken({
    id: 3,
    username: 'admin',
    admin_type: 'main'
  });
  const mainCookie = `admin_session=${mainAdminToken}`;

  const testMonth = 'DualTestMonth';
  const testYear = '2098';
  const priUdise = '19120500703'; // ABADPARA PRIMARY SCHOOL
  const uppUdise = '19120512203'; // AINCHGARH JR. HIGH SCHOOL

  // Clean test records
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [testMonth, testYear]);

  // Test 2: Upload Primary CSV via file_primary
  try {
    const priCsv =
      'SL,UDISE,School,Circle,GP,bv_days,p_days,bv_act,p_act,bv_meals,p_meals,cc_bv_open,cc_bv_recv,cc_bv_exp,cc_bv_close,cc_p_open,cc_p_recv,cc_p_exp,cc_p_close,cch_open,cch_recv,cch_exp,cch_close,mme_open,mme_recv,mme_exp,mme_close,r_bv_open,r_bv_recv,r_bv_cons,r_bv_close,r_p_open,r_p_recv,r_p_cons,r_p_close\n' +
      `1,${priUdise},"ABADPARA PRIMARY SCHOOL","CHOWBERA","GP1",21,23,19,48,320,1050,110,510,410,210,260,1020,910,370,55,210,160,105,12,52,42,22,11.0,51.0,41.0,21.0,26.0,105.0,95.0,36.0\n`;

    const boundary = '----WebKitFormBoundaryPriTest' + Date.now();
    const body = buildMultipartBody(boundary, {
      action: 'upload_csv',
      month: testMonth,
      year: testYear
    }, [{
      fieldName: 'file_primary',
      fileName: 'primary_test.csv',
      content: priCsv
    }]);

    const res = await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundary, body, mainCookie);
    const data = JSON.parse(res.body);

    const check = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [priUdise, testMonth, testYear]
    );

    const ok = res.status === 200 && data.status === 'success' && check.rows.length === 1 && check.rows[0].p_days === 23;
    logResult('Uploading Primary CSV via file_primary field succeeds and saves to database', ok, `Message: ${data.message}`);
  } catch (err) {
    logResult('Uploading Primary CSV via file_primary field', false, err.message);
  }

  // Test 3: Upload Upper Primary CSV via file_upper
  try {
    const uppCsv =
      'SL,UDISE,School,Circle,GP,p_days,up_days,p_act,up_act,p_meals,up_meals,cc_p_open,cc_p_recv,cc_p_exp,cc_p_close,cc_up_open,cc_up_recv,cc_up_exp,cc_up_close,cch_open,cch_recv,cch_exp,cch_close,mme_open,mme_recv,mme_exp,mme_close,r_p_open,r_p_recv,r_p_cons,r_p_close,r_up_open,r_up_recv,r_up_cons,r_up_close\n' +
      `1,${uppUdise},"AINCHGARH JR. HIGH SCHOOL","CIRCLE2","GP2",19,25,42,70,820,1550,160,820,710,270,210,1250,1020,440,42,185,145,82,14,48,38,24,32.0,92.0,82.0,42.0,52.0,155.0,135.0,72.0\n`;

    const boundary = '----WebKitFormBoundaryUppTest' + Date.now();
    const body = buildMultipartBody(boundary, {
      action: 'upload_csv',
      month: testMonth,
      year: testYear
    }, [{
      fieldName: 'file_upper',
      fileName: 'upper_test.csv',
      content: uppCsv
    }]);

    const res = await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundary, body, mainCookie);
    const data = JSON.parse(res.body);

    const check = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [uppUdise, testMonth, testYear]
    );

    const ok = res.status === 200 && data.status === 'success' && check.rows.length === 1 && check.rows[0].up_days === 25;
    logResult('Uploading Upper Primary CSV via file_upper field succeeds and saves to database', ok, `Message: ${data.message}`);
  } catch (err) {
    logResult('Uploading Upper Primary CSV via file_upper field', false, err.message);
  }

  // Test 4: Upload BOTH Primary and Upper Primary files together in one request
  try {
    const priRow =
      `1,${priUdise},"ABADPARA PRIMARY SCHOOL","CHOWBERA","GP1",22,24,20,50,330,1100,120,520,420,220,270,1030,920,380,56,215,165,106,13,53,43,23,12.0,52.0,42.0,22.0,27.0,106.0,96.0,37.0\n`;
    const priCsv =
      'SL,UDISE,School,Circle,GP,bv_days,p_days,bv_act,p_act,bv_meals,p_meals,cc_bv_open,cc_bv_recv,cc_bv_exp,cc_bv_close,cc_p_open,cc_p_recv,cc_p_exp,cc_p_close,cch_open,cch_recv,cch_exp,cch_close,mme_open,mme_recv,mme_exp,mme_close,r_bv_open,r_bv_recv,r_bv_cons,r_bv_close,r_p_open,r_p_recv,r_p_cons,r_p_close\n' + priRow;

    const uppRow =
      `1,${uppUdise},"AINCHGARH JR. HIGH SCHOOL","CIRCLE2","GP2",20,26,44,72,840,1600,170,830,720,280,220,1260,1030,450,43,186,146,83,15,49,39,25,33.0,93.0,83.0,43.0,53.0,156.0,136.0,73.0\n`;
    const uppCsv =
      'SL,UDISE,School,Circle,GP,p_days,up_days,p_act,up_act,p_meals,up_meals,cc_p_open,cc_p_recv,cc_p_exp,cc_p_close,cc_up_open,cc_up_recv,cc_up_exp,cc_up_close,cch_open,cch_recv,cch_exp,cch_close,mme_open,mme_recv,mme_exp,mme_close,r_p_open,r_p_recv,r_p_cons,r_p_close,r_up_open,r_up_recv,r_up_cons,r_up_close\n' + uppRow;

    const boundary = '----WebKitFormBoundaryBothTest' + Date.now();
    const body = buildMultipartBody(boundary, {
      action: 'upload_csv',
      month: testMonth,
      year: testYear
    }, [
      { fieldName: 'file_primary', fileName: 'primary_both.csv', content: priCsv },
      { fieldName: 'file_upper', fileName: 'upper_both.csv', content: uppCsv }
    ]);

    const res = await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundary, body, mainCookie);
    const data = JSON.parse(res.body);

    const priCheck = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [priUdise, testMonth, testYear]
    );
    const uppCheck = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [uppUdise, testMonth, testYear]
    );

    const ok = res.status === 200 &&
               data.status === 'success' &&
               data.primaryCount === 1 &&
               data.upperCount === 1 &&
               priCheck.rows[0].p_days === 24 &&
               uppCheck.rows[0].up_days === 26;

    logResult('Simultaneous upload of both Primary and Upper files processes both accurately', ok, `Message: ${data.message}`);
  } catch (err) {
    logResult('Simultaneous upload of both Primary and Upper files', false, err.message);
  }

  // Test 5: Download Primary School Template (194 schools, 74 columns)
  try {
    const res = await makeGetRequest('/api/monthly-report/template?category=primary&month=January&year=2026', mainCookie);
    const disposition = res.headers['content-disposition'] || '';
    const rows = parseCSV(res.body);
    const headerCols = rows[0] || [];
    const rowCount = rows.length - 1; // subtract header
    const ok = res.status === 200 &&
               disposition.includes('monthly_report_template_primary_january_2026.csv') &&
               rowCount === 194 &&
               headerCols.length === 74 &&
               headerCols.includes('Bal Vatika School Days') &&
               headerCols.includes('Material Cost Primary Opening Balance') &&
               headerCols.includes('Bank Interest Opening Balance') &&
               !headerCols.includes('Upper Primary School Days') &&
               !headerCols.includes('Material Cost Upper Primary Opening Balance');
    logResult('GET /api/monthly-report/template?category=primary returns exactly 194 Primary school rows with 74 Primary-only columns with full names', ok, `Rows: ${rowCount}, Cols: ${headerCols.length}`);
  } catch (err) {
    logResult('GET /api/monthly-report/template?category=primary', false, err.message);
  }

  // Test 6: Download Upper Primary School Template (52 schools, 63 columns)
  try {
    const res = await makeGetRequest('/api/monthly-report/template?category=upper&month=January&year=2026', mainCookie);
    const disposition = res.headers['content-disposition'] || '';
    const rows = parseCSV(res.body);
    const headerCols = rows[0] || [];
    const rowCount = rows.length - 1; // subtract header
    const ok = res.status === 200 &&
               disposition.includes('monthly_report_template_upper_january_2026.csv') &&
               rowCount === 52 &&
               headerCols.length === 63 &&
               headerCols.includes('Upper Primary School Days') &&
               headerCols.includes('Material Cost Upper Primary Opening Balance') &&
               headerCols.includes('Bank Interest Opening Balance') &&
               !headerCols.includes('Bal Vatika School Days') &&
               !headerCols.includes('Material Cost Bal Vatika Opening Balance') &&
               !headerCols.includes('Primary School Days');
    logResult('GET /api/monthly-report/template?category=upper returns exactly 52 Upper Primary school rows with 63 Upper-only columns with full names', ok, `Rows: ${rowCount}, Cols: ${headerCols.length}`);
  } catch (err) {
    logResult('GET /api/monthly-report/template?category=upper', false, err.message);
  }

  // Test 7: Download Master Template (All 246 schools)
  try {
    const res = await makeGetRequest('/api/monthly-report/template?type=all&month=January&year=2026', mainCookie);
    const disposition = res.headers['content-disposition'] || '';
    const rows = parseCSV(res.body);
    const headerCols = rows[0] || [];
    const rowCount = rows.length - 1; // subtract header
    const ok = res.status === 200 &&
               disposition.includes('monthly_report_template_january_2026.csv') &&
               rowCount === 246 &&
               headerCols.length === 85;
    logResult('GET /api/monthly-report/template?type=all returns all 246 school rows', ok, `Rows: ${rowCount}, Filename header: ${disposition}`);
  } catch (err) {
    logResult('GET /api/monthly-report/template?type=all', false, err.message);
  }

  // Test 8: Download Blank Primary Sample CSV (74 columns)
  try {
    const res = await makeGetRequest('/api/monthly-report/template?type=blank&category=primary', mainCookie);
    const disposition = res.headers['content-disposition'] || '';
    const rows = parseCSV(res.body);
    const headerCols = rows[0] || [];
    const ok = res.status === 200 &&
               disposition.includes('monthly_report_template_primary_blank.csv') &&
               res.body.includes('ABADPARA PRIMARY SCHOOL') &&
               headerCols.length === 74 &&
               headerCols.includes('Bank Interest Opening Balance') &&
               !headerCols.includes('Upper Primary School Days') &&
               !headerCols.includes('Material Cost Upper Primary Opening Balance');
    logResult('GET /api/monthly-report/template?type=blank&category=primary returns Primary sample CSV (74 Primary columns with full names)', ok, `Cols: ${headerCols.length}`);
  } catch (err) {
    logResult('GET /api/monthly-report/template?type=blank&category=primary', false, err.message);
  }

  // Test 9: Download Blank Upper Primary Sample CSV (63 columns)
  try {
    const res = await makeGetRequest('/api/monthly-report/template?type=blank&category=upper', mainCookie);
    const disposition = res.headers['content-disposition'] || '';
    const rows = parseCSV(res.body);
    const headerCols = rows[0] || [];
    const ok = res.status === 200 &&
               disposition.includes('monthly_report_template_upper_blank.csv') &&
               res.body.includes('AINCHGARH JR. HIGH SCHOOL') &&
               headerCols.length === 63 &&
               headerCols.includes('Bank Interest Opening Balance') &&
               !headerCols.includes('Bal Vatika School Days') &&
               !headerCols.includes('Primary School Days') &&
               !headerCols.includes('Material Cost Bal Vatika Opening Balance');
    logResult('GET /api/monthly-report/template?type=blank&category=upper returns Upper Primary sample CSV (63 Upper columns with full names)', ok, `Cols: ${headerCols.length}`);
  } catch (err) {
    logResult('GET /api/monthly-report/template?type=blank&category=upper', false, err.message);
  }

  // Test 10: Upload Isolation: Primary upload preserves Upper fields; Upper upload preserves Primary fields
  try {
    const isoMonth = 'IsoMonthTest';
    const isoYear = '2099';
    const isoUdise = '19120512203';
    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [isoMonth, isoYear]);

    // 1. Initial insert with both primary and upper values
    await pool.query(`
      INSERT INTO public.mdm_monthly_report (
        month_name, year, u_dise, school_name, p_days, up_days, cc_p_close, cc_up_close
      ) VALUES ($1, $2, $3, $4, 20, 25, 200.00, 300.00)
    `, [isoMonth, isoYear, isoUdise, 'ISOLATION TEST SCHOOL']);

    // 2. Upload Primary CSV with updated p_days = 28
    const priIsoCsv =
      'u_dise,school_name,category,circle_name,gp_name,month_name,year,bv_days,p_days,bv_actual,p_actual,bv_meals,p_meals,cc_bv_open,cc_bv_recv,cc_bv_exp,cc_bv_close,cc_p_open,cc_p_recv,cc_p_exp,cc_p_close,bi_open,bi_recv,bi_exp,bi_close,lpg_open,lpg_recv,lpg_exp,lpg_close,nutri_open,nutri_recv,nutri_exp,nutri_close,mme_open,mme_recv,mme_exp,mme_close,kd_open,kd_recv,kd_exp,kd_close,ks_open,ks_recv,ks_exp,ks_close,ng_open,ng_recv,ng_exp,ng_close,bc_open,bc_recv,bc_exp,bc_close,bank_passbook_balance,bank_balance_date,bank_match,rice_bv_open,rice_bv_recv,rice_bv_cons,rice_bv_close,rice_p_open,rice_p_recv,rice_p_cons,rice_p_close,ifa_boys,ifa_girls,rbsk_screened,rbsk_referred,inspection_done,insp_task_force,insp_district_officials,insp_block_officials,insp_smc_members,untoward_incidents\n' +
      `${isoUdise},"ISOLATION TEST SCHOOL","UPPER PRIMARY ONLY","CIRCLE","GP","${isoMonth}","${isoYear}",0,28,0,28,0,50,0,0,0,0,200,200,200,200,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-01-01,YES,0,0,0,0,100,100,100,100,0,0,0,0,No,0,0,0,0,0\n`;

    const boundaryPri = '----WebKitFormBoundaryIsoPri' + Date.now();
    const bodyPri = buildMultipartBody(boundaryPri, { action: 'upload_csv', month: isoMonth, year: isoYear }, [
      { fieldName: 'file_primary', fileName: 'primary_iso.csv', content: priIsoCsv }
    ]);
    await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundaryPri, bodyPri, mainCookie);

    const check1 = await pool.query('SELECT p_days, up_days FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3', [isoUdise, isoMonth, isoYear]);
    const priIsolated = check1.rows[0].p_days === 28 && check1.rows[0].up_days === 25; // up_days preserved!

    // 3. Upload Upper CSV with updated up_days = 33
    const uppIsoCsv =
      'u_dise,school_name,category,circle_name,gp_name,month_name,year,up_days,up_actual,up_meals,cc_up_open,cc_up_recv,cc_up_exp,cc_up_close,bi_open,bi_recv,bi_exp,bi_close,lpg_open,lpg_recv,lpg_exp,lpg_close,nutri_open,nutri_recv,nutri_exp,nutri_close,mme_open,mme_recv,mme_exp,mme_close,kd_open,kd_recv,kd_exp,kd_close,ks_open,ks_recv,ks_exp,ks_close,ng_open,ng_recv,ng_exp,ng_close,bc_open,bc_recv,bc_exp,bc_close,bank_passbook_balance,bank_balance_date,bank_match,rice_up_open,rice_up_recv,rice_up_cons,rice_up_close,ifa_boys,ifa_girls,rbsk_screened,rbsk_referred,inspection_done,insp_task_force,insp_district_officials,insp_block_officials,insp_smc_members,untoward_incidents\n' +
      `${isoUdise},"ISOLATION TEST SCHOOL","UPPER PRIMARY ONLY","CIRCLE","GP","${isoMonth}","${isoYear}",33,33,60,300,300,300,300,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-01-01,YES,200,200,200,200,0,0,0,0,No,0,0,0,0,0\n`;

    const boundaryUpp = '----WebKitFormBoundaryIsoUpp' + Date.now();
    const bodyUpp = buildMultipartBody(boundaryUpp, { action: 'upload_csv', month: isoMonth, year: isoYear }, [
      { fieldName: 'file_upper', fileName: 'upper_iso.csv', content: uppIsoCsv }
    ]);
    await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundaryUpp, bodyUpp, mainCookie);

    const check2 = await pool.query('SELECT p_days, up_days FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3', [isoUdise, isoMonth, isoYear]);
    const uppIsolated = check2.rows[0].up_days === 33 && check2.rows[0].p_days === 28; // p_days preserved!

    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [isoMonth, isoYear]);
    logResult('Primary upload updates only Primary fields; Upper upload updates only Upper fields without cross-contamination', priIsolated && uppIsolated);
  } catch (err) {
    logResult('Upload Isolation test', false, err.message);
  }

  // Test 12: Uploading CSV with Full Descriptive Header Names (e.g., Bank Interest Opening Balance)
  try {
    const fullTestMonth = 'FullHeadersTest';
    const fullTestYear = '2097';
    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [fullTestMonth, fullTestYear]);

    const fullHeadersCsv =
      'UDISE Code,School Name,Category,Circle Name,GP Name,Month Name,Year,Bal Vatika School Days,Primary School Days,Bal Vatika MDM Served Days,Primary MDM Served Days,Bal Vatika Meals Served,Primary Meals Served,Material Cost Bal Vatika Opening Balance,Material Cost Bal Vatika Received,Material Cost Bal Vatika Expenditure,Material Cost Bal Vatika Closing Balance,Material Cost Primary Opening Balance,Material Cost Primary Received,Material Cost Primary Expenditure,Material Cost Primary Closing Balance,Bank Interest Opening Balance,Bank Interest Received,Bank Interest Expenditure,Bank Interest Closing Balance,LPG Subsidy Opening Balance,LPG Subsidy Received,LPG Subsidy Expenditure,LPG Subsidy Closing Balance,Supplementary Nutrition Opening Balance,Supplementary Nutrition Received,Supplementary Nutrition Expenditure,Supplementary Nutrition Closing Balance,School Expenses MME Opening Balance,School Expenses MME Received,School Expenses MME Expenditure,School Expenses MME Closing Balance,Kitchen Devices Opening Balance,Kitchen Devices Received,Kitchen Devices Expenditure,Kitchen Devices Closing Balance,Kitchen Shed Repair Opening Balance,Kitchen Shed Repair Received,Kitchen Shed Repair Expenditure,Kitchen Shed Repair Closing Balance,Nutrition Garden Opening Balance,Nutrition Garden Received,Nutrition Garden Expenditure,Nutrition Garden Closing Balance,Bank Charges Opening Balance,Bank Charges Received,Bank Charges Expenditure,Bank Charges Closing Balance,Bank Passbook Balance,Bank Balance Date,Bank Match Status,Rice Bal Vatika Opening Balance,Rice Bal Vatika Received,Rice Bal Vatika Consumption,Rice Bal Vatika Closing Balance,Rice Primary Opening Balance,Rice Primary Received,Rice Primary Consumption,Rice Primary Closing Balance,IFA Tablets Received Boys,IFA Tablets Received Girls,RBSK Mobile Health Team Screened,RBSK Mobile Health Team Referred,School Inspection Done,Inspection by Members of Task Force,Inspection by District Officials,Inspection by Block Officials,Inspection by SMC Members,Untoward Incidents Occurred\n' +
      `${priUdise},"ABADPARA PRIMARY SCHOOL","PRIMARY ONLY","BOINCHEE","BERALA KONCHMALI","${fullTestMonth}","${fullTestYear}",21,25,19,48,320,1050,110.00,510.00,410.00,210.00,260.00,1020.00,910.00,370.00,45.00,120.00,65.00,100.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,15.00,50.00,40.00,25.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,12500.50,2026-01-15,YES,11.00,51.00,41.00,21.00,26.00,105.00,95.00,36.00,22,28,45,3,Yes,1,0,1,2,0\n`;

    const boundaryFull = '----WebKitFormBoundaryFull' + Date.now();
    const bodyFull = buildMultipartBody(boundaryFull, { action: 'upload_csv', month: fullTestMonth, year: fullTestYear }, [
      { fieldName: 'file_primary', fileName: 'full_headers_primary.csv', content: fullHeadersCsv }
    ]);

    const res = await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundaryFull, bodyFull, mainCookie);
    const data = JSON.parse(res.body);

    const check = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [priUdise, fullTestMonth, fullTestYear]
    );

    const ok = res.status === 200 &&
               data.status === 'success' &&
               check.rows.length === 1 &&
               check.rows[0].p_days === 25 &&
               Number(check.rows[0].bi_open) === 45.00 &&
               Number(check.rows[0].bi_close) === 100.00 &&
               Number(check.rows[0].bank_passbook_balance) === 12500.50;

    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [fullTestMonth, fullTestYear]);
    logResult('Uploading CSV with Full Descriptive Header Names maps all fields to DB correctly', ok, `bi_open: ${check.rows[0]?.bi_open}, bi_close: ${check.rows[0]?.bi_close}, p_days: ${check.rows[0]?.p_days}`);
  } catch (err) {
    logResult('Uploading CSV with Full Descriptive Header Names', false, err.message);
  }

  // Test 13: Uploading CSV with Full Descriptive Top Header Names (Wrap Text compatible)
  try {
    const wrapTestMonth = 'WrapHeadersTest';
    const wrapTestYear = '2096';
    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [wrapTestMonth, wrapTestYear]);

    // Download primary template to test actual round-trip format
    const tmplRes = await makeGetRequest('/api/monthly-report/template?category=primary&month=' + wrapTestMonth + '&year=' + wrapTestYear, mainCookie);
    const tmplRows = parseCSV(tmplRes.body);
    // Take header + first row
    const headerLine = tmplRows[0].map(c => '"' + c.replace(/"/g, '""') + '"').join(',');
    // Provide test data for row 1
    const rowCells = [...tmplRows[1]];
    // UDISE is at index 0, set days and bank interest
    const udiseIdx = tmplRows[0].indexOf('UDISE Code');
    const pDaysIdx = tmplRows[0].indexOf('Primary School Days');
    const biOpenIdx = tmplRows[0].indexOf('Bank Interest Opening Balance');
    const biCloseIdx = tmplRows[0].indexOf('Bank Interest Closing Balance');
    if (pDaysIdx !== -1) rowCells[pDaysIdx] = '27';
    if (biOpenIdx !== -1) rowCells[biOpenIdx] = '88.50';
    if (biCloseIdx !== -1) rowCells[biCloseIdx] = '188.50';
    const testUdise = rowCells[udiseIdx];

    const testCsv = headerLine + '\r\n' + rowCells.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',') + '\r\n';

    const boundaryWrap = '----WebKitFormBoundaryWrap' + Date.now();
    const bodyWrap = buildMultipartBody(boundaryWrap, { action: 'upload_csv', month: wrapTestMonth, year: wrapTestYear }, [
      { fieldName: 'file_primary', fileName: 'wrapped_headers_primary.csv', content: testCsv }
    ]);

    const res = await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundaryWrap, bodyWrap, mainCookie);
    const data = JSON.parse(res.body);

    const check = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [testUdise, wrapTestMonth, wrapTestYear]
    );

    const ok = res.status === 200 &&
               data.status === 'success' &&
               check.rows.length === 1 &&
               check.rows[0].p_days === 27 &&
               Number(check.rows[0].bi_open) === 88.50 &&
               Number(check.rows[0].bi_close) === 188.50;

    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [wrapTestMonth, wrapTestYear]);
    logResult('Uploading CSV with Full Descriptive Top Header Names maps all fields to DB correctly', ok, `bi_open: ${check.rows[0]?.bi_open}, bi_close: ${check.rows[0]?.bi_close}, p_days: ${check.rows[0]?.p_days}`);
  } catch (err) {
    logResult('Uploading CSV with Full Descriptive Top Header Names', false, err.message);
  }

  // Test 14: Download Excel Template (format=excel) with Wrap Text & Column Widths
  try {
    const res = await makeGetRequest('/api/monthly-report/template?category=primary&month=January&year=2026&format=excel', mainCookie);
    const disposition = res.headers['content-disposition'] || '';
    const contentType = res.headers['content-type'] || '';
    const body = res.body;

    const ok = res.status === 200 &&
               disposition.includes('monthly_report_template_primary_january_2026.xls') &&
               contentType.includes('application/vnd.ms-excel') &&
               body.includes('white-space: normal') &&
               body.includes('mso-wrap-style: square') &&
               body.includes('height: 42px') &&
               body.includes('min-width: 110px') &&
               body.includes('<th>Bank Interest Opening Balance</th>');
    logResult('GET /api/monthly-report/template?format=excel returns .xls with automatic Wrap Text, row height, and column widths', ok);
  } catch (err) {
    logResult('GET /api/monthly-report/template?format=excel', false, err.message);
  }

  // Test 15: Uploading Excel (.xls HTML table) File via upload-full-csv
  try {
    const xlsMonth = 'XlsUploadTest';
    const xlsYear = '2095';
    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [xlsMonth, xlsYear]);

    const sampleXls = `
      <html><body><table>
        <tr>
          <th>UDISE Code</th><th>School Name</th><th>Category</th><th>Circle Name</th><th>GP Name</th><th>Month Name</th><th>Year</th>
          <th>Primary School Days</th><th>Bank Interest Opening Balance</th><th>Bank Interest Closing Balance</th>
        </tr>
        <tr>
          <td>${priUdise}</td><td>ABADPARA PRIMARY SCHOOL (${priUdise})</td><td>PRIMARY ONLY</td><td>BOINCHEE</td><td>GP</td><td>${xlsMonth}</td><td>${xlsYear}</td>
          <td>29</td><td>99.50</td><td>199.50</td>
        </tr>
      </table></body></html>
    `;

    const boundaryXls = '----WebKitFormBoundaryXls' + Date.now();
    const bodyXls = buildMultipartBody(boundaryXls, { action: 'upload_csv', month: xlsMonth, year: xlsYear }, [
      { fieldName: 'file_primary', fileName: 'excel_template.xls', content: sampleXls }
    ]);

    const res = await makeMultipartRequest('/api/monthly-report/upload-full-csv', boundaryXls, bodyXls, mainCookie);
    const data = JSON.parse(res.body);

    const check = await pool.query(
      'SELECT * FROM public.mdm_monthly_report WHERE u_dise = $1 AND month_name = $2 AND year = $3',
      [priUdise, xlsMonth, xlsYear]
    );

    const ok = res.status === 200 &&
               data.status === 'success' &&
               check.rows.length === 1 &&
               check.rows[0].p_days === 29 &&
               Number(check.rows[0].bi_open) === 99.50 &&
               Number(check.rows[0].bi_close) === 199.50;

    await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [xlsMonth, xlsYear]);
    logResult('Uploading Excel (.xls) file format via upload-full-csv successfully parses and saves to DB', ok);
  } catch (err) {
    logResult('Uploading Excel (.xls) file format', false, err.message);
  }

  // Test 16: Verification that downloaded Primary CSV matches monthly_report_template_blank (2).csv exactly
  try {
    const blankPath = path.join(__dirname, '..', 'monthly_report_template_blank (2).csv');
    const blankContent = fs.readFileSync(blankPath, 'utf8');
    const blankCols = blankContent.split(/\r?\n/)[0].replace(/^\uFEFF/, '').split(',').map(c => c.trim()).filter(c => c.length > 0);

    const res = await makeGetRequest('/api/monthly-report/template?category=primary&month=January&year=2026', mainCookie);
    const downloadedCols = parseCSV(res.body)[0] || [];

    let allMatch = downloadedCols.length === blankCols.length;
    for (let i = 0; i < blankCols.length; i++) {
      if (downloadedCols[i] !== blankCols[i]) {
        allMatch = false;
        break;
      }
    }

    logResult(
      'Downloaded Primary CSV headers match monthly_report_template_blank (2).csv 100% across all 74 columns in exact order',
      allMatch && downloadedCols.length === 74,
      `Blank columns: ${blankCols.length}, Downloaded columns: ${downloadedCols.length}`
    );
  } catch (err) {
    logResult('Verification against monthly_report_template_blank (2).csv', false, err.message);
  }

  // Cleanup
  await pool.query('DELETE FROM public.mdm_monthly_report WHERE month_name = $1 AND year = $2', [testMonth, testYear]);
  if (serverInstance) serverInstance.close();

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${testsPassed}/${testsPassed + testsFailed} PASSED`);
  console.log('================================================================');

  if (testsFailed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
