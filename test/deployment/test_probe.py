import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

sys.modules.setdefault("boto3", SimpleNamespace())
sys.modules.setdefault("botocore.exceptions", SimpleNamespace(BotoCoreError=OSError, ClientError=RuntimeError))
spec = importlib.util.spec_from_file_location("probe", Path(__file__).parents[2] / "infra/platform/probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Response:
    status = 200

    def __init__(self, payload):
        self.body = json.dumps(payload).encode()

    def read(self, size):
        return self.body[:size]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class ECS:
    def __init__(self, include_worker=True):
        self.include_worker = include_worker

    def describe_services(self, **args):
        services = [{"serviceName": "web", "runningCount": 2}]
        if self.include_worker:
            services.append({"serviceName": "worker", "runningCount": 2})
        return {"services": services}


class ProbeTests(unittest.TestCase):
    def test_actual_response_and_counts_are_required(self):
        result = probe.collect(lambda *a, **k: Response({"status": "ok"}), ECS(),
                               "https://example.cloudfront.net", "cluster", "web", "worker")
        self.assertEqual(result, {"Ready": 1, "HttpStatus": 200, "WebRunning": 2,
                                  "WorkerRunning": 2, "Heartbeat": 1, "ECSCollectionSucceeded": 1})

    def test_ecs_error_preserves_http_measurement(self):
        ecs = ECS()
        ecs.describe_services = lambda **args: (_ for _ in ()).throw(OSError("throttled"))
        result = probe.collect(lambda *a, **k: Response({"status": "ok"}), ecs,
                               "https://example.cloudfront.net", "cluster", "web", "worker")
        self.assertEqual(result["Ready"], 1)
        self.assertEqual(result["Heartbeat"], 1)
        self.assertEqual(result["ECSCollectionSucceeded"], 0)
        self.assertNotIn("WebRunning", result)

    def test_failure_event_publishes_metric_without_http_probe(self):
        published = []
        cloudwatch = SimpleNamespace(put_metric_data=lambda **args: published.append(args))
        with patch.object(probe.boto3, "client", return_value=cloudwatch, create=True), patch.dict(probe.os.environ, {"ENVIRONMENT": "personal"}):
            result = probe.handler({"source": "aws.ecs", "detail": {"eventName": "SERVICE_DEPLOYMENT_FAILED"}}, None)
        self.assertEqual(result, {"DeploymentFailed": 1})
        self.assertEqual(published[0]["MetricData"][0]["MetricName"], "DeploymentFailed")

    def test_failed_publish_is_not_reported_as_complete(self):
        def failed(**args):
            raise RuntimeError("unavailable")
        with patch.object(probe.boto3, "client", return_value=SimpleNamespace(put_metric_data=failed), create=True), patch.dict(probe.os.environ, {"ENVIRONMENT": "personal"}):
            with self.assertRaises(RuntimeError):
                probe.handler({"source": "aws.ecs", "detail": {"eventName": "SERVICE_DEPLOYMENT_FAILED"}}, None)

    def test_wrong_body_is_not_health(self):
        result = probe.collect(lambda *a, **k: Response({"status": "unavailable"}), ECS(),
                               "https://example.cloudfront.net", "cluster", "web", "worker")
        self.assertEqual(result["Ready"], 0)

    def test_waf_denial_is_reported_without_body(self):
        def denied(*args, **kwargs):
            raise urllib.error.HTTPError("https://example", 403, "blocked", {},
                                         io.BytesIO(b"private response"))
        result = probe.collect(denied, ECS(), "https://example.cloudfront.net", "cluster",
                               "web", "worker")
        self.assertEqual(result["HttpStatus"], 403)
        self.assertEqual(result["Ready"], 0)
        self.assertNotIn("private", json.dumps(result))

    def test_missing_worker_does_not_look_complete(self):
        result = probe.collect(lambda *a, **k: Response({"status": "ok"}), ECS(False),
                               "https://example.cloudfront.net", "cluster", "web", "worker")
        self.assertEqual(result["WorkerRunning"], 0)

    def test_network_error_is_not_healthy(self):
        def failed(*args, **kwargs):
            raise OSError("offline")
        result = probe.collect(failed, ECS(), "https://example.cloudfront.net", "cluster",
                               "web", "worker")
        self.assertEqual(result["Ready"], 0)
        self.assertEqual(result["Heartbeat"], 1)


if __name__ == "__main__":
    unittest.main()
