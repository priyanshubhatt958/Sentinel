function buildTemplateSummary(incident) {
  const service = incident.service || incident.service_name || 'payment-service';
  const incidentType = incident.incidentType || incident.incident_type || 'traffic_spike';
  const rootCause = incident.rootCause || incident.root_cause || service;
  const action = incident.recoveryAction?.action || 'scale_service';
  const fromReplicas = incident.recoveryAction?.fromReplicas;
  const toReplicas = incident.recoveryAction?.toReplicas;
  const status = incident.recoveryResult?.status || incident.recovery_status || 'pending';
  const latencyBefore = incident.recoveryResult?.latencyBeforeMs;
  const latencyAfter = incident.recoveryResult?.latencyAfterMs;
  const replicaChange = Number.isFinite(Number(fromReplicas)) && Number.isFinite(Number(toReplicas))
    ? ` from ${fromReplicas} to ${toReplicas} replicas`
    : '';
  const latencyChange = Number.isFinite(Number(latencyBefore)) && Number.isFinite(Number(latencyAfter))
    ? ` Latency changed from ${latencyBefore} ms to ${latencyAfter} ms.`
    : '';

  return `The ${service} encountered a ${incidentType}; the likely root cause was ${rootCause}. The system applied ${action}${replicaChange}. Recovery status: ${status}.${latencyChange}`;
}

async function buildIncidentSummary(incident) {
  const enabled = process.env.GENAI_ENABLED === 'true';
  const apiKey = process.env.OPENAI_API_KEY;

  if (!enabled || !apiKey) {
    return buildTemplateSummary(incident);
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
            { role: 'system', content: 'Explain cloud incidents concisely. Distinguish observed evidence from inference and state the recovery outcome.' },
            { role: 'user', content: JSON.stringify(incident) }
          ],
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!response.ok) {
      throw new Error(`GenAI request failed with status ${response.status}.`);
    }

    const result = await response.json();
    const summary = result.choices?.[0]?.message?.content?.trim();
    return summary || buildTemplateSummary(incident);
  } catch (error) {
    console.warn(`GenAI summary unavailable: ${error.message}`);
    return buildTemplateSummary(incident);
  }
}

module.exports = { buildIncidentSummary, buildTemplateSummary };
