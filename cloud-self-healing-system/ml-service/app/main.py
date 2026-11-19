from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
import os
import networkx as nx
import joblib
import pandas as pd

app = FastAPI(title='AI Self-Healing ML Service')

MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'isolation_forest.joblib')
FEATURE_COLUMNS = ['cpuUsage', 'memoryUsage', 'requestRate', 'latencyMs', 'errorRate', 'dbConnections']

try:
    model = joblib.load(MODEL_PATH)
except Exception:
    model = None

class MLInput(BaseModel):
    service: str
    cpuUsage: Optional[float] = None
    memoryUsage: Optional[float] = None
    requestRate: Optional[float] = None
    latencyMs: Optional[float] = None
    errorRate: Optional[float] = None
    dbConnections: Optional[float] = None
    probeLatencyMs: Optional[float] = None
    probeFailures: Optional[int] = None
    restartCount: Optional[int] = None
    containerState: Optional[str] = None


def value(payload: MLInput, field: str, default: float = 0.0) -> float:
    current = getattr(payload, field)
    return default if current is None else float(current)


def compute_rule_based_score(payload: MLInput) -> float:
    score = 0.0
    score += min(value(payload, 'cpuUsage') / 100, 1.0) * 0.25
    score += min(value(payload, 'memoryUsage') / 100, 1.0) * 0.15
    score += min(value(payload, 'latencyMs') / 3000, 1.0) * 0.2
    score += min(value(payload, 'errorRate') / 10, 1.0) * 0.15
    score += min(value(payload, 'dbConnections') / 100, 1.0) * 0.1
    score += min(value(payload, 'probeLatencyMs') / 3000, 1.0) * 0.1
    score += min(value(payload, 'probeFailures') / 5, 1.0) * 0.05
    return round(min(score, 1.0), 3)


def build_graph() -> nx.DiGraph:
    graph = nx.DiGraph()
    graph.add_edges_from([
        ('user-service', 'order-service'),
        ('order-service', 'payment-service'),
        ('payment-service', 'database')
    ])
    return graph


def classify_incident(payload: MLInput) -> str:
    if value(payload, 'dbConnections') > 95:
        return 'database_bottleneck'
    if value(payload, 'requestRate') > 2500:
        return 'traffic_spike'
    if value(payload, 'cpuUsage') > 85:
        return 'cpu_overload'
    if value(payload, 'memoryUsage') > 80:
        return 'memory_leak'
    if value(payload, 'probeFailures') > 0 or value(payload, 'probeLatencyMs') > 1500:
        return 'health_probe_failure'
    if value(payload, 'latencyMs') > 1500:
        return 'network_failure'
    return 'unknown'


@app.get('/ml/health')
def health():
    return {'status': 'ok', 'service': 'ml-service'}


@app.post('/ml/detect')
def detect(payload: MLInput):
    score = compute_rule_based_score(payload)
    model_anomaly = False
    if model is not None:
        feature_row = pd.DataFrame([{
            column: value(payload, column) for column in FEATURE_COLUMNS
        }], columns=FEATURE_COLUMNS)
        model_anomaly = int(model.predict(feature_row)[0]) == -1

    model_signal = model_anomaly and score >= 0.35
    rule_anomaly = (
        score > 0.6
        or value(payload, 'latencyMs') > 1200
        or value(payload, 'errorRate') > 3.0
        or value(payload, 'probeLatencyMs') > 1500
        or value(payload, 'probeFailures') > 0
        or value(payload, 'restartCount') > 0
        or payload.containerState in {'exited', 'dead', 'restarting', 'unavailable'}
    )
    is_anomaly = model_signal or rule_anomaly
    features = []
    if value(payload, 'latencyMs') > 1200:
        features.append('latencyMs')
    if value(payload, 'errorRate') > 3.0:
        features.append('errorRate')
    if value(payload, 'dbConnections') > 80:
        features.append('dbConnections')
    if value(payload, 'cpuUsage') > 80:
        features.append('cpuUsage')
    if value(payload, 'probeLatencyMs') > 1500:
        features.append('probeLatencyMs')
    if value(payload, 'probeFailures') > 0:
        features.append('probeFailures')
    if value(payload, 'restartCount') > 0:
        features.append('restartCount')
    if payload.containerState in {'exited', 'dead', 'restarting', 'unavailable'}:
        features.append('containerState')
    if not features:
        features = ['latencyMs']

    return {
        'service': payload.service,
        'anomaly': bool(is_anomaly),
        'anomalyScore': round(max(score, 0.7 if model_signal else 0.5 if is_anomaly else 0.1), 2),
        'contributingFeatures': features[:3],
        'detectedBy': [
            name for name, detected in [('isolation_forest', model_signal), ('rules', rule_anomaly)] if detected
        ]
    }


@app.post('/ml/predict')
def predict(payload: MLInput):
    score = compute_rule_based_score(payload)
    failure_probability = min(0.95, round(max(score, 0.1) + (0.2 if value(payload, 'latencyMs') > 1500 else 0.0) + (0.15 if value(payload, 'probeFailures') > 0 else 0.0), 2))
    risk = 'HIGH' if failure_probability > 0.7 else 'MEDIUM' if failure_probability > 0.4 else 'LOW'

    return {
        'service': payload.service,
        'failureProbability': failure_probability,
        'riskLevel': risk,
        'estimatedFailureWindow': '10 minutes',
        'reason': 'High CPU usage, increasing latency, and high database-connection usage detected'
    }


@app.post('/ml/classify')
def classify(payload: MLInput):
    incident_type = classify_incident(payload)
    return {
        'service': payload.service,
        'incidentType': incident_type,
        'confidence': 0.9 if incident_type != 'unknown' else 0.35,
        'classificationReason': f'Classification matched the {incident_type} threshold pattern.'
    }


@app.post('/ml/root-cause')
def root_cause(payload: MLInput):
    graph = build_graph()
    database_overloaded = value(payload, 'dbConnections') > 95
    root_cause_name = 'database' if database_overloaded else payload.service
    root_cause_type = 'database_bottleneck' if database_overloaded else classify_incident(payload)
    path = nx.shortest_path(graph, payload.service, 'database') if database_overloaded else [payload.service]
    dependent_services = {
        'payment-service': ['payment-service', 'order-service', 'user-service'],
        'order-service': ['order-service', 'user-service'],
        'user-service': ['user-service']
    }
    affected = ['payment-service', 'order-service', 'user-service'] if database_overloaded else dependent_services.get(payload.service, [payload.service])

    return {
        'rootCause': root_cause_name,
        'rootCauseType': root_cause_type,
        'affectedServices': affected,
        'propagationPath': path,
        'evidence': [
            'Database connections above 95%' if database_overloaded else 'User traffic spike increased request rate',
            'Payment service latency increased',
            'Order service affected due to dependency'
        ]
    }


@app.post('/ml/summarize')
def summarize(payload: dict):
    incident_type = payload.get('incidentType', 'traffic_spike')
    service = payload.get('service', 'payment-service')
    recovery = payload.get('recoveryAction', {})
    result = payload.get('recoveryResult', {})
    status = result.get('status', 'recovered')
    summary = (
        f'The {service} experienced elevated latency and error rates due to a {incident_type}. '
        f'The system predicted a high probability of failure and applied a {recovery.get("action", "scale_service")} '
        f'from {recovery.get("fromReplicas", 2)} to {recovery.get("toReplicas", 5)} replicas. '
        f'After recovery, latency and error rate decreased, indicating {status}.'
    )
    return {'summary': summary}
