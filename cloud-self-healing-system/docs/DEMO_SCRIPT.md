# Sentinel Demonstration Script

## Preparation

1. Start Docker Desktop with the Linux engine.
2. From the project directory, create local configuration and start the services:

```powershell
Copy-Item .env.example .env
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

Wait for the services to report healthy. Check logs if any service remains unhealthy:

```powershell
docker compose logs --tail 100 monitoring-backend
docker compose logs --tail 100 ml-service
docker compose logs --tail 100 payment-service
```

Keep automatic recovery disabled at first so the detection and recommendation can be inspected before any action runs.

## Step-by-step demo

### 1. Confirm service health

```powershell
curl.exe http://localhost:5000/api/health
curl.exe http://localhost:8000/ml/health
curl.exe http://localhost:8001/health
curl.exe http://localhost:8002/health
curl.exe http://localhost:8003/health
curl.exe http://localhost:8004/health
```

Expected: JSON status is healthy/ok and each business service can reach PostgreSQL.

### 2. Open the dashboard and establish a baseline

Open <http://localhost:5173>. Confirm service status, CPU/memory, probe latency, request rate, database health, ML integration status, and load-generator status. A first dashboard load can show empty history while the collector gathers samples.

### 3. Start actual HTTP traffic

```powershell
$body = @{
  targetService = 'payment-service'
  requestsPerSecond = 100
  durationSeconds = 60
  scenario = 'traffic-spike'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/start -ContentType 'application/json' -Body $body
```

The load generator sends real POST requests and counts successes, failures, latency, and recent requests/second.

### 4. Start bounded traffic fault injection

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/simulate/traffic-spike -ContentType 'application/json' -Body '{"durationMs":30000}'
```

The endpoint starts a temporary delay on service requests and starts its own default demo traffic run. To avoid a concurrent-run conflict, either use this endpoint by itself or stop the manually configured load first.

### 5. Verify observed data and ML-derived incident

Wait 10–20 seconds, then inspect:

```powershell
Invoke-RestMethod 'http://localhost:5000/api/metrics/current?service=payment-service'
Invoke-RestMethod http://localhost:5000/api/incidents/active
Invoke-RestMethod http://localhost:5000/api/simulations/status
```

Expected: persisted samples contain measured service request/latency/error and DB-pool telemetry. If the ML integration is unavailable, the health endpoint reports it and detection fails explicitly; no default “no anomaly” incident result is fabricated. Classification depends on observed thresholds and the generated model signal, so an incident is not guaranteed for every workload or machine.

### 6. Inspect diagnosis and recommendation

Use the incident ID from the active incidents response:

```powershell
$id = 1
Invoke-RestMethod "http://localhost:5000/api/incidents/$id"
Invoke-RestMethod "http://localhost:5000/api/incidents/$id/recovery-timeline"
Invoke-RestMethod "http://localhost:5000/api/incidents/$id/summary"
```

Expected: incident type, risk/probability, root cause, evidence, recommendation, local/GenAI report source, and current recovery state.

### 7. Enable recovery only for the controlled demo

```powershell
$body = @{ autoRecoveryEnabled = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/recovery/config -ContentType 'application/json' -Body $body
```

Wait for a collector cycle or trigger manual recovery from the incident details panel. Observe the action history and compare before/after metrics:

```powershell
Invoke-RestMethod "http://localhost:5000/api/recovery/actions?incidentId=$id"
Invoke-RestMethod "http://localhost:5000/api/incidents/$id/recovery-timeline"
Invoke-RestMethod "http://localhost:5000/api/incidents/$id/summary"
```

Expected: safe actions are allowlisted and cooldown/limits are visible. A database bottleneck is skipped with a database-remediation recommendation rather than restarting an app. Recovery status and effectiveness reflect available fresh measurements.

### 8. Reset and disable automatic recovery

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/simulate/stop -ContentType 'application/json' -Body '{}'
$body = @{ autoRecoveryEnabled = $false } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/recovery/config -ContentType 'application/json' -Body $body
```

Verify the load and simulation statuses show stopped/completed cleanup. The simulation endpoints also stop automatically at their configured duration.

## Troubleshooting

- **Docker API pipe/engine unavailable:** start Docker Desktop and verify its Linux engine, then retry `docker compose ps`.
- **API returns 503:** inspect `docker compose logs --tail 100 <service>` and `/api/health`.
- **ML unavailable:** inspect `docker compose logs --tail 100 ml-service`; the monitoring health response should show `mlIntegration.available=false`.
- **No incident appears:** verify load is active, wait two or three monitoring cycles, check `/api/metrics/current`, and compare the measurements with ML thresholds. Local hardware/workload can affect detection.
- **Recovery does not run:** check `AUTO_RECOVERY_ENABLED`, the recommendation, action cooldown, action/service/hour limits, and replica limit.
- **Database action skipped:** this is intentional; the configured recovery policy does not restart PostgreSQL.
- **Frontend stale state:** verify port 5000 and the browser console; reload after the backend is healthy.
- **Stop everything:** run `docker compose down` from the project directory. This retains the database volume.
