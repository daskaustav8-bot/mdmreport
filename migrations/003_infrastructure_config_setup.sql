-- =============================================================================
-- Migration: 003_infrastructure_config_setup.sql
-- Description: Minimal configuration table for School Infrastructure Field Permissions
--              Stores field keys, labels, lock states, and timestamps in Supabase.
--              Includes Row Level Security (RLS) policies.
-- =============================================================================

BEGIN;

-- 1. Create table public.infrastructure_config if not exists
CREATE TABLE IF NOT EXISTS public.infrastructure_config (
    key VARCHAR(100) PRIMARY KEY,
    label VARCHAR(255) NOT NULL,
    is_locked BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Seed the 14 standard infrastructure fields (defaults to unlocked: is_locked = false)
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

-- 3. Configure Row Level Security (RLS)
ALTER TABLE public.infrastructure_config ENABLE ROW LEVEL SECURITY;

-- Revoke mutation permissions from public and anon roles
REVOKE INSERT, UPDATE, DELETE ON public.infrastructure_config FROM anon, public;
GRANT SELECT ON public.infrastructure_config TO anon, authenticated, public;

-- Drop any previous conflicting policies
DROP POLICY IF EXISTS "Public Access" ON public.infrastructure_config;
DROP POLICY IF EXISTS "Allow anon read" ON public.infrastructure_config;
DROP POLICY IF EXISTS "public_read_infra_config" ON public.infrastructure_config;
DROP POLICY IF EXISTS "service_role_manage_infra_config" ON public.infrastructure_config;

-- Policy 1: Read-only access for public/anonymous clients
CREATE POLICY "public_read_infra_config"
    ON public.infrastructure_config
    FOR SELECT
    USING (true);

-- Policy 2: Full management access strictly for service_role
CREATE POLICY "service_role_manage_infra_config"
    ON public.infrastructure_config
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMIT;
