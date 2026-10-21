require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.SUPABASE_DB_HOST,
  port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false }
});

const sql = `
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'mdm_monthly_report' 
          AND column_name = 'passbook_photo_file_id'
    ) THEN
        ALTER TABLE public.mdm_monthly_report 
        ADD COLUMN passbook_photo_file_id TEXT DEFAULT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'mdm_monthly_report' 
          AND column_name = 'passbook_photo_url'
    ) THEN
        ALTER TABLE public.mdm_monthly_report 
        ADD COLUMN passbook_photo_url TEXT DEFAULT NULL;
    END IF;
END $$;
`;

async function runMigration() {
  try {
    console.log('Connecting to Supabase PostgreSQL...');
    await pool.query(sql);
    console.log('Migration executed successfully! Columns passbook_photo_file_id and passbook_photo_url are verified.');
    const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'mdm_monthly_report' AND column_name LIKE '%passbook%'");
    console.table(res.rows);
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

runMigration();
