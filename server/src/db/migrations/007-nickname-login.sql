-- Nickname required, email optional (owner 2026-08-22).
--
-- `users.email` already allowed NULL since 001-init (guests are created with
-- one), so an email-less account needs NO schema change — that column stays
-- `TEXT UNIQUE` and NULL keeps meaning "no email on file". SQLite treats NULLs
-- as distinct in a UNIQUE index, so any number of accounts can have none.
--
-- What DOES change is the nickname: with email optional it is the identifier a
-- pilot logs in with, so it must resolve to exactly one account. This adds the
-- UNIQUE index that `profiles.display_name` never had.
--
-- Backward compatibility: existing databases may already hold duplicate
-- nicknames (registration never checked, and pre-change accounts defaulted to
-- the email's local part). The index cannot be created over those, so the
-- duplicates are first disambiguated: the FIRST row keeps the name it has and
-- every later one gets its user id appended. Nobody is locked out — those
-- accounts could not have logged in by nickname before this migration anyway,
-- and an account with an email still signs in with it.
UPDATE profiles
SET display_name = display_name || '-' || user_id
WHERE rowid IN (
  SELECT p.rowid
  FROM profiles p
  WHERE EXISTS (
    SELECT 1 FROM profiles q
    WHERE q.display_name = p.display_name AND q.rowid < p.rowid
  )
);

CREATE UNIQUE INDEX idx_profiles_display_name ON profiles(display_name);
