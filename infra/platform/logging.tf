resource "aws_cloudwatch_log_group" "cloudfront" {
  provider          = aws.global
  name              = "/one-door/${var.environment}/cloudfront"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  provider     = aws.global
  name         = "${local.name}-cloudfront"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.app.arn
}
resource "aws_cloudwatch_log_delivery_destination" "cloudfront" {
  provider      = aws.global
  name          = "${local.name}-cloudfront"
  output_format = "json"
  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.cloudfront.arn
  }
}
resource "aws_cloudwatch_log_delivery" "cloudfront" {
  provider                 = aws.global
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cloudfront.arn
  record_fields            = ["date", "time", "c-ip", "cs-method", "cs(Host)", "cs-uri-stem", "sc-status", "time-taken", "x-edge-result-type", "x-edge-request-id", "ssl-protocol", "ssl-cipher"]
}
