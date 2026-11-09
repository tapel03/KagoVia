-- Reference data. SAMPLE VALUES: labour percentages, plan prices and material list must be confirmed by the
-- product owner and a quantity surveyor before launch (Decision register B-01, B-06). No supplier prices are seeded.

INSERT INTO regions (code, name, labour_bp) VALUES
  ('GP', 'Gauteng',        3500),
  ('WC', 'Western Cape',   3700),
  ('KZN','KwaZulu-Natal',  3300),
  ('EC', 'Eastern Cape',   3100),
  ('FS', 'Free State',     3000),
  ('LP', 'Limpopo',        2900),
  ('MP', 'Mpumalanga',     3000),
  ('NW', 'North West',     3000),
  ('NC', 'Northern Cape',  3100);

INSERT INTO estimation_rules (region_code, version, contingency_bp, vat_bp)
SELECT code, 1, 1000, 1500 FROM regions;   -- 10% contingency, 15% VAT

INSERT INTO material_categories (code, name) VALUES
  ('masonry',    'Masonry'),
  ('concrete',   'Concrete and steel'),
  ('roofing',    'Roofing'),
  ('finishes',   'Floors and ceilings'),
  ('openings',   'Doors and windows'),
  ('services',   'Plumbing and electrical');

-- Codes are what the take-off engine (src/domain/takeoff.js) asks for. Keep them in sync.
INSERT INTO materials (code, name, category, unit, wastage_bp) VALUES
  ('brick_stock',        'Stock brick (222x106x73)',          'masonry',  'each', 500),
  ('cement_50kg',        'Cement 50 kg bag (CEM II 32.5)',   'masonry',  'bag',  500),
  ('sand_building',      'Building sand',                    'masonry',  'm3',   1000),
  ('concrete_25mpa',     'Ready-mix concrete 25 MPa',         'concrete', 'm3',   500),
  ('rebar_y10',          'Reinforcing bar Y10',               'concrete', 'kg',   500),
  ('mesh_ref193',        'Slab mesh Ref 193',                 'concrete', 'm2',   1000),
  ('roof_covering',      'Roof covering (sheets or tiles)',   'roofing',  'm2',   800),
  ('roof_timber',        'Roof timber and trusses',           'roofing',  'm2',   500),
  ('floor_tile',         'Floor tiles',                       'finishes', 'm2',   1000),
  ('ceiling_board',      'Ceiling board',                     'finishes', 'm2',   800),
  ('door_internal',      'Internal door set',                 'openings', 'each', 0),
  ('door_external',      'External door set',                 'openings', 'each', 0),
  ('door_garage',        'Garage door (single, 2.5 m)',       'openings', 'each', 0),
  ('window_std',         'Window (standard size)',            'openings', 'each', 0),
  ('plumbing_point',     'Plumbing point (supply and waste)', 'services', 'each', 0),
  ('electrical_point',   'Electrical point (plug or light)',  'services', 'each', 0);

-- Proposed prices from the PRD (Decision register B-01). Seeded INACTIVE: checkout refuses inactive plans.
INSERT INTO plan_catalog (code, name, price_cents, period_days, monthly_ai_generations, is_active) VALUES
  ('starter',      'Starter',      29900,  30, 20,  false),
  ('professional', 'Professional', 69900,  30, 60,  false),
  ('business',     'Business',     149900, 30, 200, false);
