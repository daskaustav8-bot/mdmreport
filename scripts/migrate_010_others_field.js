const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PG_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false, servername: process.env.SUPABASE_DB_HOST }
};

async function runMigration() {
  console.log('Connecting to Supabase PostgreSQL at', PG_CONFIG.host);
  const client = new Client(PG_CONFIG);
  await client.connect();
  console.log('Connected! Running migration 010_add_others_fund_field.sql...');
  
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/010_add_others_fund_field.sql'), 'utf-8');
  await client.query(sql);
  console.log('Migration executed successfully!');

  const { rows } = await client.query("SELECT key, category, field_name, label, is_locked FROM public.monthly_report_field_config WHERE key LIKE '%oth%' ORDER BY category, key ASC");
  console.log('Provisioned oth field records:');
  console.table(rows);

  await client.end();
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
