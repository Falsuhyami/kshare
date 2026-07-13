-- ============================================================
-- Migration: Add contact_token column to unlocks table
-- Run this in Supabase SQL Editor → New Query → Run
-- ============================================================

ALTER TABLE unlocks
  ADD COLUMN IF NOT EXISTS contact_token UUID;

-- Optional: index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_unlocks_contact_token
  ON unlocks (contact_token)
  WHERE contact_token IS NOT NULL;
