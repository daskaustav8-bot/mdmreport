require('dotenv').config();
const { pool } = require('../db/supabase');
const bcrypt = require('bcryptjs');

async function updatePasswords() {
  const hash123 = await bcrypt.hash('admin123', 12);
  let attempts = 0;
  while (attempts < 5) {
    attempts++;
    try {
      console.log(`Attempt ${attempts}...`);
      await pool.query(
        "UPDATE public.admin_users SET password = $1 WHERE username = 'admin' AND admin_type = 'infrastructure'",
        [hash123]
      );
      await pool.query(
        "UPDATE public.admin_users SET password = $1 WHERE username = 'admin' AND admin_type = 'main'",
        [hash123]
      );
      console.log('SUCCESS: Set password to admin123 for both main and infrastructure admin in Supabase.');

      const { rows } = await pool.query('SELECT id, username, admin_type FROM public.admin_users');
      console.table(rows);
      process.exit(0);
    } catch (e) {
      console.warn(`Attempt ${attempts} failed:`, e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  process.exit(1);
}

updatePasswords();
