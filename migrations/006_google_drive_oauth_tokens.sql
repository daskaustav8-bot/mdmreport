-- =========================================================================
-- Migration 006: Google Drive OAuth Tokens Table Setup
-- Secure AES-256-GCM Encrypted Refresh Token Storage with RLS
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.google_drive_oauth_tokens (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL DEFAULT 'google',
    account_email VARCHAR(255) NULL,
    encrypted_refresh_token TEXT NOT NULL,
    token_iv VARCHAR(64) NOT NULL,
    token_auth_tag VARCHAR(64) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NULL,
    is_testing_mode BOOLEAN NOT NULL DEFAULT true,
    status VARCHAR(50) NOT NULL DEFAULT 'connected',
    last_verified_at TIMESTAMPTZ NULL,
    last_error TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_google_drive_oauth_provider UNIQUE (provider),
    CONSTRAINT chk_google_oauth_status CHECK (status IN ('connected', 'expiring_soon', 'expired', 'reconnection_required'))
);

-- Index on provider for fast lookups
CREATE INDEX IF NOT EXISTS idx_google_drive_oauth_provider ON public.google_drive_oauth_tokens (provider);

-- Enable Row Level Security
ALTER TABLE public.google_drive_oauth_tokens ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all permissions from public, anon, and authenticated roles
REVOKE ALL ON public.google_drive_oauth_tokens FROM PUBLIC, anon, authenticated;
