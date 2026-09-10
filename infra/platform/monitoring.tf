resource "aws_kms_key" "alerts" {
  description             = "One Door encrypted alert notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }, Action = "kms:*", Resource = "*" },
      { Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = ["kms:GenerateDataKey*", "kms:Decrypt"], Resource = "*", Condition = { StringEquals = { "aws:SourceAccount" = var.account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:cloudwatch:${var.region}:${var.account_id}:alarm:${local.name}-*" } } }
    ]
  })
  lifecycle { prevent_destroy = true }
}
resource "aws_kms_alias" "alerts" {
  name          = "alias/${local.name}-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
}
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "AccountAdministration", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }, Action = ["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:AddPermission", "sns:RemovePermission", "sns:Publish", "sns:Subscribe", "sns:ListSubscriptionsByTopic"], Resource = aws_sns_topic.alerts.arn },
      { Sid = "DeploymentAlarms", Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alerts.arn, Condition = { StringEquals = { "aws:SourceAccount" = var.account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:cloudwatch:${var.region}:${var.account_id}:alarm:${local.name}-*" } } }
    ]
  })
}
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
resource "aws_iam_role" "probe" {
  name               = "${local.name}-probe"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }] })
}
resource "aws_iam_role_policy" "probe" {
  role = aws_iam_role.probe.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.app["probe"].arn}:*" },
      { Effect = "Allow", Action = "ecs:DescribeServices", Resource = ["arn:aws:ecs:${var.region}:${var.account_id}:service/${local.name}/${local.name}-web", "arn:aws:ecs:${var.region}:${var.account_id}:service/${local.name}/${local.name}-worker"] },
      { Effect = "Allow", Action = "cloudwatch:PutMetricData", Resource = "*", Condition = { StringEquals = { "cloudwatch:namespace" = "OneDoor/Deployment" } } }
    ]
  })
}
data "archive_file" "probe" {
  type        = "zip"
  source_file = "${path.module}/probe.py"
  output_path = "${path.module}/probe.zip"
}
resource "aws_lambda_function" "probe" {
  function_name    = "${local.name}-probe"
  role             = aws_iam_role.probe.arn
  filename         = data.archive_file.probe.output_path
  source_code_hash = data.archive_file.probe.output_base64sha256
  handler          = "probe.handler"
  runtime          = "python3.13"
  timeout          = 25
  memory_size      = 128
  # A reservation requires 100 unreserved regional slots; this account has ten.
  # The private minute schedule and short execution budget bound this probe.
  reserved_concurrent_executions = -1
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.app["probe"].name
  }
  environment {
    variables = {
      APP_ORIGIN     = local.app_origin
      CLUSTER        = aws_ecs_cluster.app.name
      WEB_SERVICE    = "${local.name}-web"
      WORKER_SERVICE = "${local.name}-worker"
      ENVIRONMENT    = var.environment
    }
  }
  depends_on = [aws_iam_role_policy.probe]
}
resource "aws_cloudwatch_event_rule" "probe" {
  name                = "${local.name}-probe"
  schedule_expression = "rate(1 minute)"
}
resource "aws_cloudwatch_event_target" "probe" {
  rule      = aws_cloudwatch_event_rule.probe.name
  arn       = aws_lambda_function.probe.arn
  target_id = "readiness"
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 2
  }
}
resource "aws_lambda_function_event_invoke_config" "probe" {
  function_name                = aws_lambda_function.probe.function_name
  maximum_event_age_in_seconds = 60
  maximum_retry_attempts       = 0
}
resource "aws_lambda_permission" "probe" {
  statement_id  = "ScheduledProbe"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.probe.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.probe.arn
}
resource "aws_cloudwatch_metric_alarm" "deployment" {
  for_each = {
    readiness     = { metric = "Ready", threshold = 1 },
    probe-missing = { metric = "Heartbeat", threshold = 1 },
    ecs-api       = { metric = "ECSCollectionSucceeded", threshold = 1 },
    web-count     = { metric = "WebRunning", threshold = 2 },
    worker-count  = { metric = "WorkerRunning", threshold = 2 }
  }
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "One Door readiness through CloudFront and ECS service count"
  namespace           = "OneDoor/Deployment"
  metric_name         = each.value.metric
  dimensions          = { Environment = var.environment }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = each.value.threshold
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "worker" {
  for_each = {
    queue-age            = { metric = "OldestQueuedAgeSeconds", threshold = 180, comparison = "GreaterThanThreshold", statistic = "Maximum", missing = "breaching" },
    worker-heartbeat     = { metric = "Heartbeat", threshold = 1, comparison = "LessThanThreshold", statistic = "Maximum", missing = "breaching" },
    worker-failures      = { metric = "JobsFailed", threshold = 0, comparison = "GreaterThanThreshold", statistic = "Sum", missing = "notBreaching" },
    worker-poll-errors   = { metric = "WorkerPollErrors", threshold = 0, comparison = "GreaterThanThreshold", statistic = "Sum", missing = "notBreaching" },
    worker-queue-metrics = { metric = "QueueCollectionSucceeded", threshold = 1, comparison = "LessThanThreshold", statistic = "Minimum", missing = "notBreaching" }
  }
  alarm_name          = "${local.name}-${each.key}"
  namespace           = "OneDoor/Worker"
  metric_name         = each.value.metric
  dimensions          = { Environment = var.environment, Service = "one-door-worker" }
  statistic           = each.value.statistic
  period              = 180
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = each.value.missing
  # A worker fault clears once the database answers again, so the recipient is
  # told about the recovery as well as the fault.
  actions_enabled = var.alarm_actions_enabled
  alarm_actions   = [aws_sns_topic.alerts.arn]
  ok_actions      = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "database" {
  for_each = {
    database-storage     = { metric = "FreeStorageSpace", threshold = 4294967296, comparison = "LessThanThreshold" },
    database-memory      = { metric = "FreeableMemory", threshold = 268435456, comparison = "LessThanThreshold" },
    database-connections = { metric = "DatabaseConnections", threshold = 55, comparison = "GreaterThanThreshold" }
  }
  alarm_name          = "${local.name}-${each.key}"
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBInstanceIdentifier = aws_db_instance.app.identifier }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 3
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = "missing"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_event_rule" "deployment_failed" {
  name = "${local.name}-deployment-failed"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Deployment State Change"]
    resources   = [{ prefix = "arn:aws:ecs:${var.region}:${var.account_id}:service/${local.name}/" }]
    detail      = { eventName = ["SERVICE_DEPLOYMENT_FAILED"] }
  })
}
resource "aws_cloudwatch_event_target" "deployment_failed" {
  rule      = aws_cloudwatch_event_rule.deployment_failed.name
  arn       = aws_lambda_function.probe.arn
  target_id = "notify"
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 2
  }
}
resource "aws_lambda_permission" "deployment_failed" {
  statement_id  = "DeploymentFailure"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.probe.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.deployment_failed.arn
}
resource "aws_cloudwatch_metric_alarm" "deployment_failed" {
  alarm_name          = "${local.name}-deployment-failed"
  namespace           = "OneDoor/Deployment"
  metric_name         = "DeploymentFailed"
  dimensions          = { Environment = var.environment }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
locals {
  # A shared account charges everyone's work to an unfiltered budget, so a
  # project budget needs the tag filter; personal keeps the whole account.
  budget_scope   = var.budget_cost_tag != "" ? "project" : "personal-account"
  budget_limit   = coalesce(var.budget_limit_usd, "65")
  budget_warning = coalesce(var.budget_warning_usd, "50")
}
resource "aws_budgets_budget" "app" {
  provider     = aws.global
  name         = "${local.name}-${local.budget_scope}"
  budget_type  = "COST"
  limit_amount = local.budget_limit
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  dynamic "cost_filter" {
    for_each = var.budget_cost_tag == "" ? [] : [var.budget_cost_tag]
    content {
      name = "TagKeyValue"
      # AWS spells a tag filter user:KEY$VALUE; format keeps the dollar
      # literal, and the value comes from the tag the resources actually carry.
      values = [format("user:%s$%s", cost_filter.value, local.default_tags[cost_filter.value])]
    }
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = tonumber(local.budget_warning)
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = tonumber(local.budget_limit)
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}
