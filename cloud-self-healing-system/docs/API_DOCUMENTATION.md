# Sentinel API Documentation

## Load Generator

The load generator runs inside the Compose network at `load-generator:8004` and sends real HTTP POST requests to the existing service APIs.

### Start a run

```http
POST /api/load/start
Content-Type: application/json

{
  "targetService": "payment-service",
  "requestsPerSecond": 50,
  "durationSeconds": 60,
  "scenario": "traffic-spike"
}
```

Allowed `targetService` values are `payment-service`, `order-service`, `user-service`, and `all`. Allowed scenarios are `normal` and `traffic-spike`. Requests per second is limited to 200 and duration is limited to 300 seconds. A second active run returns HTTP 409.

### Stop a run

```http
POST /api/load/stop
```

### Read load status

```http
GET /api/load/status
```

The response includes active state, target, scenario, request counts, current request rate, latency statistics, error rate, and start/stop timestamps.

### Direct load-generator endpoints

The service also exposes the same operations directly on port `8004`:

```text
GET  /health
GET  /metrics
POST /start
POST /stop
GET  /status
```

### Traffic-spike demo

```http
POST /api/simulate/traffic-spike
```

This keeps the existing controlled metric scenario and also starts a 60-second, 50-requests-per-second run against `payment-service`.

## Automatic Incident Detection

After each monitoring cycle, the backend sends the latest Docker, probe, and load-generator data to the ML service. Anomalies trigger failure prediction, incident classification, and dependency-aware root-cause analysis.

```text
GET  /api/incidents
GET  /api/incidents/:id
GET  /api/incidents/active
POST /api/incidents/detect
GET  /api/incidents/:id/summary
POST /api/incidents/:id/recover
```

`POST /api/incidents/detect` manually checks the latest sample for every monitored service. Active incidents are updated instead of duplicated, and new incidents use a two-minute service/type cooldown. Records include anomaly score, detection methods, contributing features, failure probability, risk level, classification confidence, propagation path, evidence, and latest metrics.

Automatic recovery is disabled by default. Manual recovery remains available through `POST /api/incidents/:id/recover`.

## Safe Recovery APIs

```text
POST /api/incidents/:id/recover
GET  /api/recovery/actions
GET  /api/recovery/actions?incidentId=1
GET  /api/recovery/config
POST /api/recovery/config
```

The recovery configuration response is:

```json
{
  "autoRecoveryEnabled": false,
  "maxActionsPerHour": 5,
  "verificationDelayMs": 10000,
  "maxServiceReplicas": 5,
  "minServiceReplicas": 2
}
```

Enable automatic recovery at runtime:

```powershell
$body = @{ autoRecoveryEnabled = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/recovery/config -ContentType 'application/json' -Body $body
```

Only `restart_service` and `scale_service` are executable. Targets are restricted to `payment-service`, `order-service`, `user-service`, and `load-generator`; scaling is restricted to payment-service and adds one replica at a time, with an absolute maximum of five. Automatic execution obeys the hourly limit and per-incident cooldown. Every action is persisted before execution and updated with before/after metrics, verification status, effectiveness score, and manual/automatic trigger source. GenAI recovery explanations are generated only after verification completes.

## Monitoring APIs

```text
GET /api/services/status
GET /api/metrics/current
GET /api/metrics/history?service=payment-service&range=5m
GET /api/monitoring/health
GET /api/dependency-graph
```

PowerShell examples:

```powershell
$body = @{ targetService = 'payment-service'; requestsPerSecond = 50; durationSeconds = 60; scenario = 'traffic-spike' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/start -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Get -Uri http://localhost:5000/api/load/status
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/stop
```
