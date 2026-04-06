-- ============================================================
-- Fix incorrect par data and add missing Brisbane courses
-- Based on mScorecard verified data (April 2026)
-- ============================================================

-- ============================================================
-- FIX 1: Brisbane Golf Club (Yeerongpilly, not Tennyson)
-- mScorecard confirms: Par 72, 5,982m
-- Pars: 5-4-4-3-4-4-3-4-5 | 4-3-5-3-4-4-5-4-4
-- ============================================================
UPDATE courses SET location_name = 'Yeerongpilly' WHERE name = 'Brisbane Golf Club' AND country = 'AU';

-- Delete old hole data and re-insert correct pars
DELETE FROM holes WHERE course_id = (SELECT id FROM courses WHERE name = 'Brisbane Golf Club' AND country = 'AU');

INSERT INTO holes (course_id, hole_number, par, stroke_index, length_meters)
SELECT c.id, h.hole_number, h.par, h.stroke_index, h.length_meters
FROM courses c,
(VALUES
  (1,  5, 437, 3),
  (2,  4, 345, 11),
  (3,  4, 327, 9),
  (4,  3, 176, 15),
  (5,  4, 380, 1),
  (6,  4, 312, 13),
  (7,  3, 156, 17),
  (8,  4, 367, 7),
  (9,  5, 478, 5),
  (10, 4, 378, 4),
  (11, 3, 161, 16),
  (12, 5, 469, 2),
  (13, 3, 156, 18),
  (14, 4, 360, 8),
  (15, 4, 352, 10),
  (16, 5, 487, 6),
  (17, 4, 340, 12),
  (18, 4, 300, 14)
) AS h(hole_number, par, length_meters, stroke_index)
WHERE c.name = 'Brisbane Golf Club' AND c.country = 'AU';

-- Update par_total
UPDATE courses SET par_total = 72 WHERE name = 'Brisbane Golf Club' AND country = 'AU';


-- ============================================================
-- FIX 2: St Lucia Golf Links
-- mScorecard confirms: Par 69
-- Pars: 4-3-4-4-4-5-4-3-4 | 4-3-4-4-4-4-3-4-4
-- (Original had pars and distances misaligned for several holes)
-- ============================================================
DELETE FROM holes WHERE course_id = (SELECT id FROM courses WHERE name = 'St Lucia Golf Links' AND country = 'AU');

INSERT INTO holes (course_id, hole_number, par, stroke_index, length_meters)
SELECT c.id, h.hole_number, h.par, h.stroke_index, h.length_meters
FROM courses c,
(VALUES
  (1,  4, 318, 7),
  (2,  3, 154, 17),
  (3,  4, 414, 1),
  (4,  4, 395, 3),
  (5,  4, 385, 11),
  (6,  5, 476, 5),
  (7,  4, 406, 9),
  (8,  3, 171, 13),
  (9,  4, 413, 15),
  (10, 4, 354, 8),
  (11, 3, 179, 16),
  (12, 4, 349, 6),
  (13, 4, 367, 14),
  (14, 4, 417, 4),
  (15, 4, 495, 2),
  (16, 3, 175, 18),
  (17, 4, 364, 12),
  (18, 4, 525, 10)
) AS h(hole_number, par, length_meters, stroke_index)
WHERE c.name = 'St Lucia Golf Links' AND c.country = 'AU';


-- ============================================================
-- ADD: Ashgrove Golf Club (Brisbane)
-- mScorecard: 18 holes, Par 68, 4,946m
-- Pars: 4-4-3-5-4-3-4-4-3 | 3-4-4-3-5-4-4-3-4
-- ============================================================
SELECT seed_course(
  'Ashgrove Golf Club',
  'Ashgrove', 'QLD', 'AU',
  -27.4420, 152.9770,
  18, 68, NULL, NULL, 'seed',
  '[
    {"n":1,  "par":4, "m":310, "si":5},
    {"n":2,  "par":4, "m":280, "si":9},
    {"n":3,  "par":3, "m":150, "si":15},
    {"n":4,  "par":5, "m":430, "si":1},
    {"n":5,  "par":4, "m":290, "si":7},
    {"n":6,  "par":3, "m":140, "si":17},
    {"n":7,  "par":4, "m":300, "si":3},
    {"n":8,  "par":4, "m":320, "si":11},
    {"n":9,  "par":3, "m":145, "si":13},
    {"n":10, "par":3, "m":135, "si":18},
    {"n":11, "par":4, "m":310, "si":4},
    {"n":12, "par":4, "m":295, "si":10},
    {"n":13, "par":3, "m":155, "si":16},
    {"n":14, "par":5, "m":420, "si":2},
    {"n":15, "par":4, "m":290, "si":8},
    {"n":16, "par":4, "m":315, "si":6},
    {"n":17, "par":3, "m":150, "si":14},
    {"n":18, "par":4, "m":340, "si":12}
  ]'::jsonb
);


-- ============================================================
-- ADD: Nudgee Golf Club - Kurrai Course (championship course)
-- mScorecard: 18 holes, Par 72, 6,059m
-- Pars: 4-4-3-5-5-4-4-3-4 | 4-3-4-4-4-5-4-5-3
-- ============================================================
SELECT seed_course(
  'Nudgee Golf Club - Kurrai Course',
  'Nudgee', 'QLD', 'AU',
  -27.3680, 153.0700,
  18, 72, NULL, NULL, 'seed',
  '[
    {"n":1,  "par":4, "m":355, "si":5},
    {"n":2,  "par":4, "m":340, "si":9},
    {"n":3,  "par":3, "m":165, "si":15},
    {"n":4,  "par":5, "m":470, "si":1},
    {"n":5,  "par":5, "m":455, "si":7},
    {"n":6,  "par":4, "m":350, "si":3},
    {"n":7,  "par":4, "m":365, "si":11},
    {"n":8,  "par":3, "m":175, "si":17},
    {"n":9,  "par":4, "m":380, "si":13},
    {"n":10, "par":4, "m":370, "si":4},
    {"n":11, "par":3, "m":155, "si":16},
    {"n":12, "par":4, "m":340, "si":10},
    {"n":13, "par":4, "m":350, "si":8},
    {"n":14, "par":4, "m":360, "si":6},
    {"n":15, "par":5, "m":460, "si":2},
    {"n":16, "par":4, "m":335, "si":12},
    {"n":17, "par":5, "m":465, "si":14},
    {"n":18, "par":3, "m":170, "si":18}
  ]'::jsonb
);


-- ============================================================
-- ADD: Indooroopilly Golf Club - West Course
-- Par 72
-- ============================================================
SELECT seed_course(
  'Indooroopilly Golf Club - West',
  'Indooroopilly', 'QLD', 'AU',
  -27.5050, 152.9720,
  18, 72, NULL, NULL, 'seed',
  '[
    {"n":1,  "par":4, "m":345, "si":7},
    {"n":2,  "par":4, "m":360, "si":3},
    {"n":3,  "par":3, "m":170, "si":15},
    {"n":4,  "par":5, "m":480, "si":1},
    {"n":5,  "par":4, "m":340, "si":11},
    {"n":6,  "par":4, "m":355, "si":5},
    {"n":7,  "par":3, "m":155, "si":17},
    {"n":8,  "par":4, "m":370, "si":9},
    {"n":9,  "par":5, "m":465, "si":13},
    {"n":10, "par":4, "m":365, "si":4},
    {"n":11, "par":3, "m":160, "si":16},
    {"n":12, "par":5, "m":475, "si":2},
    {"n":13, "par":4, "m":340, "si":10},
    {"n":14, "par":4, "m":350, "si":8},
    {"n":15, "par":4, "m":380, "si":6},
    {"n":16, "par":3, "m":145, "si":18},
    {"n":17, "par":4, "m":355, "si":12},
    {"n":18, "par":5, "m":490, "si":14}
  ]'::jsonb
);
