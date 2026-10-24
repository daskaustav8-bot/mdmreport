const fs = require('fs');

const content = fs.readFileSync('update_monthly_report.html', 'utf8');

// 1. Check button presence
if (!content.includes('id="btnDownloadPdf"')) {
    console.error('FAIL: btnDownloadPdf not found');
    process.exit(1);
}
console.log('✅ PASS: btnDownloadPdf found in update_monthly_report.html');

// 2. Check jsPDF inclusion
if (!content.includes('jspdf.umd.min.js')) {
    console.error('FAIL: jspdf.umd.min.js not referenced');
    process.exit(1);
}
console.log('✅ PASS: jsPDF script tag referenced');

// 3. Check signature layout
if (!content.includes('signature-col-left') || !content.includes('signature-col-right')) {
    console.error('FAIL: signature columns not found');
    process.exit(1);
}
console.log('✅ PASS: signature row columns (left signature, right download button) verified');

// 4. Check that generateMonthlyReportPdf and extractMonthlyReportData exist
if (!content.includes('function generateMonthlyReportPdf') || !content.includes('function extractMonthlyReportData')) {
    console.error('FAIL: PDF generation functions not found');
    process.exit(1);
}
console.log('✅ PASS: generateMonthlyReportPdf and extractMonthlyReportData functions verified');

// 5. Test executing the PDF generation logic with sample data
const path = require('path');
const { jsPDF } = require(path.join(__dirname, '../jspdf.umd.min.js'));

// Verify that the PDF generator runs cleanly and generates a valid 2-page document
const scriptRegex = /function generateMonthlyReportPdf\(data\) {([\s\S]*?)return doc;\s*}/;
const match = content.match(scriptRegex);
if (!match) {
    console.error('FAIL: Could not extract generateMonthlyReportPdf body');
    process.exit(1);
}

// Create function in test sandbox
const genFn = new Function('data', 'jsPDF', `
    const window = { jspdf: { jsPDF } };
    ${match[0]}
    return generateMonthlyReportPdf(data);
`);

const testDoc = genFn({
    month: 'November',
    year: '2026',
    schoolName: 'KALYANPUR PRIMARY SCHOOL',
    udise: '19180100101',
    profileText: 'KALYANPUR PRIMARY SCHOOL (19180100101)',
    category: 'Primary with Upper Primary',
    circle: 'Bagnan-I',
    gp: 'Kalyanpur',
    hasBv: false,
    hasUp: false,
    bv_days: 0, p_days: 22, up_days: 0,
    bv_actual: 0, p_actual: 22, up_actual: 0,
    bv_meals: 0, p_meals: 1100, up_meals: 0,
    cc_p_open: 5000, cc_p_recv: 3000, cc_p_exp: 2500, cc_p_close: 5500,
    total_open: 5000, total_recv: 3000, total_exp: 2500, total_close: 5500,
    bank_balance_date: '2026-11-20',
    bank_passbook_balance: 5500,
    bank_match: 'YES',
    rice_p_open: 100, rice_p_recv: 50, rice_p_cons: 40, rice_p_close: 110,
    ifa_boys: 20, ifa_girls: 25, rbsk_screened: 45, rbsk_referred: 0,
    inspection_done: 'YES',
    insp_task_force: 1, insp_district_officials: 0, insp_block_officials: 1, insp_smc_members: 2,
    untoward_incidents: 0
}, jsPDF);

const totalPages = testDoc.getNumberOfPages();
if (totalPages !== 2) {
    console.error(`FAIL: Expected 2 pages, got ${totalPages}`);
    process.exit(1);
}
console.log(`✅ PASS: Generated PDF has exactly ${totalPages} pages matching reference style!`);

const pdfBytes = testDoc.output('arraybuffer');
console.log(`✅ PASS: PDF generated successfully with size ${pdfBytes.byteLength} bytes.`);
