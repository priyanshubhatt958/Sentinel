# Sentinel Viva Questions and Answers

1. **What problem does Sentinel address?**  
   It demonstrates how a microservice system can observe runtime behavior, identify anomalies, explain likely causes, execute constrained recovery, and verify measured improvement.

2. **What are the main components?**  
   PostgreSQL, user/order/payment services, a load generator, monitoring backend, FastAPI ML service, and React dashboard, all orchestrated by Compose.

3. **Why use Docker Compose?**  
   It gives a reproducible local network, startup order, health checks, persistent volumes, and fixed host ports without requiring a cluster.

4. **How is CPU usage collected?**  
   Docker CPU counters are compared across samples and normalized with system CPU counters and available CPUs.

5. **How is memory usage collected?**  
   Docker memory usage and limits are read; cache is subtracted where available to approximate working-set memory.

6. **Are request metrics simulated?**  
   No. Business middleware counts actual requests, response outcomes, active requests, and measured latency. Fault controls can add bounded delay or resource load.

7. **How is request rate calculated?**  
   The load generator and service telemetry use recent timestamp windows rather than a lifetime-average rate.

8. **How are database metrics collected?**  
   The services use a PostgreSQL pool and track actual query counts, outcomes, query latency, and pool connection/waiting counts.

9. **How is application data persisted?**  
   Users, orders, and payments are written to PostgreSQL; IDs are consistent integer keys and references use foreign keys.

10. **What does the ML service do?**  
    It detects anomalies, classifies incident types, estimates risk, and returns likely root cause/affected services.

11. **What is an Isolation Forest?**  
    It is an unsupervised anomaly detector that isolates unusual feature combinations through random partitions.

12. **Is the model trained on production data?**  
    No. This project trains the Isolation Forest using generated samples during image build; its output is not calibrated for production.

13. **How does rule-based detection complement the model?**  
    Threshold rules make expected local symptoms demonstrable and explainable, while the model supplies an additional anomaly signal.

14. **Is failure probability a guaranteed prediction?**  
    No. It is explicitly heuristic and has no calibrated time-to-failure estimate.

15. **How is root cause determined?**  
    The ML service considers measured signals and a configured dependency graph to report a likely root and propagation path.

16. **How are duplicate incidents controlled?**  
    Active incidents are updated and a service/type cooldown prevents rapid duplicate creation.

17. **What recovery actions can run?**  
    Only allowlisted application restarts and bounded payment-service scale-up are executable in the demo.

18. **Why is automatic recovery disabled by default?**  
    Docker control can disrupt services; explicit opt-in keeps the default safe and makes the demo operator-controlled.

19. **What happens for a database bottleneck?**  
    The system records that database-level remediation is required and skips an application restart that would not address the root cause.

20. **How does cooldown work?**  
    Each attempted action stores cooldown start/end. Identical actions are blocked while active, with per-incident and per-service/hour limits.

21. **What happens after repeated failures?**  
    Cooldown grows; after the retry limit, Sentinel marks manual intervention required and stops automated attempts.

22. **How is recovery verified?**  
    Fresh service metrics are collected after the action and compared with pre-action metrics across available CPU, memory, probes, latency, errors, and DB signals.

23. **What does the effectiveness score mean?**  
    It is the average of available normalized relative improvements on a 0–100 scale; it is a measured indicator, not proof that the action caused the change.

24. **What are the recovery status bands?**  
    80–100 recovered, 40–79 partially recovered, and 0–39 not recovered. Missing after metrics are pending; action failures are failed; unsafe decisions are skipped.

25. **What is stored in the recovery timeline?**  
    Timestamp, action and target, decision reason/confidence, status, before/after metrics, score, cooldown, errors, recommendation, and trigger source.

26. **What is GenAI used for?**  
    It optionally produces a structured explanatory report from incident data; it does not choose or execute recovery actions.

27. **What happens if GenAI is disabled or fails?**  
    A local deterministic report is generated and its source is marked `fallback`.

28. **What is simulated in this project?**  
    Bounded traffic delay, database delay/concurrency, temporary memory allocation, and worker-thread CPU activity are explicit fault injection.

29. **How does the system preserve data across restarts?**  
    PostgreSQL uses a named Docker volume, while schema initialization is idempotent and avoids deleting existing data.

30. **What are the main limitations and future improvements?**  
    Model calibration, production-grade authorization/approval, robust orchestration, broader component tests, and stronger deployment-level recovery remain future work.
