locals {
  visitor_alerts_enabled = var.environment == "truss"
  visitor_log_sources = local.visitor_alerts_enabled ? {
    cloudfront = {
      name    = aws_cloudwatch_log_group.cloudfront.name
      arn     = aws_cloudwatch_log_group.cloudfront.arn
      pattern = "{ ($.cs-method = \"POST\" || $.cs-method = \"PUT\" || $.cs-method = \"PATCH\" || $.cs-method = \"DELETE\") && $.cs-uri-stem = \"/api/*\" && $.sc-status = \"2*\" }"
    }
    waf = {
      name    = aws_cloudwatch_log_group.waf.name
      arn     = aws_cloudwatch_log_group.waf.arn
      pattern = "{ $.action = \"ALLOW\" && $.httpRequest.uri != \"/api/health\" }"
    }
  } : {}
}

resource "aws_cloudwatch_log_group" "visitor_activity" {
  count             = local.visitor_alerts_enabled ? 1 : 0
  provider          = aws.global
  name              = "/one-door/${var.environment}/visitor-activity"
  retention_in_days = 30
}

resource "aws_iam_role" "visitor_activity" {
  count = local.visitor_alerts_enabled ? 1 : 0
  name  = "${local.name}-visitor-activity"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "visitor_activity" {
  count = local.visitor_alerts_enabled ? 1 : 0
  role  = aws_iam_role.visitor_activity[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.visitor_activity[0].arn}:*" },
      {
        Effect = "Allow", Action = "cloudwatch:PutMetricData", Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "OneDoor/Visits", "aws:RequestedRegion" = var.region }
        }
      }
    ]
  })
}

data "archive_file" "visitor_activity" {
  count       = local.visitor_alerts_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/visitor_activity.py"
  output_path = "${path.module}/visitor_activity.zip"
}

resource "aws_lambda_function" "visitor_activity" {
  count            = local.visitor_alerts_enabled ? 1 : 0
  provider         = aws.global
  function_name    = "${local.name}-visitor-activity"
  role             = aws_iam_role.visitor_activity[0].arn
  filename         = data.archive_file.visitor_activity[0].output_path
  source_code_hash = data.archive_file.visitor_activity[0].output_base64sha256
  handler          = "visitor_activity.handler"
  runtime          = "python3.13"
  timeout          = 20
  memory_size      = 128
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.visitor_activity[0].name
  }
  environment {
    variables = {
      ACCOUNT_ID           = var.account_id
      APP_HOSTNAME         = var.app_hostname
      WAF_LOG_GROUP        = aws_cloudwatch_log_group.waf.name
      CLOUDFRONT_LOG_GROUP = aws_cloudwatch_log_group.cloudfront.name
      METRIC_REGION        = var.region
    }
  }
  depends_on = [aws_iam_role_policy.visitor_activity]
}

resource "aws_lambda_permission" "visitor_activity" {
  for_each       = local.visitor_log_sources
  provider       = aws.global
  statement_id   = "Logs-${each.key}"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.visitor_activity[0].function_name
  principal      = "logs.us-east-1.amazonaws.com"
  source_account = var.account_id
  source_arn     = "${each.value.arn}:*"
}

resource "aws_cloudwatch_log_subscription_filter" "visitor_activity" {
  for_each        = local.visitor_log_sources
  provider        = aws.global
  name            = "${local.name}-visitor-activity"
  log_group_name  = each.value.name
  filter_pattern  = each.value.pattern
  destination_arn = aws_lambda_function.visitor_activity[0].arn
  depends_on      = [aws_lambda_permission.visitor_activity]
}

resource "aws_cloudwatch_metric_alarm" "visitor_activity" {
  count               = local.visitor_alerts_enabled ? 1 : 0
  alarm_name          = "${local.name}-visitor-activity"
  alarm_description   = "Activity notice, not an outage: a likely browser navigation or successful demo action was logged. Prefetches, health checks and obvious scanners are excluded. Counts are requests, not unique people; authorized browser tests can also trigger this notice."
  namespace           = "OneDoor/Visits"
  metric_name         = "LikelyVisitorActivity"
  dimensions          = { Environment = var.environment }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = []
}
