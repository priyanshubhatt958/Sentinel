# Sentinel: AI-Powered Cloud Self-Healing System

Sentinel is a local Docker Compose application that collects real container and HTTP-service telemetry, sends it through an ML-assisted anomaly pipeline, persists incidents and recovery actions in PostgreSQL, and presents the result in a React dashboard.

## Objectives

- Monitor payment, order, and user services plus PostgreSQL, the load generator, ML service, and monitoring backend.
- Detect anomalies, classify incidents, estimate heuristic failure risk, and identify likely root causes.
- Run bounded fault simulations and real HTTP traffic.
- Recommend and optionally execute allowlisted recovery actions, then verify them against fresh measurements.
- Persist application data, monitoring samples, incidents, recovery history, and structured summaries across service restarts.

## Architecture

```text
Browser (React/Vite :5173)
          |
Monitoring API (:5000) ---- ML API (:8000)
    |       |       |
    |       |       +-- Docker Engine API (local Docker socket)
    |       +---------- Load generator (:8004)
    +------------------ PostgreSQL (:5432)
                              |
                 user (:8003), order (:8001),
                 payment gateway (:8002) -> payment replicas
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the monitoring, ML, incident, recovery, and GenAI data flows.

## Technology

- Docker Compose and Docker Engine API
- Node.js, Express, PostgreSQL, `pg`, and Dockerode
- Python, FastAPI, scikit-learn, pandas, NetworkX, and joblib
- React, Vite, and Recharts

## Services and local ports

| Service | Port | Purpose |
|---|---:|---|
| Frontend | 5173 | Live monitoring dashboard |
| Monitoring backend | 5000 | Metrics, incident, recovery, and simulation APIs |
| ML service | 8000 | Anomaly detection, classification, prediction, root cause |
| Order service | 8001 | Persistent orders and payment orchestration |
| Payment gateway | 8002 | Stable host port routed to Compose-scaled payment replicas |
| Payment service | — | Persistent payments; internal Compose service |
| User service | 8003 | Persistent users |
| Load generator | 8004 | Bounded real HTTP traffic |
| PostgreSQL | 5432 | Application and monitoring persistence |

## Setup and run

Run these commands from `cloud-self-healing-system` in PowerShell. Ensure Docker Desktop is running with its Linux engine enabled.

```powershell
Copy-Item .env.example .env
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

The `.env` file is local configuration; do not commit it. The sample disables automatic recovery and GenAI by default.

Stop the stack without deleting persistent PostgreSQL data:

```powershell
docker compose down
```

To delete the database volume as well, use `docker compose down -v` only when intentionally resetting all local data.

## Basic checks

```powershell
curl.exe http://localhost:5000/api/health
curl.exe http://localhost:8000/ml/health
curl.exe http://localhost:8001/health
curl.exe http://localhost:8002/health
curl.exe http://localhost:8003/health
curl.exe http://localhost:8004/health
```

The dashboard is at <http://localhost:5173>. `GET /api/metrics/current?service=payment-service` returns persisted real service, probe, and database-pool samples.

## End-to-end demo

Start a bounded run of real payment requests:

```powershell
$body = @{
  targetService = 'payment-service'
  requestsPerSecond = 100
  durationSeconds = 60
  scenario = 'traffic-spike'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/start -ContentType 'application/json' -Body $body
```

Start the bounded traffic-delay simulation:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/simulate/traffic-spike -ContentType 'application/json' -Body '{}'
```

After 10–20 seconds, inspect metrics and incidents:

```powershell
Invoke-RestMethod 'http://localhost:5000/api/metrics/current?service=payment-service'
Invoke-RestMethod http://localhost:5000/api/incidents/active
Invoke-RestMethod http://localhost:5000/api/simulations/status
```

Automatic recovery remains opt-in. Manual recovery is recorded as planned, executing, executed, verification-pending, and then a measured result. The verifier collects six fresh samples over a 30-second window by default, applies minimum improvement thresholds and weighted scoring, and retains all action details in the recovery timeline. Scaling runs through Docker Compose and the payment gateway keeps host port 8002 stable across replicas.

To enable automatic recovery temporarily for a controlled local demonstration:

```powershell
$body = @{ autoRecoveryEnabled = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/recovery/config -ContentType 'application/json' -Body $body
```

Inspect the incident detail, timeline, and report at `GET /api/incidents/{id}`, `GET /api/incidents/{id}/recovery-timeline`, and `GET /api/incidents/{id}/summary`. Turn automatic recovery off again when finished. Manual recovery is available in the dashboard for incidents with a safe action; database incidents are explicitly skipped.

More detailed commands and expected observations are in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Real functionality vs. simulations

**Real:** Docker lifecycle/health/restart data, Docker CPU and memory counters, HTTP health-probe timing, service request counts and latencies, PostgreSQL operations and pool utilization, load-generator request outcomes, PostgreSQL persistence, ML pipeline calls, recovery action history, and fresh before/after measurements.

**Bounded simulation:** traffic delay, database query delay/concurrency, temporary memory allocation, and worker-thread CPU load. These are explicit fault-injection controls, not naturally occurring production failures. Each simulation is duration-limited and reports cleanup state.

**Model limits:** the Isolation Forest is trained on generated training samples during image build. Failure probability is a heuristic and not a calibrated time-to-failure estimate. GenAI is optional; when disabled or unavailable, Sentinel generates a local report from stored incident data.

## Configuration

Copy [`.env.example`](.env.example) to `.env`. Important settings include database pool limits, simulation bounds, recovery cooldown/action limits, `AUTO_RECOVERY_ENABLED`, and `GENAI_ENABLED`/`GENAI_API_KEY`. See [docs/API.md](docs/API.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests and docs

```powershell
Set-Location monitoring-backend
npm test
Set-Location ..\load-generator
npm test
Set-Location ..\services\common
node --test test\*.test.js
Set-Location ..\..\ml-service
python -m compileall app
python -m unittest discover -s tests
Set-Location ..\frontend
npm run build
Set-Location ..
docker compose config --quiet
```

The full test/verification ledger is in [docs/TESTING.md](docs/TESTING.md). Other project documentation:

- [API reference](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Demo script](docs/DEMO_SCRIPT.md)
- [Final report](docs/FINAL_REPORT.md)
- [Viva questions](docs/VIVA_QUESTIONS.md)

## Limitations and future work

Sentinel is a local demonstration, not a production control plane. Recovery is deliberately constrained, Docker socket access is powerful, GenAI output is not authoritative, and anomaly thresholds require workload-specific calibration. Future work includes calibrated prediction, stronger action approval/audit controls, metrics export, dashboard component tests, and controlled replica lifecycle management aligned with Compose.
