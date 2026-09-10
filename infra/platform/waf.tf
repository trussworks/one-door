resource "aws_wafv2_web_acl" "app" {
  provider = aws.global
  name     = local.name
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }
  association_config {
    request_body {
      cloudfront { default_size_inspection_limit = "KB_64" }
    }
  }
  custom_response_body {
    key          = "too-large"
    content_type = "APPLICATION_JSON"
    content      = "{\"error\":\"BODY_TOO_LARGE\"}"
  }
  rule {
    name     = "BodyLimit"
    priority = 1
    action {
      block {
        custom_response {
          response_code            = 413
          custom_response_body_key = "too-large"
        }
      }
    }
    statement {
      size_constraint_statement {
        comparison_operator = "GT"
        size                = 65536
        field_to_match {
          body { oversize_handling = "MATCH" }
        }
        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-body-limit"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "Methods"
    priority = 2
    action {
      block {}
    }
    statement {
      not_statement {
        statement {
          regex_match_statement {
            regex_string = "^(GET|HEAD|POST|OPTIONS)$"
            field_to_match {
              method {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-methods"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "RequestRate"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        limit                 = 10000
        evaluation_window_sec = 300
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate"
      sampled_requests_enabled   = false
    }
  }
  dynamic "rule" {
    for_each = { AWSManagedRulesKnownBadInputsRuleSet = 10, AWSManagedRulesAmazonIpReputationList = 20 }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${local.name}-${rule.key}"
        sampled_requests_enabled   = false
      }
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = false
  }
}

resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.global
  name              = "aws-waf-logs-${local.name}"
  retention_in_days = 30
}

resource "aws_wafv2_web_acl_logging_configuration" "app" {
  provider                = aws.global
  resource_arn            = aws_wafv2_web_acl.app.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  redacted_fields {
    single_header { name = "cookie" }
  }
  redacted_fields {
    single_header { name = "authorization" }
  }
  redacted_fields {
    query_string {}
  }
}
