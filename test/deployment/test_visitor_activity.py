import base64
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load_visitor_activity():
    spec = importlib.util.spec_from_file_location(
        "visitor_activity",
        Path(__file__).parents[2] / "infra/platform/visitor_activity.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


visitor_activity = load_visitor_activity()


def waf_message(**headers):
    return {
        "action": "ALLOW",
        "httpRequest": {
            "httpMethod": "GET",
            "host": "one-door.sandbox.truss.coffee",
            "uri": "/review/08da46a7-a463-5b17-a589-8681f9c579ba",
            "headers": [{"name": name, "value": value} for name, value in headers.items()],
        },
    }


def event(log_group, *messages):
    payload = {
        "owner": "004351505091",
        "logGroup": log_group,
        "messageType": "DATA_MESSAGE",
        "logEvents": [
            {"id": str(index), "timestamp": index, "message": json.dumps(message)}
            for index, message in enumerate(messages)
        ],
    }
    data = base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode()
    return {"awslogs": {"data": data}}


class VisitorActivityTests(unittest.TestCase):
    def test_browser_navigation_excludes_prefetches_and_scanners(self):
        navigation = waf_message(
            **{
                "user-agent": "Mozilla/5.0 Firefox/153.0",
                "sec-fetch-mode": "navigate",
                "sec-fetch-dest": "document",
                "sec-fetch-user": "?1",
            }
        )
        self.assertTrue(
            visitor_activity.browser_navigation(
                navigation, "one-door.sandbox.truss.coffee"
            )
        )
        navigation["httpRequest"]["headers"].append(
            {"name": "next-router-prefetch", "value": "1"}
        )
        self.assertFalse(
            visitor_activity.browser_navigation(
                navigation, "one-door.sandbox.truss.coffee"
            )
        )
        navigation["httpRequest"]["uri"] = "/.env"
        self.assertFalse(
            visitor_activity.browser_navigation(
                navigation, "one-door.sandbox.truss.coffee"
            )
        )

    def test_successful_application_writes_are_activity(self):
        self.assertTrue(
            visitor_activity.successful_action(
                {
                    "cs-method": "POST",
                    "cs-uri-stem": "/api/session",
                    "sc-status": "200",
                }
            )
        )
        self.assertFalse(
            visitor_activity.successful_action(
                {
                    "cs-method": "POST",
                    "cs-uri-stem": "/api/session",
                    "sc-status": "401",
                }
            )
        )

    def test_handler_publishes_only_a_count(self):
        calls = []
        cloudwatch = SimpleNamespace(
            put_metric_data=lambda **arguments: calls.append(arguments)
        )
        sdk = SimpleNamespace(client=lambda *args, **kwargs: cloudwatch)
        navigation = waf_message(
            **{
                "user-agent": "Mozilla/5.0 Chrome/140.0",
                "sec-fetch-mode": "navigate",
                "sec-fetch-dest": "document",
                "sec-fetch-user": "?1",
            }
        )
        environment = {
            "ACCOUNT_ID": "004351505091",
            "APP_HOSTNAME": "one-door.sandbox.truss.coffee",
            "WAF_LOG_GROUP": "waf",
            "CLOUDFRONT_LOG_GROUP": "cloudfront",
            "METRIC_REGION": "us-west-2",
        }
        output = io.StringIO()
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.dict(sys.modules, {"boto3": sdk}),
            patch("sys.stdout", output),
        ):
            result = visitor_activity.handler(event("waf", navigation), None)
        self.assertEqual(result, {"activityRequests": 1})
        self.assertEqual(calls[0]["MetricData"][0]["Value"], 1)
        self.assertEqual(json.loads(output.getvalue()), {"activityRequests": 1})
        self.assertNotIn("httpRequest", output.getvalue())


if __name__ == "__main__":
    unittest.main()
