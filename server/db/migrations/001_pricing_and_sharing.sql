-- Pricing options, extra stops, vehicle seats and shared rides.
-- Safe to run more than once, and safe on a database that already has trips.

DO $$ BEGIN CREATE TYPE vehicle_type AS ENUM ('car', 'suv', 'van'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Drivers: what they drive and how many passengers it seats.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_type vehicle_type NOT NULL DEFAULT 'car';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS seats SMALLINT NOT NULL DEFAULT 4;

-- Bookings.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS party_size     SMALLINT NOT NULL DEFAULT 1;      -- the booker plus anyone travelling with them
ALTER TABLE trips ADD COLUMN IF NOT EXISTS vehicle_type   vehicle_type NOT NULL DEFAULT 'car';
ALTER TABLE trips ADD COLUMN IF NOT EXISTS open_route     BOOLEAN NOT NULL DEFAULT true;     -- false = private ride (+10%)
ALTER TABLE trips ADD COLUMN IF NOT EXISTS stops          JSONB NOT NULL DEFAULT '[]';       -- [{ name, lat, lng }]
ALTER TABLE trips ADD COLUMN IF NOT EXISTS base_xcd       NUMERIC(6,2);                      -- A-to-B fare before options
ALTER TABLE trips ADD COLUMN IF NOT EXISTS shared         BOOLEAN NOT NULL DEFAULT false;    -- rode with another booking
ALTER TABLE trips ADD COLUMN IF NOT EXISTS group_id       UUID;                              -- bookings in the same car
ALTER TABLE trips ADD COLUMN IF NOT EXISTS fare_breakdown JSONB NOT NULL DEFAULT '[]';       -- [{ label, xcd }]
ALTER TABLE trips ADD COLUMN IF NOT EXISTS dest_changes   SMALLINT NOT NULL DEFAULT 0;
UPDATE trips SET base_xcd = fare_xcd WHERE base_xcd IS NULL;

-- A driver can now carry several bookings at once (a shared ride), so the one-trip-per-driver rule goes.
DROP INDEX IF EXISTS one_active_trip_driver;
CREATE INDEX IF NOT EXISTS trips_group ON trips (group_id);
CREATE INDEX IF NOT EXISTS trips_driver_active ON trips (driver_id) WHERE status IN ('accepted', 'arrived', 'in_progress');
