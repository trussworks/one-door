# The bootstrap job is the only task that receives the RDS administrator
# credential, so an operator owns it here instead of the release stack. ECS
# authorizes iam:PassRole when a task definition is registered, not only when it
# runs, so leaving this definition in release Terraform would force the
# deployment role to keep administrator PassRole authority it never needs.
terraform {
  required_version = "= 1.16.1"
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.63.0" }
  }
  backend "s3" {}
}
variable "platform" {
  type = object({
    account_id          = string
    region              = string
    environment         = string
    name                = string
    execution_role_arns = map(string)
    task_role_arn       = string
    log_groups          = map(string)
    database_host       = string
    admin_secret_arn    = string
    secret_arns         = map(string)
    repository_url      = string
  })
}
variable "image" {
  type = string
  validation {
    condition     = startswith(var.image, "${var.platform.repository_url}@sha256:") && can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Installation must run an immutable image digest from this account's One Door repository."
  }
}

provider "aws" {
  region              = var.platform.region
  allowed_account_ids = [var.platform.account_id]
  default_tags {
    tags = { Application = "one-door", Environment = var.platform.environment, ManagedBy = "Terraform" }
  }
}

locals {
  log_options = {
    awslogs-region        = var.platform.region
    awslogs-stream-prefix = "ecs"
    mode                  = "non-blocking"
    max-buffer-size       = "10m"
  }
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${var.platform.name}-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.platform.execution_role_arns["bootstrap"]
  task_role_arn            = var.platform.task_role_arn
  skip_destroy             = true
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([{
    name                   = "bootstrap"
    image                  = var.image
    command                = ["node", "--experimental-strip-types", "scripts/db-bootstrap.ts"]
    essential              = true
    user                   = "1000:1000"
    readonlyRootFilesystem = true
    stopTimeout            = 120
    linuxParameters        = { initProcessEnabled = true, capabilities = { add = [], drop = ["ALL"] } }
    environment = [
      { name = "ONE_DOOR_ENVIRONMENT", value = var.platform.environment },
      { name = "DB_HOST", value = var.platform.database_host },
      { name = "DB_NAME", value = "one_door" },
      { name = "DB_SSLMODE", value = "verify-full" },
    ]
    secrets = [for name, arn in {
      ADMIN_DB_CREDENTIALS    = var.platform.admin_secret_arn
      RUNTIME_DATABASE_URL    = var.platform.secret_arns["runtime"]
      MIGRATION_DATABASE_URL  = var.platform.secret_arns["migration"]
      DIAGNOSTIC_DATABASE_URL = var.platform.secret_arns["diagnostic"]
    } : { name = name, valueFrom = arn }]
    portMappings     = []
    systemControls   = []
    volumesFrom      = []
    mountPoints      = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-group = var.platform.log_groups["operations"] }) }
  }])
}

# Shaped like the release stack's tasks output so run-task.ts reads it unchanged.
output "tasks" {
  value = {
    services = {}
    jobs     = { bootstrap = aws_ecs_task_definition.bootstrap.arn }
  }
}
