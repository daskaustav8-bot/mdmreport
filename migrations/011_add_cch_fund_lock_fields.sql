-- =============================================================================
-- Migration: 011_add_cch_fund_lock_fields.sql
-- Description: Seed Cook Cum Helper field keys into monthly_report_field_config
-- =============================================================================

INSERT INTO public.monthly_report_field_config (key, category, field_name, label, is_locked)
VALUES
    -- Primary School Cook Cum Helper
    ('pri_cch_open', 'primary', 'cch_open', 'Cook Cum Helper - Opening Balance', false),
    ('pri_cch_recv', 'primary', 'cch_recv', 'Cook Cum Helper - Received', false),
    ('pri_cch_exp', 'primary', 'cch_exp', 'Cook Cum Helper - Expenditure', false),

    -- Upper Primary School Cook Cum Helper
    ('upr_cch_open', 'upper_primary', 'cch_open', 'Cook Cum Helper - Opening Balance', false),
    ('upr_cch_recv', 'upper_primary', 'cch_recv', 'Cook Cum Helper - Received', false),
    ('upr_cch_exp', 'upper_primary', 'cch_exp', 'Cook Cum Helper - Expenditure', false)
ON CONFLICT (key) DO UPDATE SET
    category = EXCLUDED.category,
    field_name = EXCLUDED.field_name,
    label = EXCLUDED.label;
