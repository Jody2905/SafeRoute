-- SafeRoute database schema (PostgreSQL / Neon).
-- Later changes live in db/migrations/ and are applied on top by db/migrate.js.
-- WARNING: this file drops and recreates every table. db/setup.js only runs it on an empty database;
-- db/reset.js runs it on purpose to start over.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DROP TABLE IF EXISTS schema_migrations, audit_log, alerts, trip_points, trips, trusted_contacts, drivers, users CASCADE;
DROP TYPE IF EXISTS user_role, trip_status, alert_kind, alert_status, vehicle_type CASCADE;

CREATE TYPE user_role    AS ENUM ('passenger', 'driver', 'admin');
CREATE TYPE trip_status  AS ENUM ('requested', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled');
CREATE TYPE alert_kind   AS ENUM ('off_route', 'long_stop', 'sos');
CREATE TYPE alert_status AS ENUM ('open', 'ok', 'escalated');

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT,
  role           user_role NOT NULL DEFAULT 'passenger',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extra details for drivers. A driver can't accept rides until verified.
CREATE TABLE drivers (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle        TEXT NOT NULL,          -- e.g. "Silver Toyota Corolla"
  plate          TEXT NOT NULL,          -- e.g. "H 4421" (hired-vehicle plate)
  verified       BOOLEAN NOT NULL DEFAULT false,
  rating         NUMERIC(2,1) NOT NULL DEFAULT 5.0
);

CREATE TABLE trusted_contacts (
  id             SERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  relation       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trips (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  status           trip_status NOT NULL DEFAULT 'requested',
  pickup_lat       DOUBLE PRECISION,
  pickup_lng       DOUBLE PRECISION,
  pickup_name      TEXT NOT NULL,
  dest_lat         DOUBLE PRECISION NOT NULL,
  dest_lng         DOUBLE PRECISION NOT NULL,
  dest_name        TEXT NOT NULL,
  route            JSONB NOT NULL DEFAULT '[]',   -- [[lat, lng], ...] planned road route
  route_m          INTEGER NOT NULL DEFAULT 0,
  fare_xcd         NUMERIC(6,2) NOT NULL,
  -- The ride PIN is shown to the passenger and cleared as soon as the driver enters it.
  pin              CHAR(4),
  pin_attempts     SMALLINT NOT NULL DEFAULT 0,
  -- Share links: only a hash of the token is stored, so a database leak can't reveal live links.
  share_token_hash TEXT UNIQUE,
  -- Latest driver position (the full trail is in trip_points).
  last_lat         DOUBLE PRECISION,
  last_lng         DOUBLE PRECISION,
  last_speed_kmh   REAL,
  last_at          TIMESTAMPTZ,
  -- Route-alert bookkeeping.
  off_route_since  TIMESTAMPTZ,
  stopped_since    TIMESTAMPTZ,
  stopped_lat      DOUBLE PRECISION,
  stopped_lng      DOUBLE PRECISION,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at      TIMESTAMPTZ,
  arrived_at       TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  location_purged  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX trips_open ON trips (requested_at) WHERE status = 'requested';
CREATE INDEX trips_passenger ON trips (passenger_id, requested_at DESC);
CREATE INDEX trips_driver ON trips (driver_id, requested_at DESC);
-- One active trip per passenger and per driver.
CREATE UNIQUE INDEX one_active_trip_passenger ON trips (passenger_id) WHERE status IN ('requested', 'accepted', 'arrived', 'in_progress');
CREATE UNIQUE INDEX one_active_trip_driver ON trips (driver_id) WHERE status IN ('accepted', 'arrived', 'in_progress');

-- Driver GPS trail, deleted a set time after the trip ends (LOCATION_RETENTION_HOURS).
CREATE TABLE trip_points (
  id           BIGSERIAL PRIMARY KEY,
  trip_id      UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  speed_kmh    REAL,
  accuracy_m   REAL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trip_points_trip ON trip_points (trip_id, recorded_at);

CREATE TABLE alerts (
  id           SERIAL PRIMARY KEY,
  trip_id      UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind         alert_kind NOT NULL,
  status       alert_status NOT NULL DEFAULT 'open',
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX alerts_open ON alerts (created_at) WHERE status = 'open';

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID,
  action     TEXT NOT NULL,
  target_id  TEXT,
  meta       JSONB NOT NULL DEFAULT '{}',
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
