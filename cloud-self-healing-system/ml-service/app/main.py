from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
import os
import logging
import networkx as nx
import joblib
import pandas as pd

app = FastAPI(title='AI Self-Healing ML Service')

MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'isolation_forest.joblib')
FEATURE_COLUMNS = ['cpuUsage', 'memoryUsage', 'requestRate', 'latencyMs', 'errorRate', 'dbConnections']
logger = logging.getLogger(__name__)

try:
    model = joblib.load(MODEL_PATH)
except (OSError, ValueError, EOFError) as error:
    logger.warning('Isolation Forest unavailable; rule-based detection will be used: %s', error)
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
    totalRequests: Optional[int] = None
    successfulRequests: Optional[int] = None
    failedRequests: Optional[int] = None
    activeRequests: Optional[int] = None
    requestsLastMinute: Optional[int] = None
    requestsPerSecond: Optional[float] = None
    averageLatencyMs: Optional[float] = None
    p95LatencyMs: Optional[float] = None
    dbActiveConnections: Optional[int] = None
    dbWaitingRequests: Optional[int] = None
    dbAverageQueryLatencyMs: Optional[float] = None
    dbErrorRate: Optional[float] = None


def value(payload: MLInput, field: str, default: float = 0.0) -> float:
    current = getattr(payload, field)
    return default if current is None else float(current)


def request_rate(payload: MLInput) -> float:
    if payload.requestsPerSecond is not None:
        return value(payload, 'requestsPerSecond')
    if payload.requestRate is not None:
        return value(payload, 'requestRate')
    return value(payload, 'requestsLastMinute') / 60


def service_latency(payload: MLInput) -> float:
    return value(payload, 'averageLatencyMs', value(payload, 'latencyMs'))


def service_error_rate(payload: MLInput) -> float:
    return value(payload, 'errorRate')


def database_is_overloaded(payload: MLInput) -> bool:
    return (
        value(payload, 'dbActiveConnections') >= 18
        or value(payload, 'dbWaitingRequests') > 0
        or value(payload, 'dbAverageQueryLatencyMs') >= 500
        or value(payload, 'dbErrorRate') >= 5
        or value(payload, 'dbConnections') > 95
    )


def compute_rule_based_score(payload: MLInput) -> float:
    score = 0.0
    score += min(value(payload, 'cpuUsage') / 100, 1.0) * 0.15
    score += min(value(payload, 'memoryUsage') / 100, 1.0) * 0.08
    score += min(request_rate(payload) / 200, 1.0) * 0.18
    score += min(service_latency(payload) / 2000, 1.0) * 0.12
    score += min(value(payload, 'p95LatencyMs') / 3000, 1.0) * 0.08
    score += min(service_error_rate(payload) / 10, 1.0) * 0.12
    score += min(value(payload, 'dbActiveConnections') / 20, 1.0) * 0.07
    score += min(value(payload, 'dbWaitingRequests') / 5, 1.0) * 0.05
    score += min(value(payload, 'dbAverageQueryLatencyMs') / 1000, 1.0) * 0.05
    score += min(value(payload, 'dbErrorRate') / 10, 1.0) * 0.05
    score += min(value(payload, 'probeLatencyMs') / 3000, 1.0) * 0.05
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
    if database_is_overloaded(payload):
        return 'database_bottleneck'
    if request_rate(payload) >= 100:
        return 'traffic_spike'
    if value(payload, 'cpuUsage') > 85:
        return 'cpu_overload'
    if value(payload, 'memoryUsage') > 80:
        return 'memory_leak'
    if value(payload, 'probeFailures') > 0 or value(payload, 'probeLatencyMs') > 1500:
        return 'health_probe_failure'
    if service_latency(payload) > 1500:
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
            'cpuUsage': value(payload, 'cpuUsage'),
            'memoryUsage': value(payload, 'memoryUsage'),
            'requestRate': request_rate(payload),
            'latencyMs': service_latency(payload),
            'errorRate': service_error_rate(payload),
            'dbConnections': value(payload, 'dbActiveConnections', value(payload, 'dbConnections'))
        }], columns=FEATURE_COLUMNS)
        model_anomaly = int(model.predict(feature_row)[0]) == -1

    model_signal = model_anomaly and score >= 0.35
    rule_anomaly = (
        score > 0.6
        or service_latency(payload) > 1200
        or service_error_rate(payload) > 3.0
        or request_rate(payload) >= 100
        or database_is_overloaded(payload)
        or value(payload, 'probeLatencyMs') > 1500
        or value(payload, 'probeFailures') > 0
        or value(payload, 'restartCount') > 0
        or payload.containerState in {'exited', 'dead', 'restarting', 'unavailable'}
    )
    is_anomaly = model_signal or rule_anomaly
    features = []
    if service_latency(payload) > 1200:
        features.append('averageLatencyMs')
    if service_error_rate(payload) > 3.0:
        features.append('errorRate')
    if request_rate(payload) >= 100:
        features.append('requestsLastMinute')
    if database_is_overloaded(payload):
        features.append('databaseTelemetry')
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
    failure_probability = min(0.95, round(max(score, 0.1) + (0.2 if service_latency(payload) > 1500 else 0.0) + (0.15 if value(payload, 'probeFailures') > 0 else 0.0), 2))
    risk = 'HIGH' if failure_probability > 0.7 else 'MEDIUM' if failure_probability > 0.4 else 'LOW'

    return {
        'service': payload.service,
        'failureProbability': failure_probability,
        'riskLevel': risk,
        'estimatedFailureWindow': 'Not calibrated',
        'reason': 'Heuristic risk score; this is not a calibrated time-to-failure prediction.'
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
    database_overloaded = database_is_overloaded(payload)
    root_cause_name = 'database' if database_overloaded else payload.service
    root_cause_type = 'database_bottleneck' if database_overloaded else classify_incident(payload)
    path = nx.shortest_path(graph, payload.service, 'database') if database_overloaded and payload.service in graph else [payload.service]
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
            f'Database pool telemetry indicates pressure (active={value(payload, "dbActiveConnections")}, waiting={value(payload, "dbWaitingRequests")}, query latency={value(payload, "dbAverageQueryLatencyMs")} ms)' if database_overloaded else f'Request rate {request_rate(payload):.2f}/sec and p95 latency {value(payload, "p95LatencyMs")} ms',
            f'{payload.service} average latency {service_latency(payload)} ms',
            'Affected services are inferred from the configured dependency graph'
        ]
    }


@app.post('/ml/summarize')
def summarize(payload: dict):
    incident_type = payload.get('incidentType') or payload.get('incident_type') or 'unknown'
    service = payload.get('service') or payload.get('service_name') or 'unknown service'
    recovery = payload.get('recoveryAction') or {}
    result = payload.get('recoveryResult') or {}
    status = result.get('status', 'pending')
    action = recovery.get('action') or 'no recovery action recorded'
    root_cause = payload.get('rootCause') or payload.get('root_cause') or 'not identified'
    summary = f'The {service} had a {incident_type}; the identified root cause was {root_cause}. '
    summary += f'Recovery action recorded: {action}. Recovery status: {status}.'
    return {'summary': summary}
