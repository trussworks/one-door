import base64
import gzip
import json
import os
from datetime import datetime, timezone
from urllib.parse import unquote
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
    return (headers.get("sec-fetch-mode") == "navigate"
            and headers.get("sec-fetch-dest") == "document"
            and bool(headers.get("cookie")))


def successful_entry(message):
    return (message.get("cs-method") == "POST"
            and message.get("cs-uri-stem") == "/api/session"
            and str(message.get("sc-status", "")).isdigit()
            and 200 <= int(message["sc-status"]) < 300)


def notice(group, entry, message):
    if group == os.environ["WAF_LOG_GROUP"] and browser_navigation(
            message, os.environ["APP_HOSTNAME"]):
        request = message["httpRequest"]
        return {
            "event": "signed-in page visit",
            "time": datetime.fromtimestamp(entry["timestamp"] / 1000, timezone.utc).isoformat(),
            "address": request["clientIp"],
            "country": request.get("country") or "Unavailable",
        }
    if group == os.environ["CLOUDFRONT_LOG_GROUP"] and successful_entry(message):
        return {
            "event": "demo code accepted",
            "time": message["date"] + "T" + message["time"] + "Z",
            "address": message["c-ip"],
            "country": "Unavailable",
        }
    return None


def handler(event, context):
    payload = json.loads(gzip.decompress(base64.b64decode(event["awslogs"]["data"])))
    if payload.get("messageType") == "CONTROL_MESSAGE":
        return {"activityRequests": 0}
    if payload.get("owner") != os.environ["ACCOUNT_ID"]:
        raise ValueError("Unexpected log account")
    group = payload.get("logGroup")
    if group not in (os.environ["WAF_LOG_GROUP"], os.environ["CLOUDFRONT_LOG_GROUP"]):
        raise ValueError("Unexpected log group")
    notices = []
    for entry in payload["logEvents"]:
        message = json.loads(entry["message"])
        detected = notice(group, entry, message)
        if detected:
            notices.append(detected)
    if notices:
        import boto3
        boto3.client("cloudwatch", region_name=os.environ["METRIC_REGION"]).put_metric_data(
            Namespace="OneDoor/Visits",
            MetricData=[{"MetricName": "LikelyVisitorActivity", "Value": len(notices), "Unit": "Count",
                         "Dimensions": [{"Name": "Environment", "Value": "truss"}]}],
        )
        lines = []
        for detected in notices:
            lines.extend(f"{name.title()}: {value}" for name, value in detected.items())
            lines.append("")
        published = boto3.client("sns", region_name=os.environ["METRIC_REGION"]).publish(
            TopicArn=os.environ["VISITOR_TOPIC_ARN"],
            Subject="One Door Truss visitor activity",
            Message="\n".join(lines).rstrip() + "\n",
        )
        if not published.get("MessageId"):
            raise RuntimeError("Visitor notification was not confirmed")
    # Request bodies, cookies, addresses and raw headers never reach this log.
    print(json.dumps({"activityRequests": len(notices)}))
    return {"activityRequests": len(notices)}
