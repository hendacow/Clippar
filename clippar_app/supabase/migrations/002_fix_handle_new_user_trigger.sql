-- Fix: make handle_new_user trigger fault-tolerant
-- The original trigger would abort the entire auth.users INSERT if the
-- profiles INSERT failed (e.g. duplicate key, missing column, etc.),
-- causing "Database error saving new user" on signup.
--
-- This version:
--   1. Uses ON CONFLICT to handle duplicate profile rows gracefully
--   2. Wraps the body in an EXCEPTION block so that any unexpected error
--      is logged but does NOT prevent the user from being created in auth.users

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = COALESCE(EXCLUDED.display_name, profiles.display_name),
    updated_at = NOW();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'handle_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
