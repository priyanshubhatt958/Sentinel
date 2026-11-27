# Sentinel API Reference

All host-facing URLs below use `http://localhost`. JSON endpoints accept and return `application/json`. Errors use a JSON object with an `error` or `message` field. Monitoring API port: `5000`.

## Monitoring backend

### Health and service status

| Method | Route | Response |
|---|---|---|
| GET | `/api/health`, `/api/monitoring/health` | Monitoring, collector, and ML integration health |
| GET | `/api/services/status` | Docker service state and PostgreSQL availability |
| GET | `/api/dependency-graph` | `nodes` and directed dependency `edges` |
| GET | `/api/simulations/status` | Per-service simulation state, duration, and cleanup status |

### Metrics

| Method | Route | Notes |
|---|---|---|
| POST | `/api/metrics` | Persist a compatibility metric record; body uses `service`, `cpuUsage`, `memoryUsage`, `requestRate`, `latencyMs`, `errorRate`, `dbConnections`, `status`, and `failureMode`. |
| GET | `/api/metrics/latest?service=payment-service` | Latest persisted sample(s) for one service |
| GET | `/api/metrics/current?service=payment-service` | Current samples; omit `service` to return all monitored services |
| GET | `/api/metrics/history?service=payment-service&range=1h` | Historical samples. `range` supports `5m`, `1h`, or `7d`; legacy `minutes` is also accepted. |

Samples include CPU/memory, container state, probe latency/outcome, total/success/failure/active requests, current and rolling request rate, average/p95/max/min latency, service error rate, PostgreSQL query and pool metrics, and load-generator metadata when available.

### Load generation

| Method | Route | Request |
|---|---|---|
| POST | `/api/load/start` | `{"targetService":"payment-service","requestsPerSecond":100,"durationSeconds":60,"scenario":"traffic-spike"}` |
| POST | `/api/load/stop` | Empty JSON object |
| GET | `/api/load/status` | Current run state and real request outcomes |

Allowed targets: `payment-service`, `order-service`, `user-service`, `all`. Allowed scenarios: `normal`, `traffic-spike`. Maximums are 200 requests/second and 300 seconds. A concurrent run returns HTTP 409.

### Incidents and recovery

| Method | Route | Notes |
|---|---|---|
| GET | `/api/incidents` | Incidents newest-first |
| GET | `/api/incidents/active` | Pending/planned/executing/verification-pending/partially recovered incidents |
| GET | `/api/incidents/{id}` | Incident fields and `recoveryRecommendation` |
| POST | `/api/incidents/detect` | Run detection against current persisted samples |
| GET | `/api/incidents/{id}/summary` | Full report, source (`genai` or `fallback`), evidence, recommendation, and recovery result |
| GET | `/api/incidents/{id}/recovery-timeline` | Chronological action and decision audit history |
| POST | `/api/incidents/{id}/recover` | Run a safe manual recovery decision |
| GET | `/api/recovery/config` | Runtime recovery limits and automatic recovery state |
| POST | `/api/recovery/config` | Update validated settings; e.g. `{"autoRecoveryEnabled":true}` |
| GET | `/api/recovery/actions` | Latest 100 actions |
| GET | `/api/recovery/actions?incidentId=12` | Actions for one incident |

Recovery config includes `autoRecoveryEnabled`, `maxActionsPerHour`, `cooldownMs`, `maxActionsPerIncident`, `maxActionsPerServicePerHour`, `maxFailuresBeforeManual`, `verificationDelayMs` (30,000–60,000 ms), `verificationSamples` (3–6), `maxServiceReplicas`, and `minServiceReplicas`. Automatic recovery is disabled by default. Database incidents are persisted as `manual_intervention_required` with the reason “Application-only recovery cannot repair a database-level issue.” No-safe-action decisions are `skipped`; replica-limit and cooldown/rate-limit decisions are `blocked`.

Executed actions follow `planned` → `executing` → `executed` → `verification_pending` and finish as `recovered`, `partially_recovered`, or `not_recovered` only after at least three fresh samples are collected. The verifier applies minimum improvements (CPU 10 percentage points, memory 5 points, latency 15%, error rate 20%, probe failures to zero or at least 50% fewer) and weighted scoring (30/25/20/15/10). The incident recovery timeline includes decision, safety, execution, cooldown, sample/window, metric, score, status, and error details. A background reconciliation job expires planned/verification-pending actions after 10 minutes and fails executing actions whose target container no longer exists.

Payment scaling uses Docker Compose with the payment service scale count. A local Nginx gateway retains host port 8002 while Compose routes requests to the scaled replicas.

### Bounded fault injection

| Method | Route | Behavior |
|---|---|---|
| POST | `/api/simulate/traffic-spike` | Start bounded request-delay simulation on business services and start the demo load run |
| POST | `/api/simulate/database-overload` | Add delayed queries and bounded concurrent DB work |
| POST | `/api/simulate/memory-leak` | Hold capped memory temporarily on payment service |
| POST | `/api/simulate/cpu-overload` | Run capped worker-thread CPU load on payment service |
| POST | `/api/simulate/stop` | Stop active simulations and load |

Optional body: `{"durationMs":30000}`. Maximum duration defaults to 60,000 ms and is controlled by `SIMULATION_MAX_DURATION_MS`.

## ML service (port 8000)

All model routes use `/ml`. `/ml/health` is a GET; the others are POST.

| Route | Request | Response |
|---|---|---|
| `GET /ml/health` | none | `{"status":"ok","service":"ml-service"}` |
| `POST /ml/detect` | Required `service`; telemetry fields are optional numeric/string values | `anomaly`, `anomalyScore`, `contributingFeatures`, `detectedBy` |
| `POST /ml/predict` | Same telemetry object | `failureProbability`, `riskLevel`, `estimatedFailureWindow`, `reason` |
| `POST /ml/classify` | Same telemetry object | `incidentType`, confidence, classification reason |
| `POST /ml/root-cause` | Same telemetry object | `rootCause`, `rootCauseType`, `affectedServices`, `propagationPath`, evidence |
| `POST /ml/summarize` | Incident JSON object | Local text summary |

Useful `MLInput` fields include `cpuUsage`, `memoryUsage`, `requestRate`, `requestsPerSecond`, `requestsLastMinute`, `latencyMs`, `averageLatencyMs`, `p95LatencyMs`, `errorRate`, `dbActiveConnections`, `dbWaitingRequests`, `dbAverageQueryLatencyMs`, `dbErrorRate`, `probeLatencyMs`, `probeFailures`, `restartCount`, and `containerState`. Missing metrics are handled as unavailable/default inputs by the service; the monitoring backend reports failed ML calls rather than asserting no anomaly.

## Load generator (port 8004)

Direct routes: `GET /health`, `GET /metrics`, `GET /status`, `POST /start`, and `POST /stop`. The `POST /start` body matches `/api/load/start`. Success returns HTTP 201 and `{"success":true,"run":...}`. Invalid configuration returns HTTP 400; a concurrent run returns HTTP 409.

## Business services

| Service | Port | Routes |
|---|---:|---|
| user-service | 8003 | `GET /health`, `GET /metrics`, `GET /users`, `POST /users`, `GET /users/{id}`, simulation routes below |
| order-service | 8001 | `GET /health`, `GET /metrics`, `GET /orders`, `POST /orders`, `GET /orders/{id}`, simulation routes below |
| payment-service | 8002 | `GET /health`, `GET /metrics`, `GET /payments`, `POST /payments`, `GET /payments/{id}`, simulation routes below |

Create user: `{"name":"Ada Example","email":"ada@example.test"}`. Create order: `{"userId":1,"amount":42.50}` (`userId` is optional). Create payment: `{"orderId":1,"amount":42.50,"status":"pending"}` (`orderId` is optional). Successful creates return HTTP 201 and the persisted row. Invalid data returns 400; unavailable database writes/reads return 503. Order payment failures return 502 and preserve the order with `payment_failed` status.

Each business service exposes `POST /simulate/{traffic-spike|database-overload|memory-leak|cpu-overload}`, `POST /simulate/stop`, and `GET /simulate/status`. Simulation requests accept optional `{"durationMs":30000}`; each service returns HTTP 202 and its simulation status.

## Examples

### PowerShell

```powershell
$body = @{ targetService = 'payment-service'; requestsPerSecond = 100; durationSeconds = 60; scenario = 'traffic-spike' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/load/start -ContentType 'application/json' -Body $body
Invoke-RestMethod 'http://localhost:5000/api/metrics/current?service=payment-service'
Invoke-RestMethod http://localhost:5000/api/incidents/active
Invoke-RestMethod http://localhost:5000/api/simulations/status
```

### curl

```sh
curl.exe -X POST http://localhost:5000/api/load/start -H "Content-Type: application/json" -d "{\"targetService\":\"payment-service\",\"requestsPerSecond\":100,\"durationSeconds\":60,\"scenario\":\"traffic-spike\"}"
curl.exe "http://localhost:5000/api/metrics/current?service=payment-service"
curl.exe http://localhost:5000/api/incidents/active
curl.exe http://localhost:8002/metrics
```
