output "deployment" {
  value = {
    account_id               = var.account_id
    region                   = var.region
    environment              = var.environment
    name                     = local.name
    cluster_arn              = aws_ecs_cluster.app.arn
    cluster_name             = aws_ecs_cluster.app.name
    subnet_ids               = aws_subnet.app[*].id
    web_security_group_id    = aws_security_group.web.id
    worker_security_group_id = aws_security_group.worker.id
    execution_role_arns      = { for key, role in aws_iam_role.execution : key => role.arn }
    task_role_arn            = aws_iam_role.task.arn
    log_groups               = { for key, log in aws_cloudwatch_log_group.app : key => log.name }
    database_host            = aws_db_instance.app.address
    database_identifier      = aws_db_instance.app.identifier
    database_key_arn         = aws_kms_key.data.arn
    admin_secret_arn         = aws_db_instance.app.master_user_secret[0].secret_arn
    secret_arns              = { for key, secret in aws_secretsmanager_secret.app : key => secret.arn }
    target_group_arn         = aws_lb_target_group.web.arn
    app_origin               = local.app_origin
    distribution_id          = aws_cloudfront_distribution.app.id
    assets_bucket            = aws_s3_bucket.assets.id
    repository_url           = "${var.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.name}"
    alerts_topic_arn         = aws_sns_topic.alerts.arn
    readiness_alarm          = aws_cloudwatch_metric_alarm.deployment["readiness"].alarm_name
  }
}
