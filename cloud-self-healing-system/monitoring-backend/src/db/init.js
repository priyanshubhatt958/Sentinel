const { client } = require('../config/db');
const logger = require('../utils/logger');

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
      total_requests BIGINT,
      successful_requests BIGINT,
      failed_requests BIGINT,
      active_requests INTEGER,
      requests_last_minute INTEGER,
      requests_per_second NUMERIC,
      average_latency_ms NUMERIC,
      p95_latency_ms NUMERIC,
      max_latency_ms NUMERIC,
      min_latency_ms NUMERIC,
      service_error_rate NUMERIC,
      db_total_queries BIGINT,
      db_successful_queries BIGINT,
      db_failed_queries BIGINT,
      db_active_connections INTEGER,
      db_idle_connections INTEGER,
      db_waiting_requests INTEGER,
      db_average_query_latency_ms NUMERIC,
      db_max_query_latency_ms NUMERIC,
      db_error_rate NUMERIC,
      probe_latency_ms NUMERIC,
      probe_status_code INTEGER,
      probe_ok BOOLEAN NOT NULL,
      probe_error TEXT,
      collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS monitoring_samples_service_time_idx ON monitoring_samples (service_name, collected_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS monitoring_samples_container_time_idx ON monitoring_samples (container_id, collected_at DESC);`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS total_requests BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS successful_requests BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS failed_requests BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS active_requests INTEGER;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS requests_last_minute INTEGER;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS requests_per_second NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS average_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS p95_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS max_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS min_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS service_error_rate NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_total_queries BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_successful_queries BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_failed_queries BIGINT;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_active_connections INTEGER;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_idle_connections INTEGER;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_waiting_requests INTEGER;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_average_query_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_max_query_latency_ms NUMERIC;`);
  await client.query(`ALTER TABLE monitoring_samples ADD COLUMN IF NOT EXISTS db_error_rate NUMERIC;`);
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
      genai_summary_source VARCHAR(20),
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
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS genai_summary_source VARCHAR(20);`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS genai_report JSONB;`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS recovery_recommendation VARCHAR(64);`);
  await client.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS manual_intervention_required BOOLEAN NOT NULL DEFAULT FALSE;`);

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
      cooldown_until TIMESTAMPTZ,
      cooldown_started_at TIMESTAMPTZ,
      decision_reason TEXT,
      decision_confidence NUMERIC,
      error_details TEXT,
      recommendation VARCHAR(64),
      safety_check JSONB,
      replica_limit INTEGER,
      execution_details JSONB,
      execution_started_at TIMESTAMPTZ,
      execution_completed_at TIMESTAMPTZ,
      verification_started_at TIMESTAMPTZ,
      verification_completed_at TIMESTAMPTZ,
      verification_samples JSONB,
      samples_used INTEGER,
      verification_window_ms INTEGER,
      effectiveness_by_metric JSONB
    );
  `);

  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS before_metrics JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS after_metrics JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS recovery_status VARCHAR(30);`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS effectiveness_score NUMERIC;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(30) NOT NULL DEFAULT 'manual';`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS cooldown_started_at TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS decision_reason TEXT;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS decision_confidence NUMERIC;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS error_details TEXT;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS recommendation VARCHAR(64);`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS safety_check JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS replica_limit INTEGER;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS execution_details JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS execution_completed_at TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS verification_started_at TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS verification_completed_at TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS verification_samples JSONB;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS samples_used INTEGER;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS verification_window_ms INTEGER;`);
  await client.query(`ALTER TABLE recovery_actions ADD COLUMN IF NOT EXISTS effectiveness_by_metric JSONB;`);
  await client.query(`
    UPDATE recovery_actions
       SET status = CASE status
         WHEN 'no_safe_action' THEN 'skipped'
         WHEN 'max_replicas_reached' THEN 'blocked'
         WHEN 'requires_database_remediation' THEN 'manual_intervention_required'
         WHEN 'rate_limited' THEN 'blocked'
         WHEN 'cooldown' THEN 'blocked'
         WHEN 'action_limit_reached' THEN 'blocked'
         WHEN 'pending' THEN 'planned'
         WHEN 'in_progress' THEN 'expired'
         ELSE status
       END,
       recovery_status = CASE COALESCE(recovery_status, status)
         WHEN 'no_safe_action' THEN 'skipped'
         WHEN 'max_replicas_reached' THEN 'blocked'
         WHEN 'requires_database_remediation' THEN 'manual_intervention_required'
         WHEN 'rate_limited' THEN 'blocked'
         WHEN 'cooldown' THEN 'blocked'
         WHEN 'action_limit_reached' THEN 'blocked'
         WHEN 'pending' THEN 'planned'
         WHEN 'in_progress' THEN 'expired'
         ELSE COALESCE(recovery_status, status)
       END,
       before_metrics = CASE
         WHEN status IN ('no_safe_action', 'max_replicas_reached', 'requires_database_remediation',
                         'rate_limited', 'cooldown', 'action_limit_reached')
           THEN NULL
         ELSE before_metrics
       END,
       after_metrics = CASE
         WHEN status IN ('no_safe_action', 'max_replicas_reached', 'requires_database_remediation',
                         'rate_limited', 'cooldown', 'action_limit_reached', 'in_progress')
           THEN NULL
         ELSE after_metrics
       END,
       effectiveness_score = CASE
         WHEN status IN ('no_safe_action', 'max_replicas_reached', 'requires_database_remediation',
                         'rate_limited', 'cooldown', 'action_limit_reached', 'in_progress')
           THEN NULL
         ELSE effectiveness_score
       END,
       effectiveness_by_metric = CASE
         WHEN status IN ('no_safe_action', 'max_replicas_reached', 'requires_database_remediation',
                         'rate_limited', 'cooldown', 'action_limit_reached', 'in_progress')
           THEN NULL
         ELSE effectiveness_by_metric
       END,
       message = CASE
         WHEN status = 'requires_database_remediation'
           THEN 'Database remediation required: Application-only recovery cannot repair a database-level issue.'
         WHEN status = 'no_safe_action' THEN 'No safe recovery action available.'
         WHEN status = 'max_replicas_reached' THEN 'Scaling blocked: maximum replica limit reached.'
         WHEN status = 'in_progress' THEN 'Legacy recovery action expired because its execution could not be verified.'
         ELSE message
       END,
       error_details = CASE
         WHEN status = 'in_progress' THEN COALESCE(error_details, 'Legacy recovery action execution could not be verified.')
         ELSE error_details
       END,
       updated_at = NOW()
     WHERE status IN ('no_safe_action', 'max_replicas_reached', 'requires_database_remediation',
                      'rate_limited', 'cooldown', 'action_limit_reached', 'pending', 'in_progress')
  `);
  await client.query(`
    UPDATE recovery_actions
       SET status = 'expired', recovery_status = 'expired',
           after_metrics = NULL, effectiveness_score = NULL, effectiveness_by_metric = NULL,
           message = 'Legacy recovery action expired because its execution could not be verified.',
           error_details = COALESCE(error_details, 'Legacy recovery action execution could not be verified.'),
           updated_at = NOW()
     WHERE status = 'executing' AND execution_started_at IS NULL AND created_at <= NOW() - INTERVAL '10 minutes'
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS recovery_actions_incident_created_idx ON recovery_actions (incident_id, created_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS recovery_actions_triggered_created_idx ON recovery_actions (triggered_by, created_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS recovery_actions_target_created_idx ON recovery_actions (target_service, created_at DESC);`);

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

  logger.info('monitoring_database_initialized');
}

module.exports = { initDatabase, client };
