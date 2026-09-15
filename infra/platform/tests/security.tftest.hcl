override_resource {
  target          = aws_secretsmanager_secret.app["runtime"]
  override_during = plan
  values          = { arn = "arn:aws:secretsmanager:us-west-2:845191826742:secret:runtime-Example" }
}
override_resource {
  target          = aws_secretsmanager_secret.app["migration"]
  override_during = plan
  values          = { arn = "arn:aws:secretsmanager:us-west-2:845191826742:secret:migration-Example" }
}
override_resource {
  target          = aws_secretsmanager_secret.app["diagnostic"]
  override_during = plan
  values          = { arn = "arn:aws:secretsmanager:us-west-2:845191826742:secret:diagnostic-Example" }
}
override_resource {
  target          = aws_db_instance.app
  override_during = plan
  values          = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-west-2:845191826742:secret:administrator-Example" }] }
}
override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values          = { arn = "arn:aws:sns:us-west-2:845191826742:one-door-personal-alerts" }
}
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
}
mock_provider "aws" { alias = "global" }
override_data {
  target = data.aws_route53_zone.app[0]
  values = { zone_id = "ZF5E6T2ONJR1H", name = "sandbox.truss.coffee." }
}
variables {
  account_id              = "845191826742"
  region                  = "us-west-2"
  environment             = "personal"
  github_subject          = "repo:rswerve@8964335/one-door@1354631764:environment:personal"
  alert_email             = "biz@atighi.com"
  allow_legacy_viewer_tls = true
  alarm_actions_enabled   = true
}
run "private_and_recoverable" {
  command = plan
  assert {
    condition     = length(local.secret_access.verification) == 3 && !contains(local.secret_access.verification, aws_db_instance.app.master_user_secret[0].secret_arn) && contains(local.secret_access.verification, aws_secretsmanager_secret.app["runtime"].arn) && contains(local.secret_access.verification, aws_secretsmanager_secret.app["migration"].arn) && contains(local.secret_access.verification, aws_secretsmanager_secret.app["diagnostic"].arn)
    error_message = "Verification needs the three application database roles and must never inherit the administrator secret."
  }
  assert {
    condition = alltrue(concat(
      [for alarm in aws_cloudwatch_metric_alarm.deployment : alarm.actions_enabled],
      [for alarm in aws_cloudwatch_metric_alarm.worker : alarm.actions_enabled],
      [for alarm in aws_cloudwatch_metric_alarm.database : alarm.actions_enabled],
      [aws_cloudwatch_metric_alarm.deployment_failed.actions_enabled]
    )) && can(regex("(?m)^alarm_actions_enabled[[:space:]]*=[[:space:]]*true[[:space:]]*$", file("../environments/personal.platform.tfvars")))
    error_message = "Every personal application alarm must preserve its enabled notification actions."
  }
  assert {
    condition = alltrue(concat(
      [for alarm in aws_cloudwatch_metric_alarm.deployment : alarm.ok_actions == toset([aws_sns_topic.alerts.arn])],
      [for alarm in aws_cloudwatch_metric_alarm.worker : alarm.ok_actions == toset([aws_sns_topic.alerts.arn])]
    ))
    error_message = "Readiness and worker alarms must report recovery as well as failure; an operator told only about a fault cannot tell whether it cleared."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.worker["worker-poll-errors"].statistic == "Sum" && aws_cloudwatch_metric_alarm.worker["worker-poll-errors"].threshold == 0 && aws_cloudwatch_metric_alarm.worker["worker-queue-metrics"].statistic == "Minimum" && aws_cloudwatch_metric_alarm.worker["worker-queue-metrics"].threshold == 1
    error_message = "A healthy worker cannot mask a sibling's polling or telemetry failure."
  }
  assert {
    condition     = aws_cloudfront_distribution.app.ordered_cache_behavior[0].cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e58f6"
    error_message = "Retained static assets keep AWS's CachingOptimized policy."
  }
  assert {
    condition     = alltrue([for log in aws_cloudwatch_log_group.database : log.retention_in_days == 30]) && length(aws_cloudwatch_log_group.database) == 2
    error_message = "Both exported database log streams need an explicit retention limit."
  }
  assert {
    condition     = alltrue([for alarm in aws_cloudwatch_metric_alarm.database : alarm.dimensions.DBInstanceIdentifier == "one-door-personal"])
    error_message = "RDS alarm dimensions use the database identifier, not the provider's immutable db resource ID."
  }
  assert {
    condition     = one([for p in aws_db_parameter_group.app.parameter : p.value if p.name == "log_connections"]) == "all"
    error_message = "PostgreSQL 18 connection logging requires the enumerated value accepted by RDS."
  }
  assert {
    condition     = !contains(tolist(jsondecode(aws_sns_topic_policy.alerts.policy).Statement[0].Action), "sns:*")
    error_message = "SNS topic resource policies require supported topic actions."
  }
  assert {
    condition     = length(distinct([for s in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : s.Sid])) == length(jsondecode(aws_sns_topic_policy.alerts.policy).Statement)
    error_message = "SNS requires a unique statement ID for every policy grant."
  }
  assert {
    condition     = aws_db_instance.app.publicly_accessible == false && aws_db_instance.app.storage_encrypted && aws_db_instance.app.multi_az && aws_db_instance.app.deletion_protection && aws_db_instance.app.skip_final_snapshot == false && aws_db_instance.app.backup_retention_period >= 7
    error_message = "The database must be private, encrypted, redundant and protected from accidental loss."
  }
  assert {
    condition     = aws_lb.app.internal && aws_lb_target_group.web.target_type == "ip" && aws_lb_target_group.web.health_check[0].path == "/api/live"
    error_message = "The ALB must stay private and replace tasks using local health."
  }
  assert {
    condition     = alltrue([for subnet in aws_subnet.app : !subnet.map_public_ip_on_launch]) && length(aws_nat_gateway.app) == 2
    error_message = "Tasks cannot receive public addresses, and each AZ needs its own egress."
  }
  assert {
    condition     = aws_cloudfront_distribution.app.default_cache_behavior[0].cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" && aws_cloudfront_distribution.app.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && aws_cloudfront_distribution.app.ordered_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "Application responses must remain uncached and viewers must use HTTPS."
  }
  assert {
    condition     = aws_cloudfront_distribution.app.ordered_cache_behavior[0].path_pattern == "/_assets/*" && aws_cloudfront_origin_access_control.assets.signing_behavior == "always"
    error_message = "Retained release assets require a distinct, signed private S3 origin."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.deployment["probe-missing"].treat_missing_data == "breaching" && aws_lambda_function.probe.timeout < 60 && aws_cloudwatch_event_rule.probe.schedule_expression == "rate(1 minute)" && aws_lambda_permission.probe.principal == "events.amazonaws.com"
    error_message = "A dead probe cannot look healthy or scale without a bound."
  }
}
run "legacy_tls_requires_explicit_personal_exception" {
  command = plan
  variables { allow_legacy_viewer_tls = false }
  expect_failures = [aws_cloudfront_distribution.app]
}
run "personal_exception_cannot_reach_client_account" {
  command = plan
  variables {
    environment        = "truss"
    budget_cost_tag    = "Application"
    budget_limit_usd   = "40"
    budget_warning_usd = "30"
  }
  expect_failures = [aws_cloudfront_distribution.app]
}
run "relabeling_the_client_account_cannot_reuse_the_exception" {
  command = plan
  variables { account_id = "004351505091" }
  expect_failures = [aws_cloudfront_distribution.app]
}
run "shared_account_guardduty_stays_with_its_owner" {
  command = plan
  variables { create_guardduty_detector = false }
  assert {
    condition     = length(aws_guardduty_detector.app) == 0
    error_message = "An account-owned detector must not be duplicated or adopted by the application."
  }
}

run "truss_serves_its_own_hostname_on_modern_tls" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
  }
  assert {
    condition     = contains(aws_cloudfront_distribution.app.aliases, "one-door.sandbox.truss.coffee") && length(aws_cloudfront_distribution.app.aliases) == 1 && aws_cloudfront_distribution.app.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2025" && aws_cloudfront_distribution.app.viewer_certificate[0].ssl_support_method == "sni-only" && aws_cloudfront_distribution.app.viewer_certificate[0].cloudfront_default_certificate == null
    error_message = "A client hostname needs its own certificate and a modern viewer policy, never the default certificate."
  }
  assert {
    condition     = length(aws_acm_certificate.app) == 1 && aws_acm_certificate.app[0].domain_name == "one-door.sandbox.truss.coffee" && aws_acm_certificate.app[0].validation_method == "DNS"
    error_message = "The hostname needs a DNS-validated certificate of its own."
  }
  assert {
    condition     = toset([for record in aws_route53_record.app : record.type]) == toset(["A", "AAAA"]) && alltrue([for record in aws_route53_record.app : record.zone_id == "ZF5E6T2ONJR1H" && record.name == "one-door.sandbox.truss.coffee"])
    error_message = "Both address families must resolve, and only inside the zone the account already owns."
  }
  assert {
    condition     = local.app_origin == "https://one-door.sandbox.truss.coffee" && aws_lambda_function.probe.environment[0].variables.APP_ORIGIN == local.app_origin
    error_message = "The probe must measure the origin the browser uses; a stale origin makes state-changing requests fail with ORIGIN_MISMATCH."
  }
  assert {
    condition     = length(aws_lambda_function.visitor_activity) == 1 && length(aws_cloudwatch_log_subscription_filter.visitor_activity) == 2 && one(aws_cloudwatch_metric_alarm.visitor_activity).alarm_actions == toset([aws_sns_topic.alerts.arn]) && length(one(aws_cloudwatch_metric_alarm.visitor_activity).ok_actions) == 0
    error_message = "Truss visitor activity needs one bounded processor, both request-log feeds and one private email notice without a recovery email."
  }
  assert {
    condition     = one(aws_lambda_function.visitor_activity).environment[0].variables.APP_HOSTNAME == "one-door.sandbox.truss.coffee" && one(aws_cloudwatch_metric_alarm.visitor_activity).treat_missing_data == "notBreaching"
    error_message = "Visitor activity must be limited to the approved hostname and become quiet when no request is recorded."
  }
}
run "truss_without_a_certificate_is_refused" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
    allow_legacy_viewer_tls = false
  }
  expect_failures = [aws_cloudfront_distribution.app]
}
run "a_hostname_without_its_zone_is_refused" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
  }
  expect_failures = [var.route53_zone_id]
}
run "personal_keeps_its_generated_hostname_and_whole_account_budget" {
  command = plan
  assert {
    condition     = local.custom_hostname == false && length(aws_acm_certificate.app) == 0 && length(aws_acm_certificate_validation.app) == 0 && length(aws_route53_record.certificate) == 0 && length(aws_route53_record.app) == 0 && length(aws_cloudfront_distribution.app.aliases) == 0
    error_message = "The personal rehearsal keeps the generated CloudFront name, requests no certificate and writes no DNS record."
  }
  assert {
    condition     = aws_budgets_budget.app.name == "one-door-personal-personal-account" && length(aws_budgets_budget.app.cost_filter) == 0 && aws_budgets_budget.app.limit_amount == "65" && [for n in aws_budgets_budget.app.notification : n.threshold] == [50, 65] && alltrue([for n in aws_budgets_budget.app.notification : n.subscriber_email_addresses == toset(["biz@atighi.com"]) && n.comparison_operator == "GREATER_THAN" && n.threshold_type == "ABSOLUTE_VALUE" && n.notification_type == "ACTUAL"])
    error_message = "The personal budget keeps its approved limit, both notices and their recipient across the whole account, unfiltered."
  }
  assert {
    condition     = aws_cloudtrail.app.event_selector[0].include_management_events && length(aws_cloudtrail.app.event_selector[0].data_resource) == 1
    error_message = "The personal account has no organization trail behind it, so its own trail keeps management events."
  }
  assert {
    condition     = length(aws_lambda_function.visitor_activity) == 0 && length(aws_cloudwatch_log_subscription_filter.visitor_activity) == 0 && length(aws_cloudwatch_metric_alarm.visitor_activity) == 0
    error_message = "The Truss feedback notice must not change the personal rehearsal."
  }
}
run "truss_audits_state_objects_without_duplicating_the_organization_trail" {
  command = plan
  variables {
    account_id                = "004351505091"
    environment               = "truss"
    github_subject            = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls   = false
    app_hostname              = "one-door.sandbox.truss.coffee"
    route53_zone_name         = "sandbox.truss.coffee"
    route53_zone_id           = "ZF5E6T2ONJR1H"
    budget_cost_tag           = "Application"
    budget_limit_usd          = "40"
    budget_warning_usd        = "30"
    include_management_events = false
  }
  assert {
    condition     = aws_cloudtrail.app.event_selector[0].include_management_events == false && aws_cloudtrail.app.event_selector[0].data_resource[0].type == "AWS::S3::Object" && aws_cloudtrail.app.event_selector[0].data_resource[0].values == tolist(["arn:aws:s3:::one-door-state-004351505091-us-west-2/"])
    error_message = "The application trail records its own state objects and leaves management events to the organization trail that already charges for them."
  }
}
run "a_project_budget_scopes_to_its_cost_tag" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
  }
  assert {
    condition     = aws_budgets_budget.app.name == "one-door-truss-project" && one(aws_budgets_budget.app.cost_filter).name == "TagKeyValue" && contains(one(aws_budgets_budget.app.cost_filter).values, "user:Application$one-door") && local.default_tags["Application"] == "one-door"
    error_message = "The filter must name the value the resources are tagged with; a filter built from the application name would match nothing and report zero spend."
  }
  assert {
    condition     = aws_budgets_budget.app.limit_amount == "40" && [for n in aws_budgets_budget.app.notification : n.threshold] == [30, 40]
    error_message = "Both notices must follow the configured limit rather than the personal figures."
  }
}

run "a_neighbouring_name_does_not_count_as_the_zone" {
  command = plan
  variables {
    app_hostname      = "one-door.evilsandbox.truss.coffee"
    route53_zone_name = "sandbox.truss.coffee"
    route53_zone_id   = "ZF5E6T2ONJR1H"
  }
  expect_failures = [data.aws_route53_zone.app[0]]
}
run "a_hostname_that_is_not_a_plain_dns_name_is_refused" {
  command = plan
  variables {
    app_hostname      = "https://One-Door.sandbox.truss.coffee/"
    route53_zone_name = "sandbox.truss.coffee"
    route53_zone_id   = "ZF5E6T2ONJR1H"
  }
  expect_failures = [var.app_hostname]
}
run "a_trailing_dot_is_refused" {
  command = plan
  variables {
    app_hostname      = "one-door.sandbox.truss.coffee."
    route53_zone_name = "sandbox.truss.coffee"
    route53_zone_id   = "ZF5E6T2ONJR1H"
  }
  expect_failures = [var.app_hostname]
}
run "a_client_budget_must_state_its_own_limit_and_scope" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
  }
  expect_failures = [var.budget_limit_usd, var.budget_cost_tag]
}
run "a_client_budget_must_state_its_early_notice_too" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
  }
  expect_failures = [var.budget_warning_usd]
}
run "a_warning_at_or_above_the_limit_is_refused" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "40"
  }
  expect_failures = [var.budget_warning_usd]
}
run "the_truss_inputs_carry_the_hostname_zone_and_budget_scope" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
  }
  assert {
    condition     = strcontains(file("../environments/truss.platform.tfvars"), var.app_hostname) && strcontains(file("../environments/truss.platform.tfvars"), var.route53_zone_id) && strcontains(file("../environments/truss.platform.tfvars"), local.default_tags["Application"])
    error_message = "The Truss inputs must name the hostname, its zone and the tag the budget filters on."
  }
}

run "the_lookup_selects_a_public_zone_and_approves_it_by_id" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
  }
  assert {
    # The guard is the filter that selects the zone, and a filter is an input
    # rather than a planned value, so the source is where it can be checked.
    condition     = local.custom_hostname && strcontains(file("ingress.tf"), "private_zone = false")
    error_message = "The zone lookup must keep asking AWS for a public zone by name; without the filter a private zone could be selected, and a private zone cannot validate a public certificate."
  }
  assert {
    condition     = aws_route53_record.certificate[0].zone_id == var.route53_zone_id && alltrue([for record in aws_route53_record.app : record.zone_id == var.route53_zone_id])
    error_message = "Every record must land in the approved zone."
  }
}
run "a_zone_id_that_does_not_match_the_approved_one_is_refused" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Application"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
  }
  override_data {
    target = data.aws_route53_zone.app[0]
    values = { name = "sandbox.truss.coffee.", zone_id = "Z99999999999999999999" }
  }
  expect_failures = [data.aws_route53_zone.app[0]]
}
run "environment_cannot_pose_as_a_project_budget_scope" {
  command = plan
  variables {
    account_id              = "004351505091"
    environment             = "truss"
    github_subject          = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    allow_legacy_viewer_tls = false
    app_hostname            = "one-door.sandbox.truss.coffee"
    route53_zone_name       = "sandbox.truss.coffee"
    route53_zone_id         = "ZF5E6T2ONJR1H"
    budget_cost_tag         = "Environment"
    budget_limit_usd        = "40"
    budget_warning_usd      = "30"
  }
  expect_failures = [var.budget_cost_tag]
}
