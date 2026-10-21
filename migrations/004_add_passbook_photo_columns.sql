-- Migration 004: Add Passbook Photo Google Drive Reference Columns
-- Securely stores Google Drive file ID and view URL for Bank Passbook Photo attachments

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'mdm_monthly_report' 
          AND column_name = 'passbook_photo_file_id'
    ) THEN
        ALTER TABLE public.mdm_monthly_report 
        ADD COLUMN passbook_photo_file_id TEXT DEFAULT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'mdm_monthly_report' 
          AND column_name = 'passbook_photo_url'
    ) THEN
        ALTER TABLE public.mdm_monthly_report 
        ADD COLUMN passbook_photo_url TEXT DEFAULT NULL;
    END IF;
END $$;
