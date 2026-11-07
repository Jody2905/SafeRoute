-- Getting off early: the passenger pays for the trip they booked, with 10% or 15% off in some cases.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS booked_route     JSONB;    -- the route before the drop-off was moved closer
ALTER TABLE trips ADD COLUMN IF NOT EXISTS booked_route_m   INTEGER;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS booked_dest_name TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS discount_pct     SMALLINT NOT NULL DEFAULT 0;
