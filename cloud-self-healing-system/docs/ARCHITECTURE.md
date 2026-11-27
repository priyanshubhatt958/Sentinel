# Sentinel Architecture

## System topology

Sentinel runs as a single Docker Compose project with one persistent PostgreSQL volume. The React/Vite dashboard calls the Express monitoring backend. The backend reads Docker Engine state through the Docker socket, probes the business services, calls the FastAPI ML service, reads load-generator status, and persists monitoring and incident records. Business services and the monitoring backend connect to PostgreSQL.

```text
Browser :5173
  └── Monitoring backend :5000
      ├── Docker Engine API (mounted socket)
      ├── ML service :8000
      ├── Load generator :8004
      ├── PostgreSQL :5432
      └── service probes / metrics
          ├── User :8003 ──> Order :8001 ──> Payment :8002 ──> PostgreSQL
          ├── Order :8001 ───────────────────> Payment :8002
          └── Payment :8002 ─────────────────> PostgreSQL
```

## Services

- **user-service:** creates and reads persisted users.
- **order-service:** creates and reads orders, requests a payment, and marks payment failures.
- **payment-service:** creates and reads payments, and reports PostgreSQL pool/query telemetry.
- **load-generator:** schedules real HTTP requests with cancellation, bounded duration/rate, and rolling request-rate metrics.
- **monitoring-backend:** collects Docker and service telemetry, writes samples, calls ML endpoints, stores incidents, serves the dashboard API, and orchestrates safe recovery.
- **ml-service:** applies the Isolation Forest signal plus explicit threshold rules for anomaly detection, classification, risk estimation, and dependency-aware root-cause output.
- **frontend:** polls API data and renders system status, metrics, incidents, recovery history, simulation/load controls, and dependency nodes.
- **database:** PostgreSQL 16 with a named volume; an idempotent `db-migrate` one-shot service applies application schema before dependent services start.

## Data flow

### Monitoring

1. The collector enumerates containers using Docker Compose project/service labels.
2. Docker stats counters produce CPU and memory measurements. Container state, health, uptime, restart count, and last error are read from Docker metadata.
3. Each service `/health` probe contributes measured latency, status code, and outcome. Each service `/metrics` endpoint contributes request and database-pool counters.
4. The collector stores a sample in `monitoring_samples` every configured interval (default five seconds), retaining the existing table/data and adding columns idempotently.
5. `/api/metrics/current` and `/api/metrics/history` read persisted samples; the frontend refreshes every five seconds and labels unavailable data as stale.

### ML and incidents

1. A collected sample is normalized into a structured payload, including request rate, latency/error statistics, database pool pressure, probe results, restart count, and container state.
2. The backend calls `/ml/detect`, then calls prediction, classification, and root-cause endpoints as needed. ML failures are surfaced as unavailable; they are not converted into “no anomaly.”
3. Incidents and evidence are inserted/updated in PostgreSQL. Active incidents are updated rather than duplicated during the incident cooldown.
4. The risk estimate is a heuristic; `estimatedFailureWindow` explicitly says it is not calibrated.

### Recovery

1. `recoveryService` recommends only allowlisted application actions: restart an allowlisted service, scale the payment service one replica, require database remediation, require manual intervention, or take no action.
2. Automatic recovery is off by default. Manual controls remain available for safe action types.
3. The orchestrator checks per-action cooldown, action count per incident, service/hour limits, and the automatic global/hour limit. Repeated failures extend cooldown and eventually require manual intervention.
4. Decision-only records have no before/after metrics or effectiveness score. Database incidents are `manual_intervention_required`, no-safe-action decisions are `skipped`, and replica limits are `blocked`.
5. Before execution, the orchestrator captures fresh service metrics. It records `planned`, `executing`, and `executed` transitions, then collects up to six fresh samples over a 30-second verification window.
6. Only threshold-qualified improvements contribute to the weighted score: CPU 30%, memory 25%, latency 20%, error rate 15%, and probe health 10%. A 1-minute reconciliation job expires stale planned/verification-pending records and fails executing records whose target container disappeared.
7. Scaling is performed through `docker compose up --scale payment-service=N`; a stable Nginx gateway preserves host port 8002 without preventing multiple payment replicas. Database-rooted incidents are never blindly “fixed” by restarting an application service.

### GenAI report

The summary service receives structured incident, metrics, evidence, recovery result, effectiveness, and timeline data. If `GENAI_ENABLED=true` and an API key is configured, it requests a JSON incident report. Disabled, unavailable, invalid, or failed GenAI requests produce a deterministic local report. Both reports contain the same nine sections and are persisted in `incidents.genai_report`; the human-readable text is retained in `genai_summary`.

## Database schema

`database/schema.sql` creates the business tables:

- `users(id, name, email, created_at)`
- `orders(id, user_id, amount, status, created_at)`
- `payments(id, order_id, amount, status, created_at)`

All IDs are integer serial keys and the nullable references use foreign keys. Monitoring initialization creates/extends `metrics`, `monitoring_samples`, `incidents`, and `recovery_actions`. Monitoring migrations use `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`; they do not drop tables or erase samples.

## Compose topology and persistence

All services join Compose's default network and use service DNS names. The payment gateway exposes host port 8002 and dynamically routes to Compose-scaled payment replicas. Host ports are listed in the README. PostgreSQL uses `postgres_data`. `docker compose down` preserves the volume; `docker compose down -v` deletes it.

## Security considerations

- Keep `.env` local and do not commit real database or GenAI credentials.
- Automatic recovery is disabled by default and recovery targets/actions are allowlisted.
- Simulations have duration/resource caps and explicit stop controls.
- The Docker socket grants significant host control; do not expose this project to untrusted networks or users.
- GenAI content is explanatory, not an authoritative command source. It receives incident context and has no direct recovery tool.
- The demo services do not implement user authentication or authorization and should remain local.

## Scalability considerations

The collector and in-memory per-service metric windows are designed for a small local demo. PostgreSQL stores history, but unbounded production-scale retention, concurrent collector leadership, distributed coordination, and horizontally scaled monitoring workers are not implemented. Replica changes are bounded and managed through Docker Engine API labels; this is not a general-purpose orchestrator.

## Limitations

- Isolation Forest training uses generated data; risk prediction is heuristic and not calibrated.
- Simulation is explicit fault injection, not a representation of naturally occurring production failures.
- GenAI requires a compatible external API and a valid key; local fallback remains available.
- Recovery effectiveness measures observed relative improvement in the available metrics and cannot prove causality.
- Database remediation is intentionally manual.
