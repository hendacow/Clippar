-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ============================
-- PROFILES
-- ============================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  handicap INTEGER,
  home_course TEXT,
  avatar_url TEXT,
  subscription_status TEXT DEFAULT 'free' CHECK (subscription_status IN ('free', 'trial', 'active', 'cancelled', 'expired')),
  subscription_expires_at TIMESTAMPTZ,
  hardware_kit_ordered BOOLEAN DEFAULT FALSE,
  ble_device_id TEXT,
  expo_push_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup
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

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================
-- COURSES
-- ============================
CREATE TABLE courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  location_name TEXT,
  state TEXT,
  country TEXT DEFAULT 'AU',
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  location GEOMETRY(Point, 4326),
  holes_count INTEGER DEFAULT 18,
  par_total INTEGER,
  slope_rating INTEGER,
  course_rating DECIMAL(4, 1),
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Courses are publicly readable" ON courses FOR SELECT TO authenticated USING (TRUE);

CREATE INDEX idx_courses_location ON courses USING GIST(location);

-- ============================
-- HOLES (per course)
-- ============================
CREATE TABLE holes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  hole_number INTEGER NOT NULL CHECK (hole_number >= 1 AND hole_number <= 18),
  par INTEGER NOT NULL CHECK (par >= 3 AND par <= 6),
  stroke_index INTEGER,
  length_meters INTEGER,
  tee_latitude DECIMAL(10, 8),
  tee_longitude DECIMAL(11, 8),
  green_latitude DECIMAL(10, 8),
  green_longitude DECIMAL(11, 8),
  tee_location GEOMETRY(Point, 4326),
  green_location GEOMETRY(Point, 4326),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(course_id, hole_number)
);

ALTER TABLE holes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Holes are publicly readable" ON holes FOR SELECT TO authenticated USING (TRUE);

-- ============================
-- ROUNDS
-- ============================
CREATE TABLE rounds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id),
  course_name TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_score INTEGER,
  total_par INTEGER,
  score_to_par INTEGER,
  total_putts INTEGER,
  holes_played INTEGER DEFAULT 18,
  status TEXT DEFAULT 'recording' CHECK (status IN ('recording', 'uploading', 'processing', 'ready', 'failed')),
  reel_url TEXT,
  reel_duration_seconds INTEGER,
  music_track_id TEXT,
  thumbnail_url TEXT,
  is_published BOOLEAN DEFAULT FALSE,
  share_token TEXT UNIQUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own rounds" ON rounds FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Shared rounds are publicly viewable" ON rounds FOR SELECT USING (share_token IS NOT NULL AND is_published = TRUE);

CREATE INDEX idx_rounds_user ON rounds(user_id);
CREATE INDEX idx_rounds_date ON rounds(user_id, date DESC);
CREATE INDEX idx_rounds_status ON rounds(user_id, status);

-- ============================
-- SCORES (per hole per round)
-- ============================
CREATE TABLE scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  hole_number INTEGER NOT NULL CHECK (hole_number >= 1 AND hole_number <= 18),
  strokes INTEGER NOT NULL CHECK (strokes >= 1),
  putts INTEGER DEFAULT 0,
  penalty_strokes INTEGER DEFAULT 0,
  is_pickup BOOLEAN DEFAULT FALSE,
  fairway_hit BOOLEAN,
  green_in_regulation BOOLEAN,
  score_to_par INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(round_id, hole_number)
);

ALTER TABLE scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own scores" ON scores FOR ALL
  USING (EXISTS (SELECT 1 FROM rounds WHERE rounds.id = scores.round_id AND rounds.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM rounds WHERE rounds.id = scores.round_id AND rounds.user_id = auth.uid()));

-- ============================
-- SHOTS (individual clips)
-- ============================
CREATE TABLE shots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id),
  hole_number INTEGER NOT NULL,
  shot_number INTEGER NOT NULL,
  clip_url TEXT,
  processed_clip_url TEXT,
  gps_latitude DECIMAL(10, 8),
  gps_longitude DECIMAL(11, 8),
  detection_method TEXT CHECK (detection_method IN ('ball', 'audio', 'ball+audio', 'no_detection', 'pending')),
  duration_seconds DECIMAL(5, 2),
  is_penalty BOOLEAN DEFAULT FALSE,
  is_excluded BOOLEAN DEFAULT FALSE,
  sort_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE shots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own shots" ON shots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_shots_round ON shots(round_id, hole_number, shot_number);

-- ============================
-- PROCESSING JOBS
-- ============================
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id),
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'noise_reduction', 'detection', 'stitching', 'uploading', 'completed', 'failed')),
  progress_percent INTEGER DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100),
  modal_job_id TEXT,
  error_message TEXT,
  processing_time_seconds INTEGER,
  clips_detected INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own jobs" ON processing_jobs FOR SELECT USING (auth.uid() = user_id);

-- ============================
-- HARDWARE ORDERS
-- ============================
CREATE TABLE hardware_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id),
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'aud',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'returned', 'refunded')),
  kit_type TEXT DEFAULT 'standard' CHECK (kit_type IN ('standard', 'premium')),
  shipping_name TEXT,
  shipping_address_line1 TEXT,
  shipping_address_line2 TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_postal_code TEXT,
  shipping_country TEXT DEFAULT 'AU',
  tracking_number TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE hardware_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own orders" ON hardware_orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own orders" ON hardware_orders FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================
-- MUSIC TRACKS
-- ============================
CREATE TABLE music_tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  artist TEXT,
  duration_seconds INTEGER,
  genre TEXT,
  mood TEXT,
  file_url TEXT NOT NULL,
  preview_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE music_tracks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Music tracks are publicly readable" ON music_tracks FOR SELECT TO authenticated USING (is_active = TRUE);

-- ============================
-- DAILY USAGE TRACKING
-- ============================
CREATE TABLE daily_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  rounds_processed INTEGER DEFAULT 0,
  uploads_count INTEGER DEFAULT 0,
  UNIQUE(user_id, date)
);

ALTER TABLE daily_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own usage" ON daily_usage FOR SELECT USING (auth.uid() = user_id);

-- ============================
-- ADMIN USERS
-- ============================
CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users,
  email TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Only super_admins can manage admins" ON admin_users
  FOR ALL USING (
    EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid() AND role = 'super_admin')
  );
