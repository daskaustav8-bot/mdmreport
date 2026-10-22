-- =============================================================================
-- Migration: 009_add_rice_details_lock_fields.sql
-- Description: Seed Food Grains (Rice) field keys into monthly_report_field_config
-- =============================================================================

INSERT INTO public.monthly_report_field_config (key, category, field_name, label, is_locked)
VALUES
    -- Primary School Food Grains (Rice)
    ('pri_rice_bv_open', 'primary', 'rice_bv_open', 'Rice Bal Vatika - Opening Balance (KG)', false),
    ('pri_rice_bv_recv', 'primary', 'rice_bv_recv', 'Rice Bal Vatika - Received (KG)', false),
    ('pri_rice_bv_cons', 'primary', 'rice_bv_cons', 'Rice Bal Vatika - Consumption (KG)', false),
    ('pri_rice_p_open', 'primary', 'rice_p_open', 'Rice Primary - Opening Balance (KG)', false),
    ('pri_rice_p_recv', 'primary', 'rice_p_recv', 'Rice Primary - Received (KG)', false),
    ('pri_rice_p_cons', 'primary', 'rice_p_cons', 'Rice Primary - Consumption (KG)', false),

    -- Upper Primary School Food Grains (Rice)
    ('upr_rice_p_open', 'upper_primary', 'rice_p_open', 'Rice Primary V - Opening Balance (KG)', false),
    ('upr_rice_p_recv', 'upper_primary', 'rice_p_recv', 'Rice Primary V - Received (KG)', false),
    ('upr_rice_p_cons', 'upper_primary', 'rice_p_cons', 'Rice Primary V - Consumption (KG)', false),
    ('upr_rice_up_open', 'upper_primary', 'rice_up_open', 'Rice Upper Primary - Opening Balance (KG)', false),
    ('upr_rice_up_recv', 'upper_primary', 'rice_up_recv', 'Rice Upper Primary - Received (KG)', false),
    ('upr_rice_up_cons', 'upper_primary', 'rice_up_cons', 'Rice Upper Primary - Consumption (KG)', false)
ON CONFLICT (key) DO UPDATE SET
    category = EXCLUDED.category,
    field_name = EXCLUDED.field_name,
    label = EXCLUDED.label;
