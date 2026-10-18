-- Migration 002: Add Unique Constraint to public.mdm_monthly_report
-- Enforces uniqueness on (u_dise, month_name, year) for safe atomic upserts.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_mdm_monthly_report_udise_month_year'
    ) THEN
        ALTER TABLE public.mdm_monthly_report 
        ADD CONSTRAINT uq_mdm_monthly_report_udise_month_year UNIQUE (u_dise, month_name, year);
    END IF;
END $$;
