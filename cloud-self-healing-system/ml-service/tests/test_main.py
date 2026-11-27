import unittest

from app.main import MLInput, classify_incident, database_is_overloaded, request_rate, summarize


class MLServiceTests(unittest.TestCase):
    def test_request_rate_uses_measured_one_second_rate(self):
        payload = MLInput(service='payment-service', requestsPerSecond=120, requestsLastMinute=500)
        self.assertEqual(request_rate(payload), 120)
        self.assertEqual(classify_incident(payload), 'traffic_spike')

    def test_database_query_pressure_is_classified_from_live_telemetry(self):
        payload = MLInput(service='payment-service', dbAverageQueryLatencyMs=700)
        self.assertTrue(database_is_overloaded(payload))
        self.assertEqual(classify_incident(payload), 'database_bottleneck')

    def test_summary_does_not_invent_recovery_actions_or_success(self):
        result = summarize({'service': 'payment-service', 'incidentType': 'database_bottleneck'})
        summary = result['summary']
        self.assertIn('no recovery action recorded', summary)
        self.assertIn('Recovery status: pending', summary)
        self.assertNotIn('applied', summary)


if __name__ == '__main__':
    unittest.main()
