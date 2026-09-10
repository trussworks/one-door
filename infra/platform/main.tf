terraform {
  required_version = "= 1.16.1"
  required_providers {
    aws = {
      source  = "hashicorp/aws",
      version = "= 6.63.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "= 2.7.1"
    }
  }
  backend "s3" {
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = local.default_tags
  }
}

provider "aws" {
  alias               = "global"
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = local.default_tags
  }
}

data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "zone-type"
    values = ["availability-zone"]
  }
}

data "aws_caller_identity" "current" {
}

locals {
  # The budget derives its Application filter from the same provider tag.
  default_tags = {
    Application = "one-door"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
  name           = "one-door-${var.environment}"
  zones          = slice(sort(data.aws_availability_zones.available.names), 0, 2)
  repository_arn = "arn:aws:ecr:${var.region}:${var.account_id}:repository/${local.name}"
  task_trust = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      },
      Action = "sts:AssumeRole",
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.account_id
        },
        ArnLike = {
          "aws:SourceArn" = "arn:aws:ecs:${var.region}:${var.account_id}:*"
        }
      }
    }]
  })
}

locals {
  secret_access = {
    web          = [aws_secretsmanager_secret.app["runtime"].arn, aws_secretsmanager_secret.app["gate"].arn, aws_secretsmanager_secret.app["session"].arn]
    worker       = [aws_secretsmanager_secret.app["runtime"].arn, aws_secretsmanager_secret.app["anthropic"].arn]
    migration    = [aws_secretsmanager_secret.app["migration"].arn]
    diagnostic   = [aws_secretsmanager_secret.app["diagnostic"].arn]
    verification = [aws_secretsmanager_secret.app["runtime"].arn, aws_secretsmanager_secret.app["migration"].arn, aws_secretsmanager_secret.app["diagnostic"].arn]
    bootstrap    = [aws_db_instance.app.master_user_secret[0].secret_arn, aws_secretsmanager_secret.app["runtime"].arn, aws_secretsmanager_secret.app["migration"].arn, aws_secretsmanager_secret.app["diagnostic"].arn]
  }
}

resource "aws_vpc" "app" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    Name = local.name
  }
}

resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id
}
resource "aws_default_security_group" "app" {
  vpc_id  = aws_vpc.app.id
  ingress = []
  egress  = []
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.app.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags = {
    Name = "${local.name}-public-${count.index}"
  }
}

resource "aws_subnet" "app" {
  count                   = 2
  vpc_id                  = aws_vpc.app.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  map_public_ip_on_launch = false
  tags = {
    Name = "${local.name}-app-${count.index}"
  }
}

resource "aws_subnet" "database" {
  count                   = 2
  vpc_id                  = aws_vpc.app.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 20 + count.index)
  map_public_ip_on_launch = false
  tags = {
    Name = "${local.name}-database-${count.index}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.app.id
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.app.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"
}

resource "aws_nat_gateway" "app" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.app]
}

resource "aws_route_table" "app" {
  count  = 2
  vpc_id = aws_vpc.app.id
}

resource "aws_route" "nat" {
  count                  = 2
  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.app[count.index].id
}

resource "aws_route_table_association" "app" {
  count          = 2
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

resource "aws_route_table" "database" {
  vpc_id = aws_vpc.app.id
}

resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.app.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.app[*].id
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Private CloudFront origin; no public ingress"
  vpc_id      = aws_vpc.app.id
}

resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Web tasks accept only the private ALB"
  vpc_id      = aws_vpc.app.id
}

resource "aws_security_group" "worker" {
  name        = "${local.name}-worker"
  description = "Workers and one-off tasks have no inbound listener"
  vpc_id      = aws_vpc.app.id
}

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL reachable only from One Door tasks"
  vpc_id      = aws_vpc.app.id
}

resource "aws_vpc_security_group_egress_rule" "alb_web" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_ingress_rule" "web_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "https" {
  for_each = {
    web    = aws_security_group.web.id,
    worker = aws_security_group.worker.id
  }
  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "database" {
  for_each = {
    web    = aws_security_group.web.id,
    worker = aws_security_group.worker.id
  }
  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  for_each = {
    web    = aws_security_group.web.id,
    worker = aws_security_group.worker.id
  }
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_kms_key" "data" {
  description             = "One Door database and application secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_db_subnet_group" "app" {
  name       = local.name
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "app" {
  name   = local.name
  family = "postgres18"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "log_connections"
    value = "all"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

resource "aws_db_instance" "app" {
  depends_on                      = [aws_cloudwatch_log_group.database]
  identifier                      = local.name
  engine                          = "postgres"
  engine_version                  = "18.6"
  instance_class                  = "db.t4g.small"
  allocated_storage               = 20
  max_allocated_storage           = 100
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  username                        = "one_door_admin"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.data.arn
  db_subnet_group_name            = aws_db_subnet_group.app.name
  parameter_group_name            = aws_db_parameter_group.app.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  multi_az                        = true
  publicly_accessible             = false
  port                            = 5432
  backup_retention_period         = 7
  backup_window                   = "09:00-10:00"
  maintenance_window              = "sun:11:00-sun:12:00"
  auto_minor_version_upgrade      = false
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  performance_insights_enabled    = false
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "database" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.name}/${each.key}"
  retention_in_days = 30
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = toset(["runtime", "migration", "diagnostic", "gate", "session", "anthropic"])
  name                    = "/one-door/${var.environment}/${each.key}"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["web", "worker", "operations", "vpc", "probe"])
  name              = "/one-door/${var.environment}/${each.key}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "app" {
  name = local.name
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = local.task_trust
}


resource "aws_iam_role" "execution" {
  for_each           = local.secret_access
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = local.task_trust
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.secret_access
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow",
        Action   = ["ecr:GetAuthorizationToken"],
        Resource = "*"
      },
      {
        Effect   = "Allow",
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Resource = local.repository_arn
      },
      {
        Effect   = "Allow",
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource = [for log in aws_cloudwatch_log_group.app : "${log.arn}:*"]
      },
      {
        Effect   = "Allow",
        Action   = ["secretsmanager:GetSecretValue"],
        Resource = each.value
      },
      {
        Effect   = "Allow",
        Action   = ["kms:Decrypt"],
        Resource = aws_kms_key.data.arn,
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role" "flow" {
  name = "${local.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Action = "sts:AssumeRole",
      Principal = {
        Service = "vpc-flow-logs.amazonaws.com"
      },
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.account_id
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "flow" {
  role = aws_iam_role.flow.id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect   = "Allow",
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
      Resource = "${aws_cloudwatch_log_group.app["vpc"].arn}:*"
    }]
  })
}

resource "aws_flow_log" "app" {
  iam_role_arn             = aws_iam_role.flow.arn
  log_destination          = aws_cloudwatch_log_group.app["vpc"].arn
  traffic_type             = "ALL"
  vpc_id                   = aws_vpc.app.id
  max_aggregation_interval = 60
}
