const { Client } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const PG_CONFIG = {
  host: process.env.SUPABASE_DB_HOST,
  port: parseInt(process.env.SUPABASE_DB_PORT || '5432', 10),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false }
};

async function migrateAndProvision() {
  console.log('Connecting to Supabase PostgreSQL...');
  const client = new Client(PG_CONFIG);
  await client.connect();
  console.log('Connected to Supabase PostgreSQL at ' + PG_CONFIG.host);

  try {
    await client.query('BEGIN');

    // 1. Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.admin_users (
        id serial PRIMARY KEY,
        username varchar(50) NOT NULL,
        password varchar(255) NOT NULL
      );
    `);

    // 2. Add admin_type column if not exists
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema = 'public' 
            AND table_name = 'admin_users' 
            AND column_name = 'admin_type'
        ) THEN
          ALTER TABLE public.admin_users ADD COLUMN admin_type varchar(50) NOT NULL DEFAULT 'main';
        END IF;
      END $$;
    `);

    // 3. Add audit columns
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema = 'public' 
            AND table_name = 'admin_users' 
            AND column_name = 'created_at'
        ) THEN
          ALTER TABLE public.admin_users ADD COLUMN created_at timestamptz DEFAULT CURRENT_TIMESTAMP;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema = 'public' 
            AND table_name = 'admin_users' 
            AND column_name = 'last_login'
        ) THEN
          ALTER TABLE public.admin_users ADD COLUMN last_login timestamptz NULL;
        END IF;
      END $$;
    `);

    // 4. Safely migrate existing records
    await client.query(`
      UPDATE public.admin_users 
      SET admin_type = 'main' 
      WHERE admin_type IS NULL OR admin_type = '';
    `);

    // Deduplicate any existing duplicate rows before adding unique constraint
    await client.query(`
      DELETE FROM public.admin_users a
      USING public.admin_users b
      WHERE a.id > b.id
        AND a.username = b.username
        AND a.admin_type = b.admin_type;
    `);

    // 5. Add unique constraint on (admin_type, username)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'uq_admin_users_type_username'
        ) THEN
          ALTER TABLE public.admin_users 
          ADD CONSTRAINT uq_admin_users_type_username UNIQUE (admin_type, username);
        END IF;
      END $$;
    `);

    // 6. Generate bcrypt hashes dynamically (cost factor 12) - Zero hardcoded credentials
    const BCRYPT_ROUNDS = 12;
    const infraPass = process.env.PROVISION_INFRA_PASSWORD;
    const mainPass = process.env.PROVISION_MAIN_PASSWORD;

    if (mainPass) {
      const mainHash = await bcrypt.hash(mainPass, BCRYPT_ROUNDS);
      const mainUser = process.env.PROVISION_MAIN_USER || 'admin';
      await client.query(`
        INSERT INTO public.admin_users (username, password, admin_type)
        VALUES ($1, $2, 'main')
        ON CONFLICT (admin_type, username) 
        DO UPDATE SET password = EXCLUDED.password;
      `, [mainUser, mainHash]);
      console.log('Provisioned Main Admin in Supabase');
    }

    if (infraPass) {
      const infraHash = await bcrypt.hash(infraPass, BCRYPT_ROUNDS);
      const infraUser = process.env.PROVISION_INFRA_USER || 'admin';
      await client.query(`
        INSERT INTO public.admin_users (username, password, admin_type)
        VALUES ($1, $2, 'infrastructure')
        ON CONFLICT (admin_type, username) 
        DO UPDATE SET password = EXCLUDED.password;
      `, [infraUser, infraHash]);
      console.log('Provisioned Infrastructure Admin in Supabase');
    }

    // 7. Configure Row Level Security (RLS)
    await client.query(`
      ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.admin_users FROM anon;
      REVOKE ALL ON public.admin_users FROM authenticated;
      REVOKE ALL ON public.admin_users FROM public;
      DROP POLICY IF EXISTS "Public Access" ON public.admin_users;
      DROP POLICY IF EXISTS "Allow anon read" ON public.admin_users;
      DROP POLICY IF EXISTS "service_role_manage_admin_users" ON public.admin_users;
      CREATE POLICY "service_role_manage_admin_users"
        ON public.admin_users
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    // 7.5 Ensure infrastructure_config table exists with RLS
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.infrastructure_config (
        key VARCHAR(100) PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        is_locked BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
      );

      INSERT INTO public.infrastructure_config (key, label, is_locked)
      VALUES
        ('kitchen_status', 'Kitchen cum Store Status', false),
        ('kitchen_year', 'Kitchen Store Construction Year', false),
        ('repair_grant_status', 'Kitchen cum Store Repairing Grant Rs. 10000/- (10 years) received status', false),
        ('repair_grant_year', 'Repairing Grant (Rs. 10000/-) Receive Year', false),
        ('dining_status', 'Dining Hall Status', false),
        ('dining_fund', 'Dining Hall Fund sanctioned from', false),
        ('nutrition_status', 'Nutrition Garden Status', false),
        ('kitchen_device_status', 'Kitchen Device Status', false),
        ('kitchen_device_year', 'Kitchen Device Replacement Grant receive Year', false),
        ('toilet_separate', 'Separate Toilet for Boys and Girls', false),
        ('elec_status', 'Electric Connection Status', false),
        ('water_facilities', 'Drinking Water Facilities', false),
        ('water_purifier', 'Water Purifier', false),
        ('water_remarks', 'Remarks (if Any Requirement)', false)
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label;

      ALTER TABLE public.infrastructure_config ENABLE ROW LEVEL SECURITY;
      REVOKE INSERT, UPDATE, DELETE ON public.infrastructure_config FROM anon, public;
      GRANT SELECT ON public.infrastructure_config TO anon, authenticated, public;

      DROP POLICY IF EXISTS "public_read_infra_config" ON public.infrastructure_config;
      DROP POLICY IF EXISTS "service_role_manage_infra_config" ON public.infrastructure_config;

      CREATE POLICY "public_read_infra_config"
        ON public.infrastructure_config
        FOR SELECT
        USING (true);

      CREATE POLICY "service_role_manage_infra_config"
        ON public.infrastructure_config
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
    `);
    console.log('Infrastructure field permissions table provisioned in Supabase.');

    await client.query('COMMIT');
    console.log('Database transaction committed successfully.');

    // 8. Verify provisioned records
    const checkRes = await client.query(`
      SELECT id, username, admin_type, SUBSTRING(password, 1, 10) || '...' as hash_prefix, created_at 
      FROM public.admin_users 
      ORDER BY id ASC;
    `);
    console.log('\nVerified admin_users records in Supabase:');
    console.table(checkRes.rows);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, transaction rolled back:', err);
    throw err;
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

if (require.main === module) {
  migrateAndProvision().catch(err => {
    console.error('Fatal error during migration:', err);
    process.exit(1);
  });
}

module.exports = { migrateAndProvision };
