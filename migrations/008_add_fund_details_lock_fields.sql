-- =============================================================================
-- Migration: 008_add_fund_details_lock_fields.sql
-- Description: Seed Fund Details field keys into monthly_report_field_config
-- =============================================================================

INSERT INTO public.monthly_report_field_config (key, category, field_name, label, is_locked)
VALUES
    -- Primary School Fund Details
    ('pri_cc_bv_open', 'primary', 'cc_bv_open', 'Material Cost Bal Vatika - Opening Balance', false),
    ('pri_cc_bv_recv', 'primary', 'cc_bv_recv', 'Material Cost Bal Vatika - Received', false),
    ('pri_cc_bv_exp', 'primary', 'cc_bv_exp', 'Material Cost Bal Vatika - Expenditure', false),

    ('pri_cc_p_open', 'primary', 'cc_p_open', 'Material Cost Primary - Opening Balance', false),
    ('pri_cc_p_recv', 'primary', 'cc_p_recv', 'Material Cost Primary - Received', false),
    ('pri_cc_p_exp', 'primary', 'cc_p_exp', 'Material Cost Primary - Expenditure', false),

    ('pri_bi_open', 'primary', 'bi_open', 'Bank Interest - Opening Balance', false),
    ('pri_bi_recv', 'primary', 'bi_recv', 'Bank Interest - Received', false),
    ('pri_bi_exp', 'primary', 'bi_exp', 'Bank Interest - Expenditure', false),

    ('pri_lpg_open', 'primary', 'lpg_open', 'LPG Subsidy - Opening Balance', false),
    ('pri_lpg_recv', 'primary', 'lpg_recv', 'LPG Subsidy - Received', false),
    ('pri_lpg_exp', 'primary', 'lpg_exp', 'LPG Subsidy - Expenditure', false),

    ('pri_nutri_open', 'primary', 'nutri_open', 'Supplementary / Extra Nutrition - Opening Balance', false),
    ('pri_nutri_recv', 'primary', 'nutri_recv', 'Supplementary / Extra Nutrition - Received', false),
    ('pri_nutri_exp', 'primary', 'nutri_exp', 'Supplementary / Extra Nutrition - Expenditure', false),

    ('pri_mme_open', 'primary', 'mme_open', 'School Expenses (MME) - Opening Balance', false),
    ('pri_mme_recv', 'primary', 'mme_recv', 'School Expenses (MME) - Received', false),
    ('pri_mme_exp', 'primary', 'mme_exp', 'School Expenses (MME) - Expenditure', false),

    ('pri_kd_open', 'primary', 'kd_open', 'Kitchen Devices - Opening Balance', false),
    ('pri_kd_recv', 'primary', 'kd_recv', 'Kitchen Devices - Received', false),
    ('pri_kd_exp', 'primary', 'kd_exp', 'Kitchen Devices - Expenditure', false),

    ('pri_ks_open', 'primary', 'ks_open', 'Kitchen Shed Repair - Opening Balance', false),
    ('pri_ks_recv', 'primary', 'ks_recv', 'Kitchen Shed Repair - Received', false),
    ('pri_ks_exp', 'primary', 'ks_exp', 'Kitchen Shed Repair - Expenditure', false),

    ('pri_ng_open', 'primary', 'ng_open', 'Nutrition Garden - Opening Balance', false),
    ('pri_ng_recv', 'primary', 'ng_recv', 'Nutrition Garden - Received', false),
    ('pri_ng_exp', 'primary', 'ng_exp', 'Nutrition Garden - Expenditure', false),

    ('pri_bc_open', 'primary', 'bc_open', 'Bank Charges (SMS/Cheque Book) - Opening Balance', false),
    ('pri_bc_recv', 'primary', 'bc_recv', 'Bank Charges (SMS/Cheque Book) - Received', false),
    ('pri_bc_exp', 'primary', 'bc_exp', 'Bank Charges (SMS/Cheque Book) - Expenditure', false),

    -- Upper Primary School Fund Details
    ('upr_cc_p_open', 'upper_primary', 'cc_p_open', 'Material Cost Primary - Opening Balance', false),
    ('upr_cc_p_recv', 'upper_primary', 'cc_p_recv', 'Material Cost Primary - Received', false),
    ('upr_cc_p_exp', 'upper_primary', 'cc_p_exp', 'Material Cost Primary - Expenditure', false),

    ('upr_cc_up_open', 'upper_primary', 'cc_up_open', 'Material Cost Upper Primary - Opening Balance', false),
    ('upr_cc_up_recv', 'upper_primary', 'cc_up_recv', 'Material Cost Upper Primary - Received', false),
    ('upr_cc_up_exp', 'upper_primary', 'cc_up_exp', 'Material Cost Upper Primary - Expenditure', false),

    ('upr_bi_open', 'upper_primary', 'bi_open', 'Bank Interest - Opening Balance', false),
    ('upr_bi_recv', 'upper_primary', 'bi_recv', 'Bank Interest - Received', false),
    ('upr_bi_exp', 'upper_primary', 'bi_exp', 'Bank Interest - Expenditure', false),

    ('upr_lpg_open', 'upper_primary', 'lpg_open', 'LPG Subsidy - Opening Balance', false),
    ('upr_lpg_recv', 'upper_primary', 'lpg_recv', 'LPG Subsidy - Received', false),
    ('upr_lpg_exp', 'upper_primary', 'lpg_exp', 'LPG Subsidy - Expenditure', false),

    ('upr_nutri_open', 'upper_primary', 'nutri_open', 'Supplementary / Extra Nutrition - Opening Balance', false),
    ('upr_nutri_recv', 'upper_primary', 'nutri_recv', 'Supplementary / Extra Nutrition - Received', false),
    ('upr_nutri_exp', 'upper_primary', 'nutri_exp', 'Supplementary / Extra Nutrition - Expenditure', false),

    ('upr_mme_open', 'upper_primary', 'mme_open', 'School Expenses (MME) - Opening Balance', false),
    ('upr_mme_recv', 'upper_primary', 'mme_recv', 'School Expenses (MME) - Received', false),
    ('upr_mme_exp', 'upper_primary', 'mme_exp', 'School Expenses (MME) - Expenditure', false),

    ('upr_kd_open', 'upper_primary', 'kd_open', 'Kitchen Devices - Opening Balance', false),
    ('upr_kd_recv', 'upper_primary', 'kd_recv', 'Kitchen Devices - Received', false),
    ('upr_kd_exp', 'upper_primary', 'kd_exp', 'Kitchen Devices - Expenditure', false),

    ('upr_ks_open', 'upper_primary', 'ks_open', 'Kitchen Shed Repair - Opening Balance', false),
    ('upr_ks_recv', 'upper_primary', 'ks_recv', 'Kitchen Shed Repair - Received', false),
    ('upr_ks_exp', 'upper_primary', 'ks_exp', 'Kitchen Shed Repair - Expenditure', false),

    ('upr_ng_open', 'upper_primary', 'ng_open', 'Nutrition Garden - Opening Balance', false),
    ('upr_ng_recv', 'upper_primary', 'ng_recv', 'Nutrition Garden - Received', false),
    ('upr_ng_exp', 'upper_primary', 'ng_exp', 'Nutrition Garden - Expenditure', false),

    ('upr_bc_open', 'upper_primary', 'bc_open', 'Bank Charges (SMS/Cheque Book) - Opening Balance', false),
    ('upr_bc_recv', 'upper_primary', 'bc_recv', 'Bank Charges (SMS/Cheque Book) - Received', false),
    ('upr_bc_exp', 'upper_primary', 'bc_exp', 'Bank Charges (SMS/Cheque Book) - Expenditure', false)
ON CONFLICT (key) DO UPDATE SET
    category = EXCLUDED.category,
    field_name = EXCLUDED.field_name,
    label = EXCLUDED.label;
