mock_provider "aws" {}
# The registered ARN is only known after apply, and the output wiring is the
# thing worth asserting, so plan-time value stands in for it.
override_resource {
  target          = aws_ecs_task_definition.bootstrap
  override_during = plan
  values          = { arn = "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-bootstrap:1" }
}
variables {
  image = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  platform = {
    account_id  = "845191826742"
    region      = "us-west-2"
    environment = "personal"
    name        = "one-door-personal"
    execution_role_arns = {
      bootstrap = "arn:aws:iam::845191826742:role/one-door-personal-bootstrap-execution"
    }
    task_role_arn    = "arn:aws:iam::845191826742:role/one-door-personal-task"
    log_groups       = { operations = "/one-door/personal/operations" }
    database_host    = "example.us-west-2.rds.amazonaws.com"
    admin_secret_arn = "arn:aws:secretsmanager:us-west-2:845191826742:secret:admin-example"
    secret_arns = {
      runtime    = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/runtime-example"
      migration  = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/migration-example"
      diagnostic = "arn:aws:secretsmanager:us-west-2:845191826742:secret:/one-door/personal/diagnostic-example"
    }
    repository_url = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal"
  }
}
run "operator_owns_the_administrator_task" {
  command = plan
  assert {
    condition     = aws_ecs_task_definition.bootstrap.family == "one-door-personal-bootstrap" && aws_ecs_task_definition.bootstrap.execution_role_arn == var.platform.execution_role_arns["bootstrap"]
    error_message = "The installation stack must own the bootstrap family under the bootstrap execution role."
  }
  assert {
    condition     = contains([for secret in jsondecode(aws_ecs_task_definition.bootstrap.container_definitions)[0].secrets : secret.valueFrom], var.platform.admin_secret_arn)
    error_message = "Bootstrap is the task that needs the administrator credential; that is why an operator owns it."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.bootstrap.container_definitions)[0].command == ["node", "--experimental-strip-types", "scripts/db-bootstrap.ts"]
    error_message = "The installation task must run database bootstrap, not arbitrary code."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.bootstrap.container_definitions)[0].readonlyRootFilesystem && jsondecode(aws_ecs_task_definition.bootstrap.container_definitions)[0].user == "1000:1000" && contains(jsondecode(aws_ecs_task_definition.bootstrap.container_definitions)[0].linuxParameters.capabilities.drop, "ALL")
    error_message = "The installation task keeps the same non-root, read-only, dropped-capability shape as every other task."
  }
  assert {
    condition     = aws_ecs_task_definition.bootstrap.skip_destroy
    error_message = "Retaining the existing revision is what makes the ownership handoff non-destructive."
  }
  assert {
    condition     = output.tasks.jobs["bootstrap"] == aws_ecs_task_definition.bootstrap.arn && output.tasks.services == {}
    error_message = "The output must match the shape run-task.ts reads, so installation needs no separate task runner."
  }
}
run "reject_mutable_tag" {
  command = plan
  variables { image = "845191826742.dkr.ecr.us-west-2.amazonaws.com/one-door-personal:latest" }
  expect_failures = [var.image]
}
run "reject_image_from_another_repository" {
  command = plan
  variables { image = "999999999999.dkr.ecr.us-west-2.amazonaws.com/one-door-personal@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  expect_failures = [var.image]
}

run "truss_installer_follows_its_own_account" {
  command = plan
  variables {
    image = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    platform = merge(var.platform, {
      account_id     = "004351505091"
      environment    = "truss"
      name           = "one-door-truss"
      repository_url = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss"
      execution_role_arns = merge(var.platform.execution_role_arns, {
        bootstrap = "arn:aws:iam::004351505091:role/one-door-truss-bootstrap-execution"
      })
    })
  }
  assert {
    condition     = aws_ecs_task_definition.bootstrap.family == "one-door-truss-bootstrap" && aws_ecs_task_definition.bootstrap.execution_role_arn == "arn:aws:iam::004351505091:role/one-door-truss-bootstrap-execution"
    error_message = "The installer task follows the target account and application name rather than the personal literals."
  }
}
run "truss_installer_refuses_a_personal_image" {
  command = plan
  variables {
    platform = merge(var.platform, {
      account_id     = "004351505091"
      environment    = "truss"
      name           = "one-door-truss"
      repository_url = "004351505091.dkr.ecr.us-west-2.amazonaws.com/one-door-truss"
    })
  }
  expect_failures = [var.image]
}
