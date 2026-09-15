import base64
import gzip
import json
import os
from urllib.parse import unquote, urlsplit
from uuid import UUID


PAGES = {
    "/", "/my", "/new", "/requests", "/review", "/dashboard", "/reports",
    "/catalog", "/catalog/new", "/sources", "/sources/new",
    "/admin/demo", "/admin/requests",
}
DETAILS = {
    "/request", "/review", "/work-items", "/observations", "/conflicts",
    "/catalog", "/sources", "/admin/requests",
}


def application_page(uri):
    path = unquote(uri).rstrip("/") or "/"
    if path in PAGES:
        return True
    prefix, _, identifier = path.rpartition("/")
    if prefix not in DETAILS:
        return False
    try:
        return str(UUID(identifier)) == identifier.lower()
    except ValueError:
        return False


def browser_navigation(message, hostname):
    request = message.get("httpRequest", {})
    if (message.get("action") != "ALLOW" or request.get("httpMethod") != "GET"
            or request.get("host") != hostname
            or not application_page(request.get("uri", ""))):
        return False
    headers = {h["name"].lower(): h["value"] for h in request.get("headers", [])}
    agent = headers.get("user-agent", "").lower()
    if not any(browser in agent for browser in ("chrome/", "firefox/", "safari/")):
        return False
    if any(bot in agent for bot in ("bot", "spider", "crawler", "headless", "playwright")):
        return False
    if ("next-router-prefetch" in headers
            or "prefetch" in headers.get("purpose", "").lower()
            or "prefetch" in headers.get("sec-purpose", "").lower()):
        return False
    if (headers.get("sec-fetch-mode") == "navigate"
            and headers.get("sec-fetch-dest") == "document"):
        return True
    # Client-side navigation fetches a component without loading a new document.
    return (headers.get("rsc") == "1" and bool(headers.get("cookie"))
            and headers.get("sec-fetch-site") == "same-origin"
            and urlsplit(headers.get("referer", "")).hostname == hostname)


def successful_action(message):
    return (message.get("cs-method") in {"POST", "PUT", "PATCH", "DELETE"}
            and message.get("cs-uri-stem", "").startswith("/api/")
            and str(message.get("sc-status", "")).isdigit()
            and 200 <= int(message["sc-status"]) < 300)


def handler(event, context):
    payload = json.loads(gzip.decompress(base64.b64decode(event["awslogs"]["data"])))
    if payload.get("messageType") == "CONTROL_MESSAGE":
        return {"activityRequests": 0}
    if payload.get("owner") != os.environ["ACCOUNT_ID"]:
        raise ValueError("Unexpected log account")
    group = payload.get("logGroup")
    if group not in (os.environ["WAF_LOG_GROUP"], os.environ["CLOUDFRONT_LOG_GROUP"]):
        raise ValueError("Unexpected log group")
    count = 0
    for entry in payload["logEvents"]:
        message = json.loads(entry["message"])
        count += (successful_action(message) if group == os.environ["CLOUDFRONT_LOG_GROUP"]
                  else browser_navigation(message, os.environ["APP_HOSTNAME"]))
    if count:
        import boto3
        boto3.client("cloudwatch", region_name=os.environ["METRIC_REGION"]).put_metric_data(
            Namespace="OneDoor/Visits",
            MetricData=[{"MetricName": "LikelyVisitorActivity", "Value": count, "Unit": "Count",
                         "Dimensions": [{"Name": "Environment", "Value": "truss"}]}],
        )
    # Request bodies, cookies, addresses and raw headers never reach this log.
    print(json.dumps({"activityRequests": count}))
    return {"activityRequests": count}
