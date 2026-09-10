terraform {
  required_version = "= 1.16.1"
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.63.0" }
  }
  backend "s3" {}
}
variable "platform" {
  type = object({
    account_id               = string
    region                   = string
    environment              = string
    name                     = string
    cluster_arn              = string
    subnet_ids               = list(string)
    web_security_group_id    = string
    worker_security_group_id = string
    execution_role_arns      = map(string)
    task_role_arn            = string
    log_groups               = map(string)
    database_host            = string
    admin_secret_arn         = string
    secret_arns              = map(string)
    target_group_arn         = string
    app_origin               = string
    repository_url           = string
    readiness_alarm          = string
  })
}
variable "candidate_image" {
  type = string
  validation {
    condition     = startswith(var.candidate_image, "${var.platform.repository_url}@sha256:") && can(regex("@sha256:[a-f0-9]{64}$", var.candidate_image))
    error_message = "The candidate must be an immutable image digest in this account's One Door repository."
  }
}
variable "released_image" {
  type    = string
  default = ""
  validation {
    condition     = var.released_image == "" || (startswith(var.released_image, "${var.platform.repository_url}@sha256:") && can(regex("@sha256:[a-f0-9]{64}$", var.released_image)))
    error_message = "The release must be an immutable image digest in this account's One Door repository."
  }
}
variable "web_count" {
  type    = number
  default = 0
}
variable "worker_count" {
  type    = number
  default = 0
}
variable "deployment_alarms_enabled" {
  type    = bool
  default = false
}
variable "serving_task_definitions" {
  type        = object({ web = string, worker = string })
  default     = null
  description = "During candidate preparation, preserve the verified serving revisions until promotion."
  validation {
    condition = var.serving_task_definitions == null ? true : alltrue([
      for name, arn in var.serving_task_definitions : can(regex("^arn:aws:ecs:${var.platform.region}:${var.platform.account_id}:task-definition/${var.platform.name}-${name}:[0-9]+$", arn))
    ])
    error_message = "Serving task definitions must be exact revisions of this account's web and worker families."
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
  # Fargate is billed against the task, and a task carries no tag of its own,
  # so a budget filtered on Application needs the service to propagate. Only
  # Truss budgets that way; personal budgets the whole account, and changing
  # its services would make a routine candidate preparation fail its guard.
  propagate_service_tags = var.platform.environment == "truss"
  image                  = var.released_image == "" ? var.candidate_image : var.released_image
  environment = [
    { name = "ONE_DOOR_ENVIRONMENT", value = var.platform.environment }
  ]
  log_options = {
    awslogs-region        = var.platform.region
    awslogs-stream-prefix = "ecs"
    mode                  = "non-blocking"
    max-buffer-size       = "10m"
  }
  services = {
    web = {
      execution    = "web"
      command      = null
      environment  = concat(local.environment, [{ name = "APP_ORIGIN", value = var.platform.app_origin }])
      secrets      = { DATABASE_URL = var.platform.secret_arns["runtime"], DEMO_ACCESS_CODE = var.platform.secret_arns["gate"], SESSION_SECRET = var.platform.secret_arns["session"] }
      portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
        { sourceVolume = "cache", containerPath = "/app/.next/cache", readOnly = false },
      ]
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
    worker = {
      execution    = "worker"
      command      = ["node", "--experimental-strip-types", "scripts/model-worker.ts"]
      environment  = local.environment
      secrets      = { DATABASE_URL = var.platform.secret_arns["runtime"], ANTHROPIC_API_KEY = var.platform.secret_arns["anthropic"] }
      portMappings = []
      mountPoints  = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      healthCheck = {
        command     = ["CMD", "node", "--experimental-strip-types", "scripts/worker-health.ts"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 90
      }
    }
  }
  jobs = {
    migration = {
      execution   = "migration"
      command     = ["node", "--experimental-strip-types", "scripts/db-migrate.ts"]
      environment = local.environment
      secrets     = { DATABASE_URL = var.platform.secret_arns["migration"] }
    }
    fixture-upgrade = {
      execution   = "migration"
      command     = ["node", "--experimental-strip-types", "scripts/db-upgrade-fixtures.ts", "--confirm-fixture-upgrade"]
      environment = local.environment
      secrets     = { DATABASE_URL = var.platform.secret_arns["migration"] }
    }
    seed = {
      execution   = "migration"
      command     = ["node", "--experimental-strip-types", "scripts/db-seed.ts"]
      environment = local.environment
      secrets     = { DATABASE_URL = var.platform.secret_arns["migration"] }
    }
    diagnostic = {
      execution   = "diagnostic"
      command     = ["node", "--experimental-strip-types", "scripts/db-inspect.ts"]
      environment = local.environment
      secrets     = { DATABASE_URL = var.platform.secret_arns["diagnostic"] }
    }
    verification = {
      execution   = "verification"
      command     = ["node", "scripts/rds-acceptance.mjs"]
      environment = concat(local.environment, [{ name = "DB_NAME", value = "one_door" }, { name = "DB_SSLMODE", value = "verify-full" }])
      secrets     = { RUNTIME_DATABASE_URL = var.platform.secret_arns["runtime"], MIGRATION_DATABASE_URL = var.platform.secret_arns["migration"], DIAGNOSTIC_DATABASE_URL = var.platform.secret_arns["diagnostic"] }
    }
  }
}
resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "${var.platform.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.platform.execution_role_arns[each.value.execution]
  task_role_arn            = var.platform.task_role_arn
  skip_destroy             = true
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  dynamic "volume" {
    for_each = [for mount in each.value.mountPoints : mount.sourceVolume]
    content { name = volume.value }
  }
  container_definitions = jsonencode([merge({
    name                   = each.key
    image                  = var.serving_task_definitions == null ? local.image : var.candidate_image
    essential              = true
    user                   = "1000:1000"
    readonlyRootFilesystem = true
    stopTimeout            = 120
    linuxParameters        = { initProcessEnabled = true, capabilities = { add = [], drop = ["ALL"] } }
    environment            = each.value.environment
    secrets                = [for name, arn in each.value.secrets : { name = name, valueFrom = arn }]
    systemControls         = []
    volumesFrom            = []
    portMappings           = each.value.portMappings
    mountPoints            = each.value.mountPoints
    logConfiguration       = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-group = var.platform.log_groups[each.key] }) }
    },
    each.value.command == null ? {} : { command = each.value.command },
    each.value.healthCheck == null ? {} : { healthCheck = each.value.healthCheck },
  )])
}
resource "aws_ecs_task_definition" "job" {
  for_each                 = local.jobs
  family                   = "${var.platform.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.platform.execution_role_arns[each.value.execution]
  task_role_arn            = var.platform.task_role_arn
  skip_destroy             = true
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = var.candidate_image
    command                = each.value.command
    essential              = true
    user                   = "1000:1000"
    readonlyRootFilesystem = true
    stopTimeout            = 120
    linuxParameters        = { initProcessEnabled = true, capabilities = { add = [], drop = ["ALL"] } }
    environment            = each.value.environment
    secrets                = [for name, arn in each.value.secrets : { name = name, valueFrom = arn }]
    portMappings           = []
    systemControls         = []
    volumesFrom            = []
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    logConfiguration       = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-group = var.platform.log_groups["operations"] }) }
  }])
}
# verify-release.ts owns convergence and exact revision checks for both services.
resource "aws_ecs_service" "web" {
  name                               = "${var.platform.name}-web"
  cluster                            = var.platform.cluster_arn
  task_definition                    = var.serving_task_definitions == null ? aws_ecs_task_definition.service["web"].arn : var.serving_task_definitions.web
  desired_count                      = var.web_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  enable_ecs_managed_tags            = local.propagate_service_tags ? true : null
  propagate_tags                     = local.propagate_service_tags ? "SERVICE" : null
  enable_execute_command             = false
  health_check_grace_period_seconds  = 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  wait_for_steady_state              = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  alarms {
    alarm_names = [var.platform.readiness_alarm]
    enable      = var.deployment_alarms_enabled
    rollback    = true
  }
  network_configuration {
    subnets          = var.platform.subnet_ids
    security_groups  = [var.platform.web_security_group_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = var.platform.target_group_arn
    container_name   = "web"
    container_port   = 3000
  }
  timeouts {
    create = "30m"
    update = "30m"
  }
}
resource "aws_ecs_service" "worker" {
  name                               = "${var.platform.name}-worker"
  cluster                            = var.platform.cluster_arn
  task_definition                    = var.serving_task_definitions == null ? aws_ecs_task_definition.service["worker"].arn : var.serving_task_definitions.worker
  desired_count                      = var.worker_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  enable_ecs_managed_tags            = local.propagate_service_tags ? true : null
  propagate_tags                     = local.propagate_service_tags ? "SERVICE" : null
  enable_execute_command             = false
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  wait_for_steady_state              = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.platform.subnet_ids
    security_groups  = [var.platform.worker_security_group_id]
    assign_public_ip = false
  }
  timeouts {
    create = "30m"
    update = "30m"
  }
}
output "tasks" {
  value = {
    services = { web = aws_ecs_service.web.task_definition, worker = aws_ecs_service.worker.task_definition }
    jobs     = { for key, task in aws_ecs_task_definition.job : key => task.arn }
  }
}
output "settings" {
  value = {
    platform                  = var.platform
    candidate_image           = var.candidate_image
    released_image            = local.image
    web_count                 = var.web_count
    worker_count              = var.worker_count
    deployment_alarms_enabled = var.deployment_alarms_enabled
  }
}
