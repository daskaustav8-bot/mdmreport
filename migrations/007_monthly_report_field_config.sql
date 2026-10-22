-- =============================================================================
-- Migration: 007_monthly_report_field_config.sql
-- Description: Configuration table for Monthly Report Field Lock/Unlock Permissions
--              Stores category, field_name, labels, and lock states (true/false)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.monthly_report_field_config (
    key VARCHAR(100) PRIMARY KEY,
    category VARCHAR(50) NOT NULL,
    field_name VARCHAR(100) NOT NULL,
    label VARCHAR(255) NOT NULL,
    is_locked BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

INSERT INTO public.monthly_report_field_config (key, category, field_name, label, is_locked)
VALUES
    ('pri_bv_days', 'primary', 'bv_days', 'Number of School Days during Month (Bal Vatika PP)', false),
    ('pri_p_days', 'primary', 'p_days', 'Number of School Days during Month (Primary I-IV)', false),
    ('pri_bv_actual', 'primary', 'bv_actual', 'Actual Number of Days MDM Served (Bal Vatika PP)', false),
    ('pri_p_actual', 'primary', 'p_actual', 'Actual Number of Days MDM Served (Primary I-IV)', false),
    ('pri_bv_meals', 'primary', 'bv_meals', 'Total Meals Served during Month (Bal Vatika PP)', false),
    ('pri_p_meals', 'primary', 'p_meals', 'Total Meals Served during Month (Primary I-IV)', false),
    ('upr_p_days', 'upper_primary', 'p_days', 'Number of School Days during Month (Primary V)', false),
    ('upr_up_days', 'upper_primary', 'up_days', 'Number of School Days during Month (Upper Primary VI-VIII)', false),
    ('upr_p_actual', 'upper_primary', 'p_actual', 'Actual Number of Days MDM Served (Primary V)', false),
    ('upr_up_actual', 'upper_primary', 'up_actual', 'Actual Number of Days MDM Served (Upper Primary VI-VIII)', false),
    ('upr_p_meals', 'upper_primary', 'p_meals', 'Total Meals Served during Month (Primary V)', false),
    ('upr_up_meals', 'upper_primary', 'up_meals', 'Total Meals Served during Month (Upper Primary VI-VIII)', false)
ON CONFLICT (key) DO UPDATE SET
    category = EXCLUDED.category,
    field_name = EXCLUDED.field_name,
    label = EXCLUDED.label;

ALTER TABLE public.monthly_report_field_config ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.monthly_report_field_config FROM anon, public;
GRANT SELECT ON public.monthly_report_field_config TO anon, authenticated, public;

DROP POLICY IF EXISTS "public_read_monthly_report_field_config" ON public.monthly_report_field_config;
DROP POLICY IF EXISTS "service_role_manage_monthly_report_field_config" ON public.monthly_report_field_config;

CREATE POLICY "public_read_monthly_report_field_config"
    ON public.monthly_report_field_config FOR SELECT USING (true);

CREATE POLICY "service_role_manage_monthly_report_field_config"
    ON public.monthly_report_field_config FOR ALL TO service_role USING (true) WITH CHECK (true);
