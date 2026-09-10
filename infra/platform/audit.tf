resource "aws_cloudtrail" "app" {
  name                          = local.name
  s3_bucket_name                = aws_s3_bucket.logs.id
  s3_key_prefix                 = "cloudtrail"
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  event_selector {
    read_write_type           = "All"
    include_management_events = var.include_management_events
    data_resource {
      type   = "AWS::S3::Object"
      values = ["arn:aws:s3:::one-door-state-${var.account_id}-${var.region}/"]
    }
  }
  depends_on = [aws_s3_bucket_policy.logs]
}

moved {
  from = aws_guardduty_detector.app
  to   = aws_guardduty_detector.app[0]
}
resource "aws_guardduty_detector" "app" {
  count                        = var.create_guardduty_detector ? 1 : 0
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  lifecycle { prevent_destroy = true }
}
