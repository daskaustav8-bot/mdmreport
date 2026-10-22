-- =============================================================================
-- Migration: 010_add_others_fund_field.sql
-- Description: Add oth columns to mdm_monthly_report and seed lock field config
-- =============================================================================

ALTER TABLE public.mdm_monthly_report 
ADD COLUMN IF NOT EXISTS oth_open NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS oth_recv NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS oth_exp NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS oth_close NUMERIC DEFAULT 0;

INSERT INTO public.monthly_report_field_config (key, category, field_name, label, is_locked)
VALUES
    ('pri_oth_open', 'primary', 'oth_open', 'Others - Opening Balance', false),
    ('pri_oth_recv', 'primary', 'oth_recv', 'Others - Received', false),
    ('pri_oth_exp', 'primary', 'oth_exp', 'Others - Expenditure', false),
    ('upr_oth_open', 'upper_primary', 'oth_open', 'Others - Opening Balance', false),
    ('upr_oth_recv', 'upper_primary', 'oth_recv', 'Others - Received', false),
    ('upr_oth_exp', 'upper_primary', 'oth_exp', 'Others - Expenditure', false)
ON CONFLICT (key) DO UPDATE SET
    category = EXCLUDED.category,
    field_name = EXCLUDED.field_name,
    label = EXCLUDED.label;
