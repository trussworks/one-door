mock_provider "aws" {}
variables {
  candidate_image = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  platform = {
    account_id               = "845191826742"
    region                   = "us-west-2"
    environment              = "personal"
    name                     = "one-door-personal"
    cluster_arn              = "arn:aws:ecs:us-west-2:845191826742:cluster/one-door-personal"
    subnet_ids               = ["subnet-11111111", "subnet-22222222"]
    web_security_group_id    = "sg-11111111"
    worker_security_group_id = "sg-22222222"
    execution_role_arns = {
      web          = "arn:aws:iam::845191826742:role/one-door-personal-web-execution"
      worker       = "arn:aws:iam::845191826742:role/one-door-personal-worker-execution"
      bootstrap    = "arn:aws:iam::845191826742:role/one-door-personal-bootstrap-execution"
      migration    = "arn:aws:iam::845191826742:role/one-door-personal-migration-execution"
      diagnostic   = "arn:aws:iam::845191826742:role/one-door-personal-diagnostic-execution"
      verification = "arn:aws:iam::845191826742:role/one-door-personal-verification-execution"
    }
    task_role_arn    = "arn:aws:iam::845191826742:role/one-door-personal-task"
    log_groups       = { web = "/one-door/personal/web", worker = "/one-door/personal/worker", operations = "/one-door/personal/operations" }
    database_host    = "example.us-west-2.rds.amazonaws.com"
    admin_secret_arn = "arn:aws:secretsmanager:us-west-2:845191826742:secret:admin-example"
    secret_arns = {
      runtime    = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/runtime-example"
      migration  = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/migration-example"
      diagnostic = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/diagnostic-example"
      gate       = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/gate-example"
      session    = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/session-example"
      anthropic  = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/anthropic-example"
    }
    target_group_arn = "arn:aws:elasticloadbalancing:us-west-2:845191826742:targetgroup/one-door-personal/1111111111111111"
    app_origin       = "https://example.cloudfront.net"
    repository_url   = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal"
    readiness_alarm  = "one-door-personal-readiness"
  }
}
run "guarded_runtime_and_first_install" {
  command = plan
  assert {
    condition     = !contains(keys(aws_ecs_task_definition.job), "bootstrap") && aws_ecs_task_definition.job["verification"].execution_role_arn == var.platform.execution_role_arns["verification"]
    error_message = "Routine Terraform must neither register an administrator task nor lend its execution role to acceptance verification."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.service["worker"].container_definitions)[0].healthCheck.command == ["CMD", "node", "--experimental-strip-types", "scripts/worker-health.ts"] && jsondecode(aws_ecs_task_definition.service["worker"].container_definitions)[0].healthCheck.startPeriod == 90
    error_message = "Workers require a per-task progress check runnable without a shell or network."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.job["fixture-upgrade"].container_definitions)[0].command == ["node", "--experimental-strip-types", "scripts/db-upgrade-fixtures.ts", "--confirm-fixture-upgrade"] && jsondecode(aws_ecs_task_definition.job["fixture-upgrade"].container_definitions)[0].secrets[0].valueFrom == var.platform.secret_arns["migration"]
    error_message = "Fixture upgrades must be explicit and run with migration credentials, never reset the database."
  }
  assert {
    condition = alltrue([for task in merge(aws_ecs_task_definition.service, aws_ecs_task_definition.job) :
      jsondecode(task.container_definitions)[0].linuxParameters.capabilities.add == [] &&
      jsondecode(task.container_definitions)[0].systemControls == [] &&
    jsondecode(task.container_definitions)[0].volumesFrom == []])
    error_message = "Explicit empty ECS collections must match API readback so unrelated settings do not redeploy every task."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.job["verification"].container_definitions)[0].command == ["node", "scripts/rds-acceptance.mjs"] && !contains([for secret in jsondecode(aws_ecs_task_definition.job["verification"].container_definitions)[0].secrets : secret.valueFrom], var.platform.admin_secret_arn)
    error_message = "Database acceptance runs packaged code with the three application roles, without injecting admin credentials."
  }
  assert {
    condition     = aws_ecs_service.web.desired_count == 0 && aws_ecs_service.worker.desired_count == 0 && !aws_ecs_service.web.network_configuration[0].assign_public_ip && !aws_ecs_service.worker.network_configuration[0].assign_public_ip
    error_message = "First install stays stopped until bootstrap, migration and seed complete, and tasks remain private."
  }
  assert {
    condition     = alltrue([for task in aws_ecs_task_definition.service : jsondecode(task.container_definitions)[0].readonlyRootFilesystem && jsondecode(task.container_definitions)[0].user == "1000:1000" && jsondecode(task.container_definitions)[0].stopTimeout == 120 && jsondecode(task.container_definitions)[0].linuxParameters.initProcessEnabled && contains(jsondecode(task.container_definitions)[0].linuxParameters.capabilities.drop, "ALL")])
    error_message = "Long-running tasks require non-root, read-only filesystems, dropped capabilities and graceful shutdown."
  }
  assert {
    condition     = !contains([for s in jsondecode(aws_ecs_task_definition.service["web"].container_definitions)[0].secrets : s.valueFrom], var.platform.secret_arns["anthropic"]) && jsondecode(aws_ecs_task_definition.job["diagnostic"].container_definitions)[0].secrets[0].valueFrom == var.platform.secret_arns["diagnostic"]
    error_message = "The web task cannot read provider credentials and diagnostics use a separate database role."
  }
  assert {
    condition     = aws_ecs_service.web.deployment_circuit_breaker[0].rollback && aws_ecs_service.worker.deployment_circuit_breaker[0].rollback && aws_ecs_service.web.deployment_minimum_healthy_percent == 100 && aws_ecs_task_definition.service["web"].skip_destroy
    error_message = "Rolling releases preserve healthy tasks and retain rollback revisions."
  }
}
run "personal_services_keep_their_current_tagging" {
  command = plan
  assert {
    condition     = alltrue([for service in [aws_ecs_service.web, aws_ecs_service.worker] : service.propagate_tags == null && service.enable_ecs_managed_tags == null])
    error_message = "The personal budget covers the whole account, so its services stay as installed; changing them would make a routine candidate preparation fail its guard."
  }
}
run "reject_mutable_tag" {
  command = plan
  variables { candidate_image = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal:latest" }
  expect_failures = [var.candidate_image]
}
run "reject_other_account_image" {
  command = plan
  variables { candidate_image = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  expect_failures = [var.candidate_image]
}
run "candidate_preparation_preserves_released_services" {
  command = plan
  variables {
    released_image = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    web_count      = 2
    worker_count   = 2
    serving_task_definitions = {
      web    = "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-web:9"
      worker = "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-worker:9"
    }
  }
  assert {
    condition     = alltrue([for task in merge(aws_ecs_task_definition.service, aws_ecs_task_definition.job) : jsondecode(task.container_definitions)[0].image == var.candidate_image]) && aws_ecs_service.web.task_definition == var.serving_task_definitions.web && aws_ecs_service.worker.task_definition == var.serving_task_definitions.worker && output.tasks.services == var.serving_task_definitions && output.settings.released_image == var.released_image && output.settings.web_count == 2 && !contains(keys(output.settings), "serving_task_definitions")
    error_message = "Candidate definitions can be registered, but preparation must preserve serving revisions and never persist the temporary pins in release settings."
  }
}
run "reject_foreign_serving_revision" {
  command = plan
  variables {
    serving_task_definitions = {
      web    = "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-worker:9"
      worker = ""
    }
  }
  expect_failures = [var.serving_task_definitions]
}

run "truss_tasks_serve_the_hostname_browsers_use" {
  command = plan
  variables {
    candidate_image = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    platform = merge(var.platform, {
      account_id     = "004351505091"
      environment    = "truss"
      name           = "one-door-truss"
      cluster_arn    = "arn:aws:ecs:us-west-2:004351505091:cluster/one-door-truss"
      app_origin     = "https://one-door.sandbox.truss.coffee"
      repository_url = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss"
    })
  }
  assert {
    condition = anytrue([for entry in jsondecode(aws_ecs_task_definition.service["web"].container_definitions)[0].environment :
      entry.name == "APP_ORIGIN" && entry.value == "https://one-door.sandbox.truss.coffee"
    ])
    error_message = "The web task must expect the hostname the browser sends; a stale origin refuses every state-changing request with ORIGIN_MISMATCH."
  }
  assert {
    condition     = aws_ecs_task_definition.service["web"].family == "one-door-truss-web" && aws_ecs_task_definition.service["worker"].family == "one-door-truss-worker"
    error_message = "Task families follow the target application name that the deployment boundary also names."
  }
}
run "truss_refuses_an_image_from_the_personal_registry" {
  command = plan
  variables {
    platform = merge(var.platform, {
      account_id     = "004351505091"
      environment    = "truss"
      name           = "one-door-truss"
      repository_url = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss"
    })
  }
  expect_failures = [var.candidate_image]
}

run "truss_tasks_carry_the_tag_its_budget_filters_on" {
  command = plan
  variables {
    candidate_image = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    platform = merge(var.platform, {
      account_id     = "004351505091"
      environment    = "truss"
      name           = "one-door-truss"
      cluster_arn    = "arn:aws:ecs:us-west-2:004351505091:cluster/one-door-truss"
      repository_url = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss"
    })
  }
  assert {
    condition     = alltrue([for service in [aws_ecs_service.web, aws_ecs_service.worker] : service.propagate_tags == "SERVICE" && service.enable_ecs_managed_tags])
    error_message = "Fargate is billed against the task, so a Truss service that does not propagate its tags leaves compute outside a budget filtered on Application."
  }
}
