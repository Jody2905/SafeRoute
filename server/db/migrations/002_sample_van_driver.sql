-- Adds a sample van driver to databases that already have the sample accounts (same demo password).
-- On a brand-new database this does nothing and db/seed.js adds the driver instead.
INSERT INTO users (email, password_hash, name, phone, role)
SELECT 'driver3@example.com', password_hash, 'Devon Hackshaw', '+1 784 555 0166', 'driver'
  FROM users WHERE email = 'driver@example.com'
ON CONFLICT (email) DO NOTHING;

INSERT INTO drivers (user_id, vehicle, plate, verified, rating, vehicle_type, seats)
SELECT id, 'Blue Toyota Hiace', 'H 2210', true, 4.7, 'van', 14 FROM users WHERE email = 'driver3@example.com'
ON CONFLICT (user_id) DO NOTHING;
