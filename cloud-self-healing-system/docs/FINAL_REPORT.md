# Sentinel: AI-Powered Cloud Self-Healing System — Final Report

## Abstract

Sentinel is a Docker Compose demonstration of a monitored microservice application with ML-assisted anomaly detection and bounded recovery. It combines real Docker resource/lifecycle observations, measured HTTP and PostgreSQL telemetry, a load generator, persisted incident history, a safe recovery policy, recovery verification, and a React dashboard. Reports are generated locally by default, with optional GenAI explanations.

## Introduction and problem statement

Distributed services can fail through load, resource pressure, database bottlenecks, or dependency failures. A useful self-healing workflow needs more than an alert: it must collect evidence, localize likely causes, choose only safe actions, and measure whether service behavior improved. Sentinel implements this loop locally as an educational prototype.

## Objectives

1. Measure real container, HTTP, service, and database behavior.
2. Persist metrics and business records through service restarts.
3. Use a trained anomaly model plus explicit thresholds to identify incidents.
4. Analyze dependencies and provide a failure-risk estimate.
5. Apply allowlisted, bounded recovery actions with cooldowns and audit history.
6. Verify recovery through comparable before/after telemetry.
7. Expose status and incident explanations in a dashboard.

## Context and design rationale

The system follows standard observability and resilience concepts: service health probes, resource telemetry, request/error/latency indicators, dependency-aware fault localization, rate-limited remediation, and post-action verification. The local model and generated training samples make this a prototype rather than a production-calibrated predictor. Anomaly detection combines an Isolation Forest with explicit rules to retain interpretable triggers for demonstrable cases.

## Architecture

Docker Compose starts PostgreSQL, three business services, a real load generator, the monitoring API, an ML API, and a React frontend. The monitoring backend uses Dockerode for container observations and HTTP probes/metrics endpoints for application-level measurements. Details and component boundaries are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Implementation

### Persistent data and real-time monitoring

Users, orders, and payments use PostgreSQL with integer primary keys and foreign-key relationships. The monitoring collector stores historical samples without deleting existing data. The samples include Docker state, CPU/memory, probes, request statistics, database query/pool values, and load-generator context.

### Anomaly detection and classification

Monitoring sends normalized, nullable telemetry to FastAPI. The Isolation Forest is trained from generated data at image build time. Rule checks also classify practical local traffic, latency, probe, CPU, and database symptoms. Incident records include the ML response, evidence, root cause, affected services, and recent metrics.

### Failure prediction and root cause

Failure probability is a heuristic based on current features and is not a calibrated time-to-failure estimate. The dependency graph supports a likely-root-cause path and affected-service list. Root cause remains an inference from observed measurements and configured dependencies.

### Recovery engine and verification

The recovery policy supports allowlisted service restarts and one-at-a-time payment-service scale-up. Database incidents are classified as requiring database remediation and do not trigger application-only restarts. Every decision is persisted with reason, confidence, before/after measurements, status, cooldown, trigger source, and errors. Cooldown and action limits prevent loops; repeated failures require manual intervention.

The effectiveness score averages available relative improvements in CPU, memory, probe latency/failures, service error rate, average and p95 latency, and database query latency/error rate. It is normalized to 0–100. The status thresholds are `recovered` (80–100), `partially_recovered` (40–79), and `not_recovered` (0–39). Missing after metrics remain pending. The score demonstrates measured change, not causal proof.

### GenAI incident explanation

An optional OpenAI-compatible chat-completions API receives structured incident, metrics, evidence, recovery, and timeline information. It must return the required report sections. If disabled, unavailable, or malformed, the application writes a deterministic local report from the persisted data.

### Dashboard

The React UI shows service and dependency health, selected service metrics, load controls, bounded simulation state, ML status, active/recent incidents, recommendations, summaries, before/after metrics, manual recovery, and the chronological recovery timeline.

## Testing and results

Validation uses Node test suites for monitoring, shared service telemetry, load generation, and recovery behavior; Python tests/compilation for the ML API; Vite production build; Compose configuration validation; and optional live E2E checks. See [TESTING.md](TESTING.md) for the latest recorded results. A live demonstration should verify API health, request telemetry, incident evidence, recovery history, report source, and simulation cleanup.

## Limitations

- The Isolation Forest uses generated training data, and failure probability is heuristic.
- Local hardware and workload affect anomaly thresholds and incident timing.
- Fault injection is intentionally bounded simulation, not naturally occurring failure.
- GenAI requires explicit credentials/network access; local fallback is available.
- Effectiveness scores use available measurements and do not establish causal recovery.
- Database-level remediation is manual; authentication and production-grade approval controls are out of scope.
- Docker socket access is powerful and should remain local.

## Future work

Calibrate model outputs on representative labeled workloads, strengthen action approval and audit controls, add frontend component tests, expose richer aggregate metrics, add retention/backup controls, and move recovery decisions to a robust orchestrator if the project expands beyond a local demo.

## Conclusion

Sentinel demonstrates a complete local observability-to-recovery path using real telemetry and PostgreSQL persistence, while separating explicit simulations from live measurements. Its guardrails and limitations are visible in the API and dashboard. It is suitable as a working educational prototype, not as an autonomous production reliability platform.
