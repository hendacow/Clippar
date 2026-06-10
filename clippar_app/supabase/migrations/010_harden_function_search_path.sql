-- 010_harden_function_search_path.sql
--
-- Security hardening for the Supabase advisor warning
-- "Function Search Path Mutable" on our own functions:
--   - public.handle_new_user()              (SECURITY DEFINER signup trigger)
--   - public.seed_course(...)               (course/hole seeding helper)
--   - public.touch_course_presets_updated_at()  (updated_at trigger)
--
-- WHAT THIS CHANGES: nothing about the functions' behaviour. We do NOT touch
-- the function bodies. We only pin each function's `search_path` so it is FIXED
-- instead of inherited from (and manipulable by) the caller. This closes the
-- search-path-hijack vector flagged by the advisor.
--
-- WHY `public, pg_temp`: the bodies reference tables (profiles, courses, holes)
-- and PostGIS functions (st_setsrid, st_makepoint) that live in `public`, so
-- pinning to `public` keeps every reference resolving exactly as it does today
-- (no need to schema-qualify the bodies). pg_temp is listed LAST, which is the
-- safe ordering. On Supabase the `public` schema is not writable by anon /
-- authenticated roles, so `public` in the path is safe.
--
-- Implemented as a DO block that looks up each function's exact signature via
-- its oid, so we never have to hand-write argument-type lists (robust against
-- decimal/numeric aliasing and any overloads).

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'handle_new_user',
        'seed_course',
        'touch_course_presets_updated_at'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);
    RAISE NOTICE 'Pinned search_path on %', fn.sig;
  END LOOP;
END $$;
