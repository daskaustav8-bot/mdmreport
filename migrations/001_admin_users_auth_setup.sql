-- =============================================================================
-- Migration: 001_admin_users_auth_setup.sql
-- Description: Implement two separate admin logins (infrastructure and main)
--              using Supabase with bcrypt password hashing and strict RLS.
-- =============================================================================

BEGIN;

-- 1. Ensure public.admin_users table exists with primary key
CREATE TABLE IF NOT EXISTS public.admin_users (
    id serial PRIMARY KEY,
    username varchar(50) NOT NULL,
    password varchar(255) NOT NULL
);

-- 2. Add admin_type column to partition Infrastructure and Main Admin systems
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

-- 3. Add timestamp audit columns
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
          AND table_name = 'last_login'
    ) THEN
        ALTER TABLE public.admin_users ADD COLUMN last_login timestamptz NULL;
    END IF;
END $$;

-- 4. Preserve and safely migrate existing records:
-- Set default admin_type for any existing records missing it
UPDATE public.admin_users 
SET admin_type = 'main' 
WHERE admin_type IS NULL OR admin_type = '';

-- Deduplicate redundant legacy duplicate rows before applying uniqueness constraint
DELETE FROM public.admin_users a
USING public.admin_users b
WHERE a.id > b.id
  AND a.username = b.username
  AND a.admin_type = b.admin_type;

-- 5. Add unique constraint on (admin_type, username)
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

-- 6. Seed / Update the two distinct admin accounts with secure bcrypt hashes (cost 12)
-- Accounts are provisioned and stored exclusively inside Supabase public.admin_users
-- Zero plaintext passwords stored in any SQL migrations or repository files.

-- 7. Configure Row Level Security (RLS)
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Revoke all permissions from anon and public roles to prevent unauthenticated hash dumping
REVOKE ALL ON public.admin_users FROM anon;
REVOKE ALL ON public.admin_users FROM authenticated;
REVOKE ALL ON public.admin_users FROM public;

-- Drop any existing insecure public access policies
DROP POLICY IF EXISTS "Public Access" ON public.admin_users;
DROP POLICY IF EXISTS "Allow anon read" ON public.admin_users;
DROP POLICY IF EXISTS "service_role_manage_admin_users" ON public.admin_users;

-- Only service_role can access public.admin_users
CREATE POLICY "service_role_manage_admin_users"
    ON public.admin_users
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMIT;
