terraform {
  required_version = "= 1.16.1"
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.63.0" }
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a twelve-digit AWS account ID."
  }
}
variable "region" { type = string }
variable "environment" { type = string }
variable "github_subject" { type = string }
variable "publish_github_subject" {
  type        = string
  description = "OIDC subject of the publish-only job. A different GitHub environment is what separates it from the deploy role."
  validation {
    condition     = var.publish_github_subject != var.github_subject
    error_message = "The publisher needs its own GitHub environment subject; an identical subject would let a compromised publish job assume the deploy role."
  }
}
variable "release_branch" {
  type    = string
  default = "main"
}
variable "existing_github_provider_arn" {
  type        = string
  default     = ""
  description = "Reuse the account's GitHub OIDC provider when another stack owns it."
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "one-door", Environment = var.environment, ManagedBy = "Terraform" }
  }
}

locals {
  name         = "one-door-${var.environment}"
  state_bucket = "one-door-state-${var.account_id}-${var.region}"
  asset_bucket = "one-door-assets-${var.account_id}-${var.region}"
}

resource "aws_kms_key" "state" {
  description             = "One Door Terraform state"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
resource "aws_kms_alias" "state" {
  name          = "alias/${local.name}-state"
  target_key_id = aws_kms_key.state.key_id
}
resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }
    }]
  })
}
resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  lifecycle { prevent_destroy = true }
}
moved {
  from = aws_iam_openid_connect_provider.github
  to   = aws_iam_openid_connect_provider.github[0]
}
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.existing_github_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "release" {
  name                 = "${local.name}-release"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = var.existing_github_provider_arn != "" ? var.existing_github_provider_arn : aws_iam_openid_connect_provider.github[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = var.github_subject
        "token.actions.githubusercontent.com:ref" = "refs/heads/${var.release_branch}"
      } }
    }]
  })
}
resource "aws_iam_role_policy" "release" {
  role = aws_iam_role.release.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sts:GetCallerIdentity", "ecr:GetAuthorizationToken"], Resource = "*" },
      # Deployment pulls and reads; the publisher is the only identity that
      # writes an image, so a compromised deploy job cannot replace one.
      {
        Effect = "Allow",
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages",
          "ecr:DescribeImageScanFindings",
        ],
        Resource = aws_ecr_repository.app.arn,
      },
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = [aws_s3_bucket.state.arn, "arn:aws:s3:::${local.asset_bucket}"] },
      {
        Effect = "Allow",
        Action = ["s3:GetObject", "s3:PutObject"],
        Resource = [
          "${aws_s3_bucket.state.arn}/release/terraform.tfstate",
          "arn:aws:s3:::${local.asset_bucket}/_assets/*",
          "arn:aws:s3:::${local.asset_bucket}/release-records/*",
        ],
      },
      {
        Effect   = "Allow",
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource = "${aws_s3_bucket.state.arn}/release/terraform.tfstate.tflock",
      },
      { Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], Resource = aws_kms_key.state.arn },
      {
        Effect = "Allow",
        Action = [
          "ecs:DescribeClusters",
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:ListTasks",
          "ecs:DescribeTaskDefinition",
          "ecs:ListTagsForResource",
        ],
        Resource = "*",
      },
      {
        Effect    = "Allow",
        Action    = ["ecs:RegisterTaskDefinition"],
        Resource  = "*",
        Condition = { StringEquals = { "aws:RequestTag/Application" = "one-door", "aws:RequestTag/Environment" = var.environment } },
      },
      {
        Effect = "Allow",
        Action = ["ecs:TagResource"],
        Resource = [
          "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-*",
          "arn:aws:ecs:${var.region}:${var.account_id}:service/${local.name}/${local.name}-*",
          "arn:aws:ecs:${var.region}:${var.account_id}:task/${local.name}/*",
        ],
      },
      { Effect = "Allow", Action = ["ecs:DeregisterTaskDefinition"], Resource = "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-*" },
      {
        Effect   = "Allow",
        Action   = ["ecs:CreateService", "ecs:UpdateService", "ecs:TagResource"],
        Resource = "arn:aws:ecs:${var.region}:${var.account_id}:service/${local.name}/${local.name}-*",
      },
      # A service may only ever run the two application families. Without this,
      # pointing the worker service at the retained bootstrap definition would
      # inject the administrator credential, because that definition already
      # names the execution role that reads it and no further PassRole is
      # documented for UpdateService. The Null test keeps count-only and
      # alarm-only updates working, which carry no task definition at all.
      {
        Effect   = "Deny",
        Action   = ["ecs:CreateService", "ecs:UpdateService"],
        Resource = "*",
        Condition = {
          ArnNotLike = { "ecs:task-definition" = [
            "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-web:*",
            "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-worker:*",
          ] },
          Null = { "ecs:task-definition" = "false" },
        },
      },
      # Only the families a release actually runs. The retained bootstrap family
      # stays launchable by an operator and unreachable from the pipeline.
      {
        Effect = "Allow",
        Action = ["ecs:RunTask"],
        Resource = [
          "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-migration:*",
          "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-fixture-upgrade:*",
          "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${local.name}-verification:*",
        ],
        Condition = { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:${var.region}:${var.account_id}:cluster/${local.name}" } },
      },
      {
        Effect = "Allow",
        Action = ["iam:PassRole"],
        # The administrator execution role is absent on purpose: ECS checks
        # iam:PassRole when a task definition is registered, so keeping it here
        # would let a release register administrator-credentialed task code.
        Resource = [
          "arn:aws:iam::${var.account_id}:role/${local.name}-web-execution",
          "arn:aws:iam::${var.account_id}:role/${local.name}-worker-execution",
          "arn:aws:iam::${var.account_id}:role/${local.name}-migration-execution",
          "arn:aws:iam::${var.account_id}:role/${local.name}-diagnostic-execution",
          "arn:aws:iam::${var.account_id}:role/${local.name}-verification-execution",
          "arn:aws:iam::${var.account_id}:role/${local.name}-task",
        ],
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } },
      },
      {
        Effect   = "Allow",
        Action   = ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
        Resource = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/one-door/${var.environment}/*",
      },
      { Effect = "Allow", Action = ["cloudwatch:DescribeAlarms"], Resource = "*" },
      { Effect = "Allow", Action = ["elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTargetGroups"], Resource = "*" }
    ]
  })
}
resource "aws_iam_role" "publish" {
  name                 = "${local.name}-publish"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = var.existing_github_provider_arn != "" ? var.existing_github_provider_arn : aws_iam_openid_connect_provider.github[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = var.publish_github_subject
        "token.actions.githubusercontent.com:ref" = "refs/heads/${var.release_branch}"
      } }
    }]
  })
}
# Publishing needs the registry and nothing else. Without ecs:RegisterTaskDefinition
# or iam:PassRole a compromised build step cannot launch task code, whatever it
# pushes to the repository.
resource "aws_iam_role_policy" "publish" {
  role = aws_iam_role.publish.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sts:GetCallerIdentity", "ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow",
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:DescribeImages",
          "ecr:DescribeImageScanFindings",
        ],
        Resource = aws_ecr_repository.app.arn,
      },
    ]
  })
}

output "account_id" { value = var.account_id }
output "region" { value = var.region }
output "environment" { value = var.environment }
output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "state_key_arn" { value = aws_kms_key.state.arn }
output "repository_url" { value = aws_ecr_repository.app.repository_url }
output "repository_arn" { value = aws_ecr_repository.app.arn }
output "release_role_arn" { value = aws_iam_role.release.arn }
output "publish_role_arn" { value = aws_iam_role.publish.arn }
