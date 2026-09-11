import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error


class FakeBotoCoreError(Exception):
    pass


class FakeClientError(Exception):
    pass


def load_probe():
    """Load probe.py with scoped SDK doubles; the module cache is restored
    afterward, so these tests neither depend on nor disturb any real SDK a
    maintainer's interpreter has already imported."""
    doubles = {
        "boto3": SimpleNamespace(),
        "botocore.exceptions": SimpleNamespace(
            BotoCoreError=FakeBotoCoreError, ClientError=FakeClientError
        ),
    }
    with patch.dict(sys.modules, doubles):
        spec = importlib.util.spec_from_file_location(
            "probe", Path(__file__).parents[2] / "infra/platform/probe.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


probe = load_probe()


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
        ecs.describe_services = Mock(side_effect=FakeBotoCoreError("throttled"))
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


class LoadProbeTests(unittest.TestCase):
    def test_loading_is_independent_of_prior_sdk_imports(self):
        # Absent SDK modules: loading works and leaves no doubles behind.
        with patch.dict(sys.modules):
            sys.modules.pop("boto3", None)
            sys.modules.pop("botocore.exceptions", None)
            fresh = load_probe()
            self.assertNotIn("boto3", sys.modules)
            self.assertNotIn("botocore.exceptions", sys.modules)
        # Preloaded distinct SDK modules: loading still binds the dedicated
        # fakes and restores the preloaded entries untouched.
        preloaded_boto3 = SimpleNamespace()
        preloaded_exceptions = SimpleNamespace(
            BotoCoreError=type("RealBotoCoreError", (Exception,), {}),
            ClientError=type("RealClientError", (Exception,), {}),
        )
        with patch.dict(
            sys.modules,
            {
                "boto3": preloaded_boto3,
                "botocore.exceptions": preloaded_exceptions,
            },
        ):
            loaded = load_probe()
            self.assertIs(sys.modules["boto3"], preloaded_boto3)
            self.assertIs(
                sys.modules["botocore.exceptions"], preloaded_exceptions
            )
        for module in (fresh, loaded):
            self.assertIs(module.BotoCoreError, FakeBotoCoreError)
            ecs = ECS()
            ecs.describe_services = Mock(
                side_effect=FakeBotoCoreError("throttled")
            )
            result = module.collect(
                lambda *a, **k: Response({"status": "ok"}), ecs,
                "https://example.cloudfront.net", "cluster", "web", "worker")
            self.assertEqual(result["ECSCollectionSucceeded"], 0)


if __name__ == "__main__":
    unittest.main()
