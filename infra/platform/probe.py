import json
import os
import urllib.error
import urllib.request

import boto3
from botocore.exceptions import BotoCoreError, ClientError


def collect(opener, ecs, origin, cluster, web_service, worker_service):
    status = 0
    ready = 0
    try:
        request = urllib.request.Request(
            origin + "/api/health", headers={"User-Agent": "OneDoorReadiness/1"}
        )
        with opener(request, timeout=8) as response:
            status = response.status
            payload = json.loads(response.read(4096))
            ready = int(status == 200 and payload == {"status": "ok"})
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
    except (OSError, ValueError):
        pass

    metrics = {
        "Ready": ready,
        "HttpStatus": status,
        "Heartbeat": 1,
    }
    try:
        services = ecs.describe_services(
            cluster=cluster, services=[web_service, worker_service]
        )
        counts = {service["serviceName"]: service["runningCount"] for service in services.get("services", [])}
        metrics.update(WebRunning=counts.get(web_service, 0),
                       WorkerRunning=counts.get(worker_service, 0), ECSCollectionSucceeded=1)
    except (BotoCoreError, ClientError):
        # Preserve HTTP readiness; an AWS API failure is not a measured task count.
        metrics["ECSCollectionSucceeded"] = 0
    return metrics


def handler(event, context):
    if event.get("source") == "aws.ecs" and event.get("detail", {}).get("eventName") == "SERVICE_DEPLOYMENT_FAILED":
        metrics = {"DeploymentFailed": 1}
    else:
        metrics = collect(
            opener=urllib.request.urlopen,
            ecs=boto3.client("ecs"),
            origin=os.environ["APP_ORIGIN"],
            cluster=os.environ["CLUSTER"],
            web_service=os.environ["WEB_SERVICE"],
            worker_service=os.environ["WORKER_SERVICE"],
        )
    boto3.client("cloudwatch").put_metric_data(
        Namespace="OneDoor/Deployment",
        MetricData=[
            {
                "MetricName": name,
                "Value": value,
                "Unit": "Count",
                "Dimensions": [{"Name": "Environment", "Value": os.environ["ENVIRONMENT"]}],
            }
            for name, value in metrics.items()
        ],
    )
    print(json.dumps(metrics))
    return metrics
