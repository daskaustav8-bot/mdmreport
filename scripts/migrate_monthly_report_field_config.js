const fs = require('fs');
const path = require('path');
const { pool } = require('../db/supabase');

async function runMigration() {
  console.log('Running migration 007_monthly_report_field_config.sql...');
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/007_monthly_report_field_config.sql'), 'utf-8');
  await pool.query(sql);
  console.log('Migration executed successfully!');

  const { rows } = await pool.query('SELECT key, category, field_name, label, is_locked FROM public.monthly_report_field_config ORDER BY category, key ASC');
  console.log('Provisioned field records:');
  console.table(rows);
  await pool.end();
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
