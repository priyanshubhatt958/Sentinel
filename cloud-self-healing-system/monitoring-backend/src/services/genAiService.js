const REPORT_FIELDS = [
  'executiveSummary',
  'whatHappened',
  'likelyRootCause',
  'evidence',
  'impact',
  'recoveryActionTaken',
  'recoveryResult',
  'remainingRisks',
  'recommendedNextSteps'
];
const logger = require('../utils/logger');

function asList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

function buildIncidentContext(incident = {}) {
  return {
    incidentId: incident.id ?? incident.incidentId ?? null,
    service: incident.service || incident.service_name || 'unknown',
    anomalyScore: incident.anomalyScore ?? incident.anomaly_score ?? null,
    riskLevel: incident.riskLevel || incident.risk_level || 'unknown',
    classification: incident.classification || incident.incidentType || incident.incident_type || 'unknown',
    failureProbability: incident.failureProbability ?? incident.failure_probability ?? null,
    rootCause: incident.rootCause || incident.root_cause || 'unknown',
    affectedServices: asList(incident.affectedServices || incident.affected_services),
    evidence: incident.evidence || [],
    metrics: incident.metrics || incident.latest_metrics || {},
    recoveryAction: incident.recoveryAction || null,
    recoveryResult: incident.recoveryResult || null,
    recoveryEffectiveness: incident.recoveryEffectiveness
      ?? incident.effectivenessScore
      ?? incident.recoveryResult?.effectivenessScore
      ?? null,
    timeline: incident.timeline || []
  };
}

function buildTemplateReport(incident) {
  const context = buildIncidentContext(incident);
  const evidence = Array.isArray(context.evidence)
    ? context.evidence.map((item) => typeof item === 'string' ? item : JSON.stringify(item))
    : Object.entries(context.evidence || {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const action = context.recoveryAction
    ? `${context.recoveryAction.action || context.recoveryAction.action_type || 'action recorded'}`
      + `${context.recoveryAction.target || context.recoveryAction.target_service ? ` on ${context.recoveryAction.target || context.recoveryAction.target_service}` : ''}`
    : 'No recovery action has been recorded.';
  const result = context.recoveryResult || {};
  const recoveryStatus = result.status || result.recoveryStatus || 'pending';
  const score = context.recoveryEffectiveness;
  const recommendation = result.recommendation
    || incident.recovery_recommendation
    || 'Review the recovery timeline and confirm service health before closing the incident.';

  return {
    executiveSummary: `${context.classification} affected ${context.service}; recovery is ${recoveryStatus}.`,
    whatHappened: `The monitoring pipeline classified an incident on ${context.service} as ${context.classification}. The reported anomaly score is ${context.anomalyScore ?? 'unavailable'} and failure probability is ${context.failureProbability ?? 'unavailable'}.`,
    likelyRootCause: `The most likely root cause is ${context.rootCause}. This is a diagnosis based on collected telemetry, not a guarantee of causation.`,
    evidence: evidence.length ? evidence : ['No evidence details were recorded with this incident.'],
    impact: `Affected services: ${context.affectedServices.length ? context.affectedServices.join(', ') : context.service}. Risk level: ${context.riskLevel}.`,
    recoveryActionTaken: action,
    recoveryResult: `Status: ${recoveryStatus}. Effectiveness score: ${score === null ? 'not yet measurable' : `${score}/100`}.`,
    remainingRisks: recoveryStatus === 'recovered'
      ? 'Continue monitoring for recurrence; this verification covers the measured recovery window only.'
      : 'The incident is not fully verified as recovered. Monitor the service and investigate any persistent database or dependency symptoms.',
    recommendedNextSteps: recommendation
  };
}

function formatReport(report) {
  const titles = {
    executiveSummary: 'Executive summary',
    whatHappened: 'What happened',
    likelyRootCause: 'Likely root cause',
    evidence: 'Evidence',
    impact: 'Impact',
    recoveryActionTaken: 'Recovery action taken',
    recoveryResult: 'Recovery result',
    remainingRisks: 'Remaining risks',
    recommendedNextSteps: 'Recommended next steps'
  };
  return REPORT_FIELDS.map((field) => {
    const value = report[field];
    const body = Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : String(value || 'Not available.');
    return `${titles[field]}\n${body}`;
  }).join('\n\n');
}

function normalizeReport(value) {
  if (!value || typeof value !== 'object') return null;
  const report = {};
  for (const field of REPORT_FIELDS) {
    const entry = value[field];
    if (field === 'evidence') {
      report[field] = asList(entry);
    } else if (typeof entry === 'string' && entry.trim()) {
      report[field] = entry.trim();
    } else {
      return null;
    }
  }
  return report;
}

function parseReport(content) {
  if (typeof content !== 'string') return null;
  const json = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return normalizeReport(JSON.parse(json));
  } catch {
    return null;
  }
}

async function buildIncidentSummaryResult(incident) {
  const fallbackReport = buildTemplateReport(incident);
  const enabled = process.env.GENAI_ENABLED === 'true';
  const apiKey = process.env.GENAI_API_KEY || process.env.OPENAI_API_KEY;

  if (!enabled || !apiKey) {
    return { summary: formatReport(fallbackReport), report: fallbackReport, source: 'fallback' };
  }

  try {
    const response = await fetch(
      process.env.GENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.GENAI_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `Return only a JSON object with these string fields: ${REPORT_FIELDS.join(', ')}. The evidence field must be an array of strings. Explain observed facts separately from inference, use only supplied incident data, and do not claim recovery succeeded unless the result says recovered.`
            },
            { role: 'user', content: JSON.stringify(buildIncidentContext(incident)) }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) throw new Error(`GenAI request failed with status ${response.status}.`);
    const result = await response.json();
    const report = parseReport(result.choices?.[0]?.message?.content);
    if (!report) throw new Error('GenAI response did not contain the required incident report fields.');
    return { summary: formatReport(report), report, source: 'genai' };
  } catch (error) {
    logger.warn('genai_summary_fallback', { message: error.message });
    return { summary: formatReport(fallbackReport), report: fallbackReport, source: 'fallback' };
  }
}

async function buildIncidentSummary(incident) {
  return (await buildIncidentSummaryResult(incident)).summary;
}

function buildTemplateSummary(incident) {
  return formatReport(buildTemplateReport(incident));
}

module.exports = {
  buildIncidentSummary,
  buildIncidentSummaryResult,
  buildIncidentContext,
  buildTemplateReport,
  buildTemplateSummary,
  formatReport,
  REPORT_FIELDS
};
