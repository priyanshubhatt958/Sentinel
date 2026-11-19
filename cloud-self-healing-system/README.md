# AI-Powered Self-Healing Cloud Application

This project is a production-style B.Tech final-year major project that demonstrates an AI-powered self-healing cloud application using anomaly detection, root-cause analysis, recovery orchestration, and a React dashboard.

## Project Overview

The system monitors Dockerized microservices, collects runtime metrics, detects anomalies, identifies probable root causes using a dependency graph, predicts failure risk, recommends safe recovery actions, and verifies improvements. It also generates a human-readable incident summary using an OpenAI-compatible API when available, with a deterministic fallback when no API key is configured.

## Project Objective

To build a self-healing distributed application that continuously observes microservices, identifies anomalies, diagnoses likely causes, applies safe recovery actions, and validates that the system recovered successfully.

## High-Level Architecture

```text
React Dashboard
      ↓
Monitoring Backend
      ↓
 ┌────────────┬───────────────┬────────────────┐
 ↓            ↓               ↓                ↓
Metrics DB   ML Service   Dependency Graph   Recovery Engine
 └────────────┴───────────────┴────────────────┘
      ↓
Dockerized Microservices
      ↓
PostgreSQL Database
```

## Core Demo Scenario

Normal system → simulated traffic spike → anomaly detected → dependency graph analysis → root cause identified → failure risk predicted → Payment Service scaled from 2 to 3 replicas → recovery verified → GenAI summary generated.

## Technologies

- Node.js 20 + Express
- Python 3.11 + FastAPI
- PostgreSQL 16
- Docker + Docker Compose
- React + Vite + Recharts + Axios
- scikit-learn + pandas + numpy + NetworkX
- OpenAI-compatible GenAI API (optional)

## Repository Structure

```text
cloud-self-healing-system/
├── services/
│   ├── order-service/
│   ├── payment-service/
│   └── user-service/
├── load-generator/
├── monitoring-backend/
├── ml-service/
├── frontend/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── docs/
├── README.md
└── .dockerignore
```

## Setup

1. Copy `.env.example` to `.env`.
2. Update environment variables as required.
3. Ensure Docker Desktop is running on Windows.
4. Run:

```powershell
docker compose up --build
```

## Verification

```powershell
curl http://localhost:8001/health
curl http://localhost:8002/health
curl http://localhost:8003/health
curl http://localhost:5000/api/services/status
curl http://localhost:5000/api/metrics/current
curl "http://localhost:5000/api/metrics/history?service=payment-service&range=1h"
curl http://localhost:5000/api/monitoring/health
```

## Real-Time Monitoring

The monitoring backend reads the Docker Engine API through the mounted Docker socket. It does not fabricate container health or resource values. Every five seconds it records:

- Docker lifecycle state, container ID, uptime, restart count, and last container error
- Docker health-check state, independent of lifecycle state
- CPU percentage calculated from successive Docker CPU and system CPU counters, multiplied by the available CPU count
- Memory used after subtracting Docker cache, memory limit, and usage percentage when a finite limit is available
- Application health-probe latency, HTTP status, success/failure outcome, and probe error

Historical samples are stored in PostgreSQL in the `monitoring_samples` table and retained for `MONITORING_RETENTION_DAYS` (default: 7). The dashboard polls the monitoring API every five seconds and shows a stale-data message when the backend is unavailable.

Automatic recovery is disabled by default. When explicitly enabled, Sentinel executes only allowlisted restart or one-replica payment-service scale actions, enforces an hourly rate limit and per-incident cooldown, then verifies fresh metrics before generating a recovery summary. Manual recovery remains available while automatic recovery is disabled.

## Real Load Generator

The `load-generator` Compose service runs on port `8004` and creates real HTTP traffic inside the Compose network. It sends valid POST requests to `/orders`, `/payments`, and `/users`, then records request counts and measured latency from those requests.

Start a 60-second payment traffic run at 50 requests per second:

```powershell
$body = @{ targetService = 'payment-service'; requestsPerSecond = 50; durationSeconds = 60; scenario = 'traffic-spike' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/start -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Get -Uri http://localhost:5000/api/load/status
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/stop
```

The load generator limits runs to 200 requests per second and 300 seconds, prevents overlapping runs, continues when an individual request fails, and reports successful and failed requests separately. The existing `POST /api/simulate/traffic-spike` demo now starts this real payment load automatically in addition to the controlled service-metric scenario.

## Automatic Incident Detection

After each monitoring cycle, the backend sends the latest real Docker and probe sample to the ML service. Anomalies trigger prediction, classification, and dependency-aware root-cause analysis, then create or update a persisted incident. Active incidents are updated instead of duplicated, while new service/type incidents use a two-minute cooldown.

```powershell
Invoke-RestMethod http://localhost:5000/api/incidents
Invoke-RestMethod http://localhost:5000/api/incidents/active
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/incidents/detect
```

Automatic recovery is a separate opt-in stage, controlled by `AUTO_RECOVERY_ENABLED`; it remains off unless enabled through configuration. Manual recovery is still available through `POST /api/incidents/:id/recover`.

## Safe Recovery

Recovery settings are configured with these defaults in `.env.example`:

```text
AUTO_RECOVERY_ENABLED=false
AUTO_RECOVERY_MAX_ACTIONS_PER_HOUR=5
RECOVERY_VERIFICATION_DELAY_MS=10000
MAX_SERVICE_REPLICAS=5
MIN_SERVICE_REPLICAS=2
```

Read or update runtime configuration and action history:

```powershell
Invoke-RestMethod http://localhost:5000/api/recovery/config
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/recovery/config -ContentType 'application/json' -Body (@{ autoRecoveryEnabled = $true } | ConvertTo-Json)
Invoke-RestMethod 'http://localhost:5000/api/recovery/actions?incidentId=1'
```

Automatic actions are limited to `restart_service` and `scale_service`, targeting payment, order, user, or load-generator containers. The implemented rules scale payment-service by one replica only (2→3 in the default Compose setup), never beyond five. Database bottlenecks do not restart or scale the database; the action record explains that database-level remediation is outside the safe scope. Recovery actions retain before/after metrics and verification results.

## Demo Sequence

```powershell
curl -X POST http://localhost:5000/api/simulate/traffic-spike
curl http://localhost:5000/api/incidents
curl http://localhost:5000/api/incidents/1
curl -X POST http://localhost:5000/api/incidents/1/recover
curl http://localhost:8002/metrics
```

## Notes

This starter scaffold is designed to be extended across the milestone implementation. Full app logic, ML detection, dependency analysis, and dashboard are added in the subsequent milestones.
