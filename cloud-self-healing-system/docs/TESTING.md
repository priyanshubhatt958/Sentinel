# Testing and Validation

## Focused automated tests

Run from the project directory:

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

The monitoring backend suite covers incident detection behavior, real sample mapping, database telemetry mapping, recovery policy, action aggregation, cooldown calculation, recovery scoring/status bands, and local GenAI report generation. Its integration tests expect a running monitoring API and PostgreSQL stack.

The shared-service tests cover real request success/error/latency accounting, bounded memory and CPU simulation cleanup, and DB query/pool telemetry with an injected pool. The service restart persistence test is opt-in with `RUN_SERVICE_RESTART_TESTS=1` and needs a disposable/controlled Compose environment.

Load-generator tests cover rate scheduling, request counts/latency, cancellation, and limits. ML tests cover input handling, detection/classification, and report behavior. Frontend validation currently uses the production Vite build; there is no separate component-test runner in this repository.

## Docker and endpoint validation

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
curl.exe http://localhost:5000/api/health
curl.exe http://localhost:8000/ml/health
curl.exe http://localhost:8001/health
curl.exe http://localhost:8002/health
curl.exe http://localhost:8003/health
curl.exe http://localhost:8004/health
```

Follow component logs with:

```powershell
docker compose logs -f monitoring-backend
docker compose logs -f ml-service
docker compose logs -f payment-service
docker compose logs -f load-generator
```

## End-to-end validation

Use the traffic workflow in [DEMO_SCRIPT.md](DEMO_SCRIPT.md). Confirm persisted metrics, an ML integration status, incident detail and summary, recovery timeline, and simulation cleanup. Automatic recovery must remain disabled except during a controlled action test. Stop tests with `/api/simulate/stop` and disable automatic recovery afterwards.

## Validation snapshot

The currently completed focused validation includes:

- Recovery and GenAI fallback unit tests: passed.
- Shared telemetry and bounded simulation unit tests: passed; the opt-in PostgreSQL restart test was skipped unless explicitly enabled.
- Frontend production build: passed; Vite reports a large JavaScript chunk warning.
- Docker Compose configuration validation: passed.

Run the commands above after modifying the project to refresh the snapshot. Do not treat a production build as evidence of browser-level interaction or a Compose config check as evidence that Docker services started.

## Known validation limits

- A live E2E run requires Docker Desktop and modifies the local database/recovery action history.
- Automatic scaling/restart verification changes running containers; use only the local demo stack.
- GenAI provider behavior is not validated unless a valid test API key and network access are explicitly configured. The local fallback is covered without credentials.
- Model risk estimates are not calibrated.
