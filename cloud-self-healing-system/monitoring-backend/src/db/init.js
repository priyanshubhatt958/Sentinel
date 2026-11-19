const { client } = require('../config/db');

async function initDatabase() {
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS metrics (
      id SERIAL PRIMARY KEY,
      service_name VARCHAR(100) NOT NULL,
      cpu_usage NUMERIC NOT NULL,
      memory_usage NUMERIC NOT NULL,
      request_rate NUMERIC NOT NULL,
      latency_ms NUMERIC NOT NULL,
      error_rate NUMERIC NOT NULL,
      db_connections NUMERIC NOT NULL,
      status VARCHAR(30) NOT NULL,
      failure_mode VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS monitoring_samples (
      id BIGSERIAL PRIMARY KEY,
      service_name VARCHAR(100) NOT NULL,
      container_id VARCHAR(128),
      container_name VARCHAR(255),
      lifecycle_state VARCHAR(30) NOT NULL,
      health_status VARCHAR(30) NOT NULL,
      uptime_seconds NUMERIC,
      restart_count INTEGER,
      last_error TEXT,
      cpu_percent NUMERIC,
      memory_used_bytes BIGINT,
      memory_limit_bytes BIGINT,
      memory_percent NUMERIC,
      probe_latency_ms NUMERIC,
      probe_status_code INTEGER,
      probe_ok BOOLEAN NOT NULL,
      probe_error TEXT,
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS monitoring_samples_service_time_idx ON monitoring_samples (service_name, collected_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS monitoring_samples_container_time_idx ON monitoring_samples (container_id, collected_at DESC);`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_active BOOLEAN;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_target_service VARCHAR(100);`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_scenario VARCHAR(50);`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_requests_per_second NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_total_requests BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_successful_requests BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_failed_requests BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_current_requests_per_second NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_average_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_max_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_min_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS load_error_rate NUMERIC;`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id SERIAL PRIMARY KEY,
      service_name VARCHAR(100) NOT NULL,
      incident_type VARCHAR(100),
      root_cause VARCHAR(100),
      affected_services TEXT[],
      anomaly_score NUMERIC,
      failure_probability NUMERIC,
      risk_level VARCHAR(20),
      evidence JSONB,
      recommended_action VARCHAR(100),
      action_status VARCHAR(30),
      recovery_status VARCHAR(30),
      genai_summary TEXT,
      detected_by TEXT[],
      contributing_features TEXT[],
      classification_confidence NUMERIC,
      propagation_path TEXT[],
      latest_metrics JSONB,
      anomaly_detected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS detected_by TEXT[];`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS contributing_features TEXT[];`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS classification_confidence NUMERIC;`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS propagation_path TEXT[];`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS latest_metrics JSONB;`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS anomaly_detected_at TIMESTAMPTZ;`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS recovery_actions (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER REFERENCES incidents(id),
      action_type VARCHAR(50) NOT NULL,
      target_service VARCHAR(100) NOT NULL,
      previous_replicas INTEGER,
      new_replicas INTEGER,
      status VARCHAR(30) NOT NULL,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      before_metrics JSONB,
      after_metrics JSONB,
      recovery_status VARCHAR(30),
      effectiveness_score NUMERIC,
      triggered_by VARCHAR(30) NOT NULL DEFAULT 'manual',
      cooldown_until TIMESTAMPTZ
    );
  `);

  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS before_metrics JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS after_metrics JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS recovery_status VARCHAR(30);`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS effectiveness_score NUMERIC;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(30) NOT NULL DEFAULT 'manual';`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;`);
  await client.query(`CREATE INDEX IF NOT EXISTS recovery_actions_incident_created_idx ON recovery_actions (incident_id, created_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS recovery_actions_triggered_created_idx ON recovery_actions (triggered_by, created_at DESC);`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150),
      email VARCHAR(150),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(100),
      customer_name VARCHAR(150),
      amount NUMERIC,
      status VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      payment_id VARCHAR(100),
      amount NUMERIC,
      status VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('Database initialized successfully');
}

module.exports = { initDatabase, client };
