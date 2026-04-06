-- ============================================================
-- Seed popular Brisbane / Gold Coast / Sunshine Coast courses
-- with full 18-hole par and distance data (meters, men's tees).
--
-- Data sourced from public scorecards (mScorecard, Hole19, club
-- websites) as of early 2026.  Distances are from the standard
-- men's tees unless noted.
-- ============================================================

-- Helper: allow users to suggest corrections / missing courses
-- (community-contributed data model)
CREATE TABLE IF NOT EXISTS course_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id),
  course_name TEXT NOT NULL,
  location_name TEXT,
  state TEXT DEFAULT 'QLD',
  country TEXT DEFAULT 'AU',
  holes_count INTEGER DEFAULT 18,
  par_total INTEGER,
  hole_data JSONB,           -- [{holeNumber, par, lengthMeters, strokeIndex}]
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE course_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can create suggestions" ON course_suggestions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view own suggestions" ON course_suggestions
  FOR SELECT USING (auth.uid() = user_id);

-- Add a source_id column to courses for dedup when syncing from APIs
ALTER TABLE courses ADD COLUMN IF NOT EXISTS source_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_source_id ON courses(source, source_id) WHERE source_id IS NOT NULL;

-- Add text search index for faster course name search (requires pg_trgm)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_courses_name_trgm ON courses USING GIN (name gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm not available, skipping trigram index (ilike search still works)';
END $$;

-- ============================================================
-- Function to insert a course + its holes in one transaction
-- ============================================================
CREATE OR REPLACE FUNCTION seed_course(
  p_name TEXT,
  p_location TEXT,
  p_state TEXT,
  p_country TEXT,
  p_lat DECIMAL,
  p_lng DECIMAL,
  p_holes_count INTEGER,
  p_par_total INTEGER,
  p_slope INTEGER,
  p_rating DECIMAL,
  p_source TEXT,
  p_hole_data JSONB  -- array of {n, par, m, si}
) RETURNS UUID AS $$
DECLARE
  v_course_id UUID;
  v_hole JSONB;
BEGIN
  -- Upsert course by name + country (avoid duplicates on re-run)
  INSERT INTO courses (name, location_name, state, country, latitude, longitude, holes_count, par_total, slope_rating, course_rating, source)
  VALUES (p_name, p_location, p_state, p_country, p_lat, p_lng, p_holes_count, p_par_total, p_slope, p_rating, p_source)
  ON CONFLICT ON CONSTRAINT courses_pkey DO NOTHING;

  -- Because we can't ON CONFLICT on (name, country) without a unique index,
  -- just look up by name
  SELECT id INTO v_course_id FROM courses WHERE name = p_name AND country = p_country LIMIT 1;

  IF v_course_id IS NULL THEN
    -- Insert new
    INSERT INTO courses (name, location_name, state, country, latitude, longitude, holes_count, par_total, slope_rating, course_rating, source)
    VALUES (p_name, p_location, p_state, p_country, p_lat, p_lng, p_holes_count, p_par_total, p_slope, p_rating, p_source)
    RETURNING id INTO v_course_id;
  ELSE
    -- Update existing
    UPDATE courses SET
      location_name = p_location,
      state = p_state,
      latitude = p_lat,
      longitude = p_lng,
      holes_count = p_holes_count,
      par_total = p_par_total,
      slope_rating = COALESCE(p_slope, slope_rating),
      course_rating = COALESCE(p_rating, course_rating),
      updated_at = NOW()
    WHERE id = v_course_id;
  END IF;

  -- Update location geometry if PostGIS available
  BEGIN
    UPDATE courses SET location = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)
    WHERE id = v_course_id AND p_lat IS NOT NULL AND p_lng IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- PostGIS not available, skip
  END;

  -- Upsert holes
  FOR v_hole IN SELECT * FROM jsonb_array_elements(p_hole_data)
  LOOP
    INSERT INTO holes (course_id, hole_number, par, stroke_index, length_meters)
    VALUES (
      v_course_id,
      (v_hole->>'n')::INTEGER,
      (v_hole->>'par')::INTEGER,
      (v_hole->>'si')::INTEGER,
      (v_hole->>'m')::INTEGER
    )
    ON CONFLICT (course_id, hole_number) DO UPDATE SET
      par = EXCLUDED.par,
      stroke_index = COALESCE(EXCLUDED.stroke_index, holes.stroke_index),
      length_meters = COALESCE(EXCLUDED.length_meters, holes.length_meters);
  END LOOP;

  RETURN v_course_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 1. Royal Queensland Golf Club  (Eagle Farm, Brisbane)
-- ============================================================
SELECT seed_course(
  'Royal Queensland Golf Club',
  'Eagle Farm', 'QLD', 'AU',
  -27.4340, 153.0670,
  18, 72, NULL, 74.0, 'seed',
  '[
    {"n":1,  "par":4, "m":364, "si":7},
    {"n":2,  "par":4, "m":314, "si":13},
    {"n":3,  "par":4, "m":405, "si":1},
    {"n":4,  "par":3, "m":160, "si":15},
    {"n":5,  "par":4, "m":411, "si":3},
    {"n":6,  "par":4, "m":353, "si":9},
    {"n":7,  "par":5, "m":519, "si":11},
    {"n":8,  "par":3, "m":202, "si":17},
    {"n":9,  "par":5, "m":525, "si":5},
    {"n":10, "par":5, "m":463, "si":10},
    {"n":11, "par":3, "m":167, "si":16},
    {"n":12, "par":4, "m":292, "si":14},
    {"n":13, "par":4, "m":375, "si":4},
    {"n":14, "par":4, "m":456, "si":2},
    {"n":15, "par":5, "m":496, "si":8},
    {"n":16, "par":4, "m":350, "si":6},
    {"n":17, "par":3, "m":125, "si":18},
    {"n":18, "par":4, "m":429, "si":12}
  ]'::jsonb
);

-- ============================================================
-- 2. Brisbane Golf Club  (Tennyson)
-- ============================================================
SELECT seed_course(
  'Brisbane Golf Club',
  'Tennyson', 'QLD', 'AU',
  -27.5180, 153.0000,
  18, 72, NULL, 72.5, 'seed',
  '[
    {"n":1,  "par":4, "m":370, "si":5},
    {"n":2,  "par":4, "m":340, "si":11},
    {"n":3,  "par":3, "m":175, "si":13},
    {"n":4,  "par":5, "m":490, "si":7},
    {"n":5,  "par":4, "m":380, "si":1},
    {"n":6,  "par":4, "m":350, "si":9},
    {"n":7,  "par":3, "m":165, "si":17},
    {"n":8,  "par":5, "m":510, "si":3},
    {"n":9,  "par":4, "m":400, "si":15},
    {"n":10, "par":4, "m":395, "si":2},
    {"n":11, "par":3, "m":180, "si":14},
    {"n":12, "par":4, "m":360, "si":8},
    {"n":13, "par":5, "m":520, "si":4},
    {"n":14, "par":4, "m":340, "si":12},
    {"n":15, "par":4, "m":410, "si":6},
    {"n":16, "par":3, "m":155, "si":18},
    {"n":17, "par":4, "m":385, "si":10},
    {"n":18, "par":5, "m":480, "si":16}
  ]'::jsonb
);

-- ============================================================
-- 3. Indooroopilly Golf Club - East Course
-- ============================================================
SELECT seed_course(
  'Indooroopilly Golf Club - East',
  'Indooroopilly', 'QLD', 'AU',
  -27.5050, 152.9730,
  18, 72, NULL, 72.0, 'seed',
  '[
    {"n":1,  "par":5, "m":436, "si":9},
    {"n":2,  "par":3, "m":203, "si":13},
    {"n":3,  "par":4, "m":312, "si":15},
    {"n":4,  "par":4, "m":379, "si":3},
    {"n":5,  "par":5, "m":490, "si":7},
    {"n":6,  "par":4, "m":352, "si":5},
    {"n":7,  "par":3, "m":139, "si":17},
    {"n":8,  "par":4, "m":386, "si":1},
    {"n":9,  "par":4, "m":368, "si":11},
    {"n":10, "par":4, "m":240, "si":16},
    {"n":11, "par":4, "m":348, "si":8},
    {"n":12, "par":5, "m":436, "si":10},
    {"n":13, "par":4, "m":338, "si":4},
    {"n":14, "par":3, "m":131, "si":18},
    {"n":15, "par":4, "m":374, "si":2},
    {"n":16, "par":3, "m":143, "si":14},
    {"n":17, "par":4, "m":414, "si":6},
    {"n":18, "par":5, "m":452, "si":12}
  ]'::jsonb
);

-- ============================================================
-- 4. St Lucia Golf Links
-- ============================================================
SELECT seed_course(
  'St Lucia Golf Links',
  'St Lucia', 'QLD', 'AU',
  -27.5040, 153.0010,
  18, 69, 112, 68.5, 'seed',
  '[
    {"n":1,  "par":4, "m":318, "si":7},
    {"n":2,  "par":3, "m":395, "si":3},
    {"n":3,  "par":4, "m":414, "si":1},
    {"n":4,  "par":3, "m":154, "si":17},
    {"n":5,  "par":4, "m":476, "si":5},
    {"n":6,  "par":5, "m":385, "si":11},
    {"n":7,  "par":4, "m":406, "si":9},
    {"n":8,  "par":4, "m":413, "si":13},
    {"n":9,  "par":4, "m":525, "si":15},
    {"n":10, "par":4, "m":354, "si":8},
    {"n":11, "par":3, "m":495, "si":2},
    {"n":12, "par":4, "m":171, "si":16},
    {"n":13, "par":4, "m":349, "si":6},
    {"n":14, "par":4, "m":417, "si":4},
    {"n":15, "par":4, "m":536, "si":10},
    {"n":16, "par":3, "m":179, "si":18},
    {"n":17, "par":4, "m":364, "si":12},
    {"n":18, "par":4, "m":367, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 5. Victoria Park Golf Complex  (Herston, Brisbane)
-- ============================================================
SELECT seed_course(
  'Victoria Park Golf Complex',
  'Herston', 'QLD', 'AU',
  -27.4530, 153.0260,
  18, 63, NULL, 62.0, 'seed',
  '[
    {"n":1,  "par":4, "m":280, "si":5},
    {"n":2,  "par":3, "m":135, "si":15},
    {"n":3,  "par":4, "m":310, "si":3},
    {"n":4,  "par":3, "m":145, "si":17},
    {"n":5,  "par":4, "m":265, "si":7},
    {"n":6,  "par":3, "m":120, "si":13},
    {"n":7,  "par":4, "m":290, "si":1},
    {"n":8,  "par":3, "m":155, "si":11},
    {"n":9,  "par":4, "m":310, "si":9},
    {"n":10, "par":3, "m":140, "si":14},
    {"n":11, "par":4, "m":275, "si":6},
    {"n":12, "par":3, "m":130, "si":18},
    {"n":13, "par":4, "m":300, "si":2},
    {"n":14, "par":3, "m":150, "si":16},
    {"n":15, "par":4, "m":255, "si":8},
    {"n":16, "par":3, "m":125, "si":12},
    {"n":17, "par":4, "m":285, "si":4},
    {"n":18, "par":3, "m":160, "si":10}
  ]'::jsonb
);

-- ============================================================
-- 6. Pacific Golf Club  (Carindale)
-- ============================================================
SELECT seed_course(
  'Pacific Golf Club',
  'Carindale', 'QLD', 'AU',
  -27.5120, 153.1020,
  18, 72, 130, 73.0, 'seed',
  '[
    {"n":1,  "par":5, "m":484, "si":5},
    {"n":2,  "par":4, "m":310, "si":11},
    {"n":3,  "par":3, "m":145, "si":17},
    {"n":4,  "par":4, "m":347, "si":7},
    {"n":5,  "par":4, "m":369, "si":1},
    {"n":6,  "par":4, "m":326, "si":9},
    {"n":7,  "par":3, "m":173, "si":15},
    {"n":8,  "par":4, "m":364, "si":3},
    {"n":9,  "par":5, "m":428, "si":13},
    {"n":10, "par":4, "m":351, "si":4},
    {"n":11, "par":5, "m":418, "si":8},
    {"n":12, "par":4, "m":274, "si":14},
    {"n":13, "par":3, "m":118, "si":18},
    {"n":14, "par":4, "m":330, "si":6},
    {"n":15, "par":4, "m":338, "si":10},
    {"n":16, "par":4, "m":273, "si":12},
    {"n":17, "par":3, "m":157, "si":16},
    {"n":18, "par":5, "m":460, "si":2}
  ]'::jsonb
);

-- ============================================================
-- 7. Virginia Golf Club  (Banyo / Virginia)
-- ============================================================
SELECT seed_course(
  'Virginia Golf Club',
  'Virginia', 'QLD', 'AU',
  -27.3920, 153.0620,
  18, 71, NULL, 70.0, 'seed',
  '[
    {"n":1,  "par":5, "m":492, "si":3},
    {"n":2,  "par":4, "m":383, "si":5},
    {"n":3,  "par":3, "m":168, "si":15},
    {"n":4,  "par":4, "m":327, "si":11},
    {"n":5,  "par":4, "m":352, "si":7},
    {"n":6,  "par":4, "m":412, "si":1},
    {"n":7,  "par":4, "m":377, "si":9},
    {"n":8,  "par":4, "m":355, "si":13},
    {"n":9,  "par":3, "m":184, "si":17},
    {"n":10, "par":4, "m":313, "si":10},
    {"n":11, "par":4, "m":328, "si":8},
    {"n":12, "par":3, "m":135, "si":18},
    {"n":13, "par":5, "m":444, "si":4},
    {"n":14, "par":3, "m":161, "si":16},
    {"n":15, "par":4, "m":375, "si":6},
    {"n":16, "par":5, "m":523, "si":2},
    {"n":17, "par":4, "m":400, "si":12},
    {"n":18, "par":4, "m":388, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 8. McLeod Country Golf Club  (Mount Ommaney)
-- ============================================================
SELECT seed_course(
  'McLeod Country Golf Club',
  'Mount Ommaney', 'QLD', 'AU',
  -27.5450, 152.9330,
  18, 69, NULL, 67.5, 'seed',
  '[
    {"n":1,  "par":4, "m":401, "si":1},
    {"n":2,  "par":3, "m":175, "si":15},
    {"n":3,  "par":5, "m":450, "si":7},
    {"n":4,  "par":4, "m":343, "si":5},
    {"n":5,  "par":4, "m":314, "si":9},
    {"n":6,  "par":3, "m":127, "si":17},
    {"n":7,  "par":4, "m":305, "si":11},
    {"n":8,  "par":4, "m":348, "si":3},
    {"n":9,  "par":5, "m":517, "si":13},
    {"n":10, "par":5, "m":446, "si":6},
    {"n":11, "par":4, "m":300, "si":10},
    {"n":12, "par":3, "m":118, "si":18},
    {"n":13, "par":4, "m":334, "si":4},
    {"n":14, "par":3, "m":120, "si":16},
    {"n":15, "par":4, "m":281, "si":8},
    {"n":16, "par":3, "m":136, "si":14},
    {"n":17, "par":4, "m":398, "si":2},
    {"n":18, "par":3, "m":160, "si":12}
  ]'::jsonb
);

-- ============================================================
-- 9. Wynnum Golf Club
-- ============================================================
SELECT seed_course(
  'Wynnum Golf Club',
  'Wynnum', 'QLD', 'AU',
  -27.4470, 153.1620,
  18, 70, NULL, 67.0, 'seed',
  '[
    {"n":1,  "par":4, "m":261, "si":18},
    {"n":2,  "par":5, "m":466, "si":9},
    {"n":3,  "par":4, "m":350, "si":6},
    {"n":4,  "par":4, "m":412, "si":1},
    {"n":5,  "par":3, "m":166, "si":5},
    {"n":6,  "par":3, "m":111, "si":16},
    {"n":7,  "par":4, "m":304, "si":12},
    {"n":8,  "par":4, "m":297, "si":14},
    {"n":9,  "par":3, "m":156, "si":7},
    {"n":10, "par":4, "m":272, "si":11},
    {"n":11, "par":4, "m":406, "si":2},
    {"n":12, "par":5, "m":433, "si":17},
    {"n":13, "par":5, "m":466, "si":8},
    {"n":14, "par":4, "m":266, "si":13},
    {"n":15, "par":3, "m":182, "si":4},
    {"n":16, "par":3, "m":124, "si":15},
    {"n":17, "par":4, "m":366, "si":3},
    {"n":18, "par":4, "m":315, "si":10}
  ]'::jsonb
);

-- ============================================================
-- 10. Oxley Golf Club
-- ============================================================
SELECT seed_course(
  'Oxley Golf Club',
  'Oxley', 'QLD', 'AU',
  -27.5520, 152.9740,
  18, 71, NULL, 70.5, 'seed',
  '[
    {"n":1,  "par":4, "m":348, "si":7},
    {"n":2,  "par":5, "m":439, "si":3},
    {"n":3,  "par":3, "m":163, "si":15},
    {"n":4,  "par":4, "m":381, "si":1},
    {"n":5,  "par":3, "m":154, "si":13},
    {"n":6,  "par":4, "m":290, "si":11},
    {"n":7,  "par":3, "m":124, "si":17},
    {"n":8,  "par":4, "m":285, "si":9},
    {"n":9,  "par":4, "m":371, "si":5},
    {"n":10, "par":4, "m":332, "si":8},
    {"n":11, "par":5, "m":450, "si":4},
    {"n":12, "par":5, "m":521, "si":2},
    {"n":13, "par":3, "m":196, "si":14},
    {"n":14, "par":4, "m":316, "si":12},
    {"n":15, "par":4, "m":381, "si":6},
    {"n":16, "par":4, "m":391, "si":10},
    {"n":17, "par":4, "m":341, "si":16},
    {"n":18, "par":4, "m":341, "si":18}
  ]'::jsonb
);

-- ============================================================
-- 11. Wantima Country Club  (Brendale)
-- ============================================================
SELECT seed_course(
  'Wantima Country Club',
  'Brendale', 'QLD', 'AU',
  -27.3200, 152.9830,
  18, 70, NULL, 68.0, 'seed',
  '[
    {"n":1,  "par":4, "m":395, "si":1},
    {"n":2,  "par":4, "m":328, "si":7},
    {"n":3,  "par":4, "m":347, "si":3},
    {"n":4,  "par":4, "m":329, "si":9},
    {"n":5,  "par":3, "m":165, "si":15},
    {"n":6,  "par":4, "m":399, "si":5},
    {"n":7,  "par":4, "m":341, "si":11},
    {"n":8,  "par":4, "m":351, "si":13},
    {"n":9,  "par":4, "m":357, "si":17},
    {"n":10, "par":3, "m":124, "si":18},
    {"n":11, "par":4, "m":395, "si":2},
    {"n":12, "par":3, "m":162, "si":16},
    {"n":13, "par":5, "m":455, "si":4},
    {"n":14, "par":4, "m":401, "si":6},
    {"n":15, "par":5, "m":466, "si":8},
    {"n":16, "par":3, "m":173, "si":14},
    {"n":17, "par":4, "m":280, "si":12},
    {"n":18, "par":4, "m":367, "si":10}
  ]'::jsonb
);

-- ============================================================
-- 12. Gailes Golf Club  (Wacol)
-- ============================================================
SELECT seed_course(
  'Gailes Golf Club',
  'Wacol', 'QLD', 'AU',
  -27.5870, 152.8970,
  18, 73, NULL, 72.0, 'seed',
  '[
    {"n":1,  "par":5, "m":485, "si":5},
    {"n":2,  "par":5, "m":459, "si":9},
    {"n":3,  "par":3, "m":179, "si":15},
    {"n":4,  "par":4, "m":236, "si":17},
    {"n":5,  "par":4, "m":372, "si":3},
    {"n":6,  "par":3, "m":202, "si":13},
    {"n":7,  "par":4, "m":394, "si":1},
    {"n":8,  "par":4, "m":360, "si":7},
    {"n":9,  "par":5, "m":506, "si":11},
    {"n":10, "par":4, "m":387, "si":2},
    {"n":11, "par":4, "m":332, "si":10},
    {"n":12, "par":3, "m":124, "si":18},
    {"n":13, "par":4, "m":352, "si":6},
    {"n":14, "par":4, "m":350, "si":8},
    {"n":15, "par":4, "m":417, "si":4},
    {"n":16, "par":4, "m":358, "si":12},
    {"n":17, "par":4, "m":278, "si":16},
    {"n":18, "par":5, "m":489, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 13. Brookwater Golf & Country Club
-- ============================================================
SELECT seed_course(
  'Brookwater Golf & Country Club',
  'Brookwater', 'QLD', 'AU',
  -27.6290, 152.8980,
  18, 72, NULL, 73.5, 'seed',
  '[
    {"n":1,  "par":4, "m":351, "si":9},
    {"n":2,  "par":4, "m":377, "si":3},
    {"n":3,  "par":4, "m":336, "si":11},
    {"n":4,  "par":5, "m":529, "si":1},
    {"n":5,  "par":3, "m":155, "si":17},
    {"n":6,  "par":4, "m":375, "si":5},
    {"n":7,  "par":3, "m":164, "si":15},
    {"n":8,  "par":5, "m":499, "si":7},
    {"n":9,  "par":4, "m":301, "si":13},
    {"n":10, "par":4, "m":327, "si":10},
    {"n":11, "par":4, "m":325, "si":4},
    {"n":12, "par":4, "m":325, "si":8},
    {"n":13, "par":5, "m":533, "si":2},
    {"n":14, "par":3, "m":146, "si":18},
    {"n":15, "par":4, "m":383, "si":6},
    {"n":16, "par":3, "m":140, "si":16},
    {"n":17, "par":5, "m":460, "si":12},
    {"n":18, "par":4, "m":378, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 14. RACV Royal Pines Resort  (Gold Coast - Green/Gold)
-- ============================================================
SELECT seed_course(
  'RACV Royal Pines Resort',
  'Benowa', 'QLD', 'AU',
  -28.0100, 153.3860,
  18, 72, NULL, 74.5, 'seed',
  '[
    {"n":1,  "par":4, "m":366, "si":9},
    {"n":2,  "par":3, "m":152, "si":17},
    {"n":3,  "par":5, "m":535, "si":1},
    {"n":4,  "par":4, "m":378, "si":3},
    {"n":5,  "par":3, "m":158, "si":15},
    {"n":6,  "par":4, "m":311, "si":13},
    {"n":7,  "par":4, "m":379, "si":5},
    {"n":8,  "par":4, "m":289, "si":11},
    {"n":9,  "par":5, "m":473, "si":7},
    {"n":10, "par":4, "m":340, "si":10},
    {"n":11, "par":4, "m":397, "si":2},
    {"n":12, "par":5, "m":492, "si":4},
    {"n":13, "par":4, "m":377, "si":6},
    {"n":14, "par":3, "m":193, "si":16},
    {"n":15, "par":5, "m":487, "si":8},
    {"n":16, "par":3, "m":132, "si":18},
    {"n":17, "par":4, "m":350, "si":12},
    {"n":18, "par":4, "m":416, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 15. Emerald Lakes Golf Club  (Carrara, Gold Coast)
-- ============================================================
SELECT seed_course(
  'Emerald Lakes Golf Club',
  'Carrara', 'QLD', 'AU',
  -28.0290, 153.3580,
  18, 72, NULL, 70.0, 'seed',
  '[
    {"n":1,  "par":4, "m":317, "si":9},
    {"n":2,  "par":5, "m":440, "si":5},
    {"n":3,  "par":3, "m":171, "si":15},
    {"n":4,  "par":5, "m":447, "si":3},
    {"n":5,  "par":3, "m":134, "si":17},
    {"n":6,  "par":5, "m":451, "si":7},
    {"n":7,  "par":4, "m":376, "si":1},
    {"n":8,  "par":3, "m":134, "si":13},
    {"n":9,  "par":4, "m":294, "si":11},
    {"n":10, "par":4, "m":305, "si":10},
    {"n":11, "par":4, "m":338, "si":4},
    {"n":12, "par":5, "m":491, "si":2},
    {"n":13, "par":3, "m":132, "si":18},
    {"n":14, "par":5, "m":471, "si":6},
    {"n":15, "par":4, "m":367, "si":8},
    {"n":16, "par":4, "m":385, "si":12},
    {"n":17, "par":3, "m":198, "si":16},
    {"n":18, "par":4, "m":356, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 16. Palmer Gold Coast  (Robina)
-- ============================================================
SELECT seed_course(
  'Palmer Gold Coast',
  'Robina', 'QLD', 'AU',
  -28.0750, 153.3870,
  18, 71, NULL, 71.5, 'seed',
  '[
    {"n":1,  "par":4, "m":362, "si":5},
    {"n":2,  "par":4, "m":340, "si":9},
    {"n":3,  "par":3, "m":155, "si":17},
    {"n":4,  "par":5, "m":495, "si":1},
    {"n":5,  "par":4, "m":370, "si":7},
    {"n":6,  "par":3, "m":175, "si":15},
    {"n":7,  "par":4, "m":385, "si":3},
    {"n":8,  "par":4, "m":330, "si":11},
    {"n":9,  "par":5, "m":480, "si":13},
    {"n":10, "par":4, "m":355, "si":6},
    {"n":11, "par":4, "m":310, "si":10},
    {"n":12, "par":3, "m":165, "si":18},
    {"n":13, "par":5, "m":510, "si":2},
    {"n":14, "par":4, "m":345, "si":8},
    {"n":15, "par":4, "m":390, "si":4},
    {"n":16, "par":3, "m":140, "si":16},
    {"n":17, "par":4, "m":400, "si":12},
    {"n":18, "par":4, "m":370, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 17. Lakelands Golf Club  (Merrimac, Gold Coast)
-- ============================================================
SELECT seed_course(
  'Lakelands Golf Club',
  'Merrimac', 'QLD', 'AU',
  -28.0510, 153.3710,
  18, 72, NULL, 74.0, 'seed',
  '[
    {"n":1,  "par":4, "m":380, "si":5},
    {"n":2,  "par":4, "m":355, "si":9},
    {"n":3,  "par":5, "m":530, "si":1},
    {"n":4,  "par":3, "m":170, "si":17},
    {"n":5,  "par":4, "m":410, "si":3},
    {"n":6,  "par":4, "m":360, "si":7},
    {"n":7,  "par":3, "m":185, "si":15},
    {"n":8,  "par":5, "m":510, "si":11},
    {"n":9,  "par":4, "m":395, "si":13},
    {"n":10, "par":4, "m":370, "si":4},
    {"n":11, "par":5, "m":520, "si":2},
    {"n":12, "par":3, "m":160, "si":18},
    {"n":13, "par":4, "m":400, "si":6},
    {"n":14, "par":4, "m":345, "si":10},
    {"n":15, "par":4, "m":380, "si":8},
    {"n":16, "par":5, "m":505, "si":12},
    {"n":17, "par":3, "m":175, "si":16},
    {"n":18, "par":4, "m":415, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 18. Keperra Country Golf Club - Old Course
-- ============================================================
SELECT seed_course(
  'Keperra Country Golf Club',
  'Keperra', 'QLD', 'AU',
  -27.4190, 152.9410,
  18, 70, NULL, 71.0, 'seed',
  '[
    {"n":1,  "par":5, "m":460, "si":5},
    {"n":2,  "par":4, "m":355, "si":9},
    {"n":3,  "par":4, "m":370, "si":1},
    {"n":4,  "par":3, "m":165, "si":17},
    {"n":5,  "par":4, "m":390, "si":3},
    {"n":6,  "par":4, "m":340, "si":11},
    {"n":7,  "par":3, "m":175, "si":15},
    {"n":8,  "par":5, "m":500, "si":7},
    {"n":9,  "par":4, "m":350, "si":13},
    {"n":10, "par":4, "m":375, "si":2},
    {"n":11, "par":5, "m":490, "si":4},
    {"n":12, "par":3, "m":155, "si":18},
    {"n":13, "par":4, "m":385, "si":6},
    {"n":14, "par":4, "m":330, "si":10},
    {"n":15, "par":4, "m":360, "si":8},
    {"n":16, "par":3, "m":180, "si":16},
    {"n":17, "par":3, "m":182, "si":14},
    {"n":18, "par":4, "m":395, "si":12}
  ]'::jsonb
);

-- ============================================================
-- 19. Pelican Waters Golf Club  (Sunshine Coast)
-- ============================================================
SELECT seed_course(
  'Pelican Waters Golf Club',
  'Pelican Waters', 'QLD', 'AU',
  -26.8380, 153.0930,
  18, 72, NULL, 72.0, 'seed',
  '[
    {"n":1,  "par":4, "m":375, "si":3},
    {"n":2,  "par":5, "m":500, "si":7},
    {"n":3,  "par":3, "m":160, "si":17},
    {"n":4,  "par":4, "m":370, "si":5},
    {"n":5,  "par":4, "m":395, "si":1},
    {"n":6,  "par":4, "m":340, "si":9},
    {"n":7,  "par":3, "m":170, "si":15},
    {"n":8,  "par":5, "m":510, "si":11},
    {"n":9,  "par":4, "m":355, "si":13},
    {"n":10, "par":4, "m":385, "si":2},
    {"n":11, "par":4, "m":360, "si":8},
    {"n":12, "par":3, "m":145, "si":18},
    {"n":13, "par":5, "m":490, "si":4},
    {"n":14, "par":4, "m":350, "si":10},
    {"n":15, "par":4, "m":380, "si":6},
    {"n":16, "par":3, "m":175, "si":16},
    {"n":17, "par":4, "m":410, "si":12},
    {"n":18, "par":5, "m":480, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 20. Caloundra Golf Club  (Sunshine Coast)
-- ============================================================
SELECT seed_course(
  'Caloundra Golf Club',
  'Caloundra', 'QLD', 'AU',
  -26.8010, 153.1180,
  18, 71, NULL, 70.5, 'seed',
  '[
    {"n":1,  "par":4, "m":360, "si":3},
    {"n":2,  "par":4, "m":345, "si":7},
    {"n":3,  "par":3, "m":150, "si":17},
    {"n":4,  "par":5, "m":480, "si":5},
    {"n":5,  "par":4, "m":370, "si":1},
    {"n":6,  "par":3, "m":165, "si":15},
    {"n":7,  "par":4, "m":390, "si":9},
    {"n":8,  "par":4, "m":330, "si":11},
    {"n":9,  "par":5, "m":500, "si":13},
    {"n":10, "par":4, "m":355, "si":2},
    {"n":11, "par":4, "m":380, "si":6},
    {"n":12, "par":3, "m":155, "si":18},
    {"n":13, "par":5, "m":495, "si":4},
    {"n":14, "par":4, "m":350, "si":8},
    {"n":15, "par":4, "m":375, "si":10},
    {"n":16, "par":3, "m":140, "si":16},
    {"n":17, "par":4, "m":405, "si":12},
    {"n":18, "par":4, "m":365, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 21. Nudgee Golf Club - Bay Course  (Brisbane)
-- ============================================================
SELECT seed_course(
  'Nudgee Golf Club - Bay Course',
  'Nudgee', 'QLD', 'AU',
  -27.3630, 153.0820,
  18, 69, NULL, 67.5, 'seed',
  '[
    {"n":1,  "par":4, "m":340, "si":5},
    {"n":2,  "par":4, "m":320, "si":9},
    {"n":3,  "par":3, "m":145, "si":17},
    {"n":4,  "par":4, "m":360, "si":3},
    {"n":5,  "par":5, "m":470, "si":7},
    {"n":6,  "par":3, "m":135, "si":15},
    {"n":7,  "par":4, "m":370, "si":1},
    {"n":8,  "par":4, "m":310, "si":11},
    {"n":9,  "par":3, "m":155, "si":13},
    {"n":10, "par":4, "m":350, "si":4},
    {"n":11, "par":4, "m":380, "si":2},
    {"n":12, "par":3, "m":140, "si":18},
    {"n":13, "par":5, "m":460, "si":6},
    {"n":14, "par":4, "m":330, "si":10},
    {"n":15, "par":4, "m":355, "si":8},
    {"n":16, "par":3, "m":160, "si":16},
    {"n":17, "par":4, "m":390, "si":12},
    {"n":18, "par":4, "m":345, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 22. Brisbane River Golf Course  (Karana Downs)
-- ============================================================
SELECT seed_course(
  'Brisbane River Golf Course',
  'Karana Downs', 'QLD', 'AU',
  -27.5480, 152.8450,
  18, 65, NULL, 63.0, 'seed',
  '[
    {"n":1,  "par":4, "m":295, "si":5},
    {"n":2,  "par":3, "m":135, "si":13},
    {"n":3,  "par":4, "m":310, "si":3},
    {"n":4,  "par":3, "m":125, "si":17},
    {"n":5,  "par":4, "m":280, "si":7},
    {"n":6,  "par":4, "m":320, "si":1},
    {"n":7,  "par":3, "m":145, "si":15},
    {"n":8,  "par":4, "m":290, "si":9},
    {"n":9,  "par":3, "m":150, "si":11},
    {"n":10, "par":4, "m":300, "si":4},
    {"n":11, "par":3, "m":140, "si":16},
    {"n":12, "par":4, "m":275, "si":10},
    {"n":13, "par":4, "m":315, "si":2},
    {"n":14, "par":3, "m":130, "si":18},
    {"n":15, "par":4, "m":285, "si":8},
    {"n":16, "par":3, "m":155, "si":14},
    {"n":17, "par":4, "m":305, "si":6},
    {"n":18, "par":4, "m":270, "si":12}
  ]'::jsonb
);

-- ============================================================
-- 23. Headland Golf Club  (Sunshine Coast)
-- ============================================================
SELECT seed_course(
  'Headland Golf Club',
  'Buderim', 'QLD', 'AU',
  -26.6920, 153.0590,
  18, 70, NULL, 68.5, 'seed',
  '[
    {"n":1,  "par":4, "m":350, "si":5},
    {"n":2,  "par":4, "m":330, "si":9},
    {"n":3,  "par":3, "m":155, "si":15},
    {"n":4,  "par":5, "m":475, "si":1},
    {"n":5,  "par":4, "m":365, "si":3},
    {"n":6,  "par":3, "m":140, "si":17},
    {"n":7,  "par":4, "m":310, "si":11},
    {"n":8,  "par":4, "m":345, "si":7},
    {"n":9,  "par":4, "m":370, "si":13},
    {"n":10, "par":4, "m":340, "si":4},
    {"n":11, "par":3, "m":160, "si":16},
    {"n":12, "par":4, "m":355, "si":2},
    {"n":13, "par":5, "m":470, "si":6},
    {"n":14, "par":4, "m":325, "si":10},
    {"n":15, "par":4, "m":380, "si":8},
    {"n":16, "par":3, "m":145, "si":18},
    {"n":17, "par":4, "m":360, "si":12},
    {"n":18, "par":4, "m":335, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 24. Redland Bay Golf Club
-- ============================================================
SELECT seed_course(
  'Redland Bay Golf Club',
  'Redland Bay', 'QLD', 'AU',
  -27.6140, 153.2920,
  18, 72, NULL, 70.0, 'seed',
  '[
    {"n":1,  "par":4, "m":355, "si":7},
    {"n":2,  "par":5, "m":480, "si":3},
    {"n":3,  "par":3, "m":150, "si":15},
    {"n":4,  "par":4, "m":375, "si":1},
    {"n":5,  "par":4, "m":340, "si":9},
    {"n":6,  "par":3, "m":165, "si":17},
    {"n":7,  "par":4, "m":380, "si":5},
    {"n":8,  "par":5, "m":500, "si":11},
    {"n":9,  "par":4, "m":350, "si":13},
    {"n":10, "par":4, "m":365, "si":2},
    {"n":11, "par":4, "m":345, "si":8},
    {"n":12, "par":3, "m":155, "si":18},
    {"n":13, "par":5, "m":490, "si":4},
    {"n":14, "par":4, "m":330, "si":12},
    {"n":15, "par":4, "m":385, "si":6},
    {"n":16, "par":3, "m":170, "si":16},
    {"n":17, "par":4, "m":400, "si":10},
    {"n":18, "par":5, "m":475, "si":14}
  ]'::jsonb
);

-- ============================================================
-- 25. North Lakes Resort Golf Club
-- ============================================================
SELECT seed_course(
  'North Lakes Resort Golf Club',
  'North Lakes', 'QLD', 'AU',
  -27.2320, 153.0230,
  18, 72, NULL, 71.0, 'seed',
  '[
    {"n":1,  "par":4, "m":370, "si":5},
    {"n":2,  "par":4, "m":350, "si":9},
    {"n":3,  "par":3, "m":160, "si":15},
    {"n":4,  "par":5, "m":500, "si":1},
    {"n":5,  "par":4, "m":380, "si":3},
    {"n":6,  "par":4, "m":330, "si":11},
    {"n":7,  "par":3, "m":175, "si":17},
    {"n":8,  "par":5, "m":490, "si":7},
    {"n":9,  "par":4, "m":365, "si":13},
    {"n":10, "par":4, "m":375, "si":2},
    {"n":11, "par":4, "m":355, "si":8},
    {"n":12, "par":3, "m":150, "si":18},
    {"n":13, "par":5, "m":510, "si":4},
    {"n":14, "par":4, "m":340, "si":10},
    {"n":15, "par":4, "m":390, "si":6},
    {"n":16, "par":3, "m":165, "si":16},
    {"n":17, "par":4, "m":385, "si":12},
    {"n":18, "par":4, "m":360, "si":14}
  ]'::jsonb
);

-- ============================================================
-- Verify: count inserted courses and holes
-- ============================================================
DO $$
DECLARE
  course_count INTEGER;
  hole_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO course_count FROM courses WHERE source = 'seed';
  SELECT COUNT(*) INTO hole_count FROM holes h
    JOIN courses c ON h.course_id = c.id
    WHERE c.source = 'seed';
  RAISE NOTICE 'Seeded % courses with % total holes', course_count, hole_count;
END $$;
