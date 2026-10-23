const fs = require('fs');
const path = require('path');

const targetDir = 'C:\\xampp\\htdocs\\mdmreport';
if (fs.existsSync(targetDir)) {
  const filesToSync = [
    'admin_login.html',
    'infra_login.html',
    'admin_dashboard.html',
    'basicinfrastructure.html',
    'closingbalance.html',
    'index.html',
    'monthlyreport.html',
    'monthly_view.html',
    'ricerequirement.html',
    'rice_report_detail.html',
    'rice_report_panel.html',
    'rice_report_view.html',
    'status_table.html',
    'student_update.html',
    'update_monthly_report.html',
    'upload_csv.html',
    'admin_upload.html',
    'upload_infrastructure.html',
    'upload_monthly_report.html',
    'manage_infrastructure_fields.html',
    'manage_infrastructure_fields.js',
    'supabase-client.js',
    'style.css',
    '.htaccess'
  ];
  
  filesToSync.forEach(f => {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(targetDir, f));
      console.log('Synced to XAMPP:', f);
    }
  });
} else {
  console.log('XAMPP directory does not exist, skipping sync.');
}
