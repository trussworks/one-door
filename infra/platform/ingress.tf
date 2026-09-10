locals {
  # A hostname and its zone arrive together; either both or neither is set.
  custom_hostname = var.app_hostname != "" && var.route53_zone_id != ""
  app_origin = local.custom_hostname ? "https://${var.app_hostname}" : (
    "https://${aws_cloudfront_distribution.app.domain_name}"
  )
  # AWS managed CloudFront policies, addressed by their published ids.
  cloudfront_policies = {
    caching_disabled       = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    all_viewer_except_host = "216adef6-5c7f-47e4-b989-5492eafa07d3"
    caching_optimized      = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "one-door-assets-${var.account_id}-${var.region}"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "one-door-logs-${var.account_id}-${var.region}"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "private" {
  for_each = {
    assets = aws_s3_bucket.assets.id,
    logs   = aws_s3_bucket.logs.id
  }
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "private" {
  for_each = {
    assets = aws_s3_bucket.assets.id,
    logs   = aws_s3_bucket.logs.id
  }
  bucket = each.value
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private" {
  for_each = {
    assets = aws_s3_bucket.assets.id,
    logs   = aws_s3_bucket.logs.id
  }
  bucket = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "private" {
  for_each = {
    assets = aws_s3_bucket.assets.id,
    logs   = aws_s3_bucket.logs.id
  }
  bucket = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Deny",
        Principal = "*",
        Action    = "s3:*",
        Resource  = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"],
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false"
          }
        }
      },
      {
        Effect = "Allow",
        Principal = {
          Service = "logdelivery.elasticloadbalancing.amazonaws.com"
        },
        Action   = "s3:PutObject",
        Resource = "${aws_s3_bucket.logs.arn}/alb/AWSLogs/${var.account_id}/*"
      },
      {
        Effect = "Allow",
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        },
        Action   = "s3:GetBucketAcl",
        Resource = aws_s3_bucket.logs.arn,
        Condition = {
          StringEquals = {
            "aws:SourceArn" = "arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${local.name}"
          }
        }
      },
      {
        Effect = "Allow",
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        },
        Action   = "s3:PutObject",
        Resource = "${aws_s3_bucket.logs.arn}/cloudtrail/AWSLogs/${var.account_id}/*",
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control", "aws:SourceArn" = "arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${local.name}"
          }
        }
      }
    ]
  })
}

resource "aws_lb" "app" {
  name                       = local.name
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.app[*].id
  idle_timeout               = 60
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  enable_deletion_protection = true
  access_logs {
    bucket  = aws_s3_bucket.logs.bucket
    prefix  = "alb"
    enabled = true
  }
  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.app.id
  deregistration_delay = 45
  health_check {
    path                = "/api/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "web" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_cloudfront_vpc_origin" "app" {
  vpc_origin_endpoint_config {
    name                   = local.name
    arn                    = aws_lb.app.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
  depends_on = [aws_internet_gateway.app, aws_lb_listener.web]
}

data "aws_security_group" "cloudfront" {
  filter {
    name   = "vpc-id"
    values = [aws_vpc.app.id]
  }
  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }
  depends_on = [aws_cloudfront_vpc_origin.app]
}

resource "aws_vpc_security_group_ingress_rule" "cloudfront" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = data.aws_security_group.cloudfront.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${local.name}-assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = local.name
  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
    content_security_policy {
      content_security_policy = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
      override                = false
    }
  }
}

resource "aws_cloudfront_distribution" "app" {
  lifecycle {
    precondition {
      condition = local.custom_hostname || (
        var.account_id == "845191826742" && var.environment == "personal" && var.allow_legacy_viewer_tls
      )
      error_message = "Set app_hostname and route53_zone_id for a custom certificate and modern TLS. The generated AWS URL permits TLS 1.0 and only the acknowledged personal rehearsal may use it."
    }
  }
  enabled         = true
  comment         = local.name
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true
  web_acl_id      = aws_wafv2_web_acl.app.arn
  origin {
    domain_name         = aws_lb.app.dns_name
    origin_id           = "application"
    connection_attempts = 2
    connection_timeout  = 5
    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.app.id
      origin_read_timeout      = 30
      origin_keepalive_timeout = 5
    }
  }
  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }
  default_cache_behavior {
    target_origin_id           = "application"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = local.cloudfront_policies.caching_disabled
    origin_request_policy_id   = local.cloudfront_policies.all_viewer_except_host
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    compress                   = true
  }
  ordered_cache_behavior {
    path_pattern               = "/_assets/*"
    target_origin_id           = "assets"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = local.cloudfront_policies.caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    compress                   = true
  }
  dynamic "custom_error_response" {
    for_each = toset([400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504])
    content {
      error_code            = custom_error_response.value
      error_caching_min_ttl = 0
    }
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  aliases = local.custom_hostname ? [var.app_hostname] : []
  viewer_certificate {
    # Reading the arn through the validation resource keeps the distribution
    # from going live on a certificate AWS has not yet issued.
    cloudfront_default_certificate = local.custom_hostname ? null : true
    acm_certificate_arn            = local.custom_hostname ? aws_acm_certificate_validation.app[0].certificate_arn : null
    ssl_support_method             = local.custom_hostname ? "sni-only" : null
    minimum_protocol_version       = local.custom_hostname ? "TLSv1.2_2025" : null
  }
  depends_on = [aws_vpc_security_group_ingress_rule.cloudfront]
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Deny",
        Principal = "*",
        Action    = "s3:*",
        Resource  = [aws_s3_bucket.assets.arn, "${aws_s3_bucket.assets.arn}/*"],
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false"
          }
        }
      },
      {
        Effect = "Allow",
        Principal = {
          Service = "cloudfront.amazonaws.com"
        },
        Action   = "s3:GetObject",
        Resource = "${aws_s3_bucket.assets.arn}/_assets/*",
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.app.arn
          }
        }
      }
    ]
  })
}

# Asking for a public zone by name keeps a private zone out: no public zone of
# that name means no read and no plan. The returned id must then be the approved
# one, which catches a different zone sharing the name, and the returned name
# must contain the hostname on a label boundary. The read happens during
# planning, so a wrong zone fails there rather than after ACM and CloudFront
# exist and validation never arrives.
data "aws_route53_zone" "app" {
  count        = local.custom_hostname ? 1 : 0
  name         = var.route53_zone_name
  private_zone = false
  lifecycle {
    postcondition {
      condition = self.zone_id == var.route53_zone_id && (
        var.app_hostname == trimsuffix(self.name, ".") ||
        endswith(var.app_hostname, ".${trimsuffix(self.name, ".")}")
      )
      error_message = "The public zone found for route53_zone_name must be the approved route53_zone_id and must answer for app_hostname on a label boundary."
    }
  }
}

resource "aws_acm_certificate" "app" {
  count             = local.custom_hostname ? 1 : 0
  provider          = aws.global
  domain_name       = var.app_hostname
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# Retained after issuance: ACM re-validates through the same records at renewal.
# The certificate names one domain and no alternatives, so a single record is
# the whole validation set. A for_each over domain_validation_options would
# derive its keys from an apply-time value and fail the first plan; adding a
# subject alternative name later means revisiting this resource.
resource "aws_route53_record" "certificate" {
  count   = local.custom_hostname ? 1 : 0
  zone_id = data.aws_route53_zone.app[0].zone_id
  name    = local.certificate_validation.resource_record_name
  type    = local.certificate_validation.resource_record_type
  records = [local.certificate_validation.resource_record_value]
  ttl     = 60
  # A shared zone may already hold the name; overwriting someone else's record
  # is worse than a failed apply.
  allow_overwrite = false
}

locals {
  certificate_validation = local.custom_hostname ? tolist(aws_acm_certificate.app[0].domain_validation_options)[0] : null
}

resource "aws_acm_certificate_validation" "app" {
  count                   = local.custom_hostname ? 1 : 0
  provider                = aws.global
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = aws_route53_record.certificate[*].fqdn
}

resource "aws_route53_record" "app" {
  for_each = local.custom_hostname ? toset(["A", "AAAA"]) : toset([])
  zone_id  = data.aws_route53_zone.app[0].zone_id
  name     = var.app_hostname
  type     = each.value
  # The shared zone may already answer for this name; a failed apply is better
  # than replacing a record its owner is relying on.
  allow_overwrite = false
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}
