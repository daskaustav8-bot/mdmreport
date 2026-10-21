const fs = require('fs');
const path = require('path');

const targetDir = 'C:\\xampp\\htdocs\\mdmreport';
if (fs.existsSync(targetDir)) {
  const filesToSync = [
    'admin_login.html',
    'infra_login.html',
    'admin_login_handler.php',
    'infra_login_handler.php',
    'admin_session_check.php',
    'infra_session_check.php',
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
