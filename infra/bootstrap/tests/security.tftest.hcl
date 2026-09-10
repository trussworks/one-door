override_resource {
  target          = aws_ecr_repository.app
  override_during = plan
  values          = { arn = "arn:aws:ecr:us-west-2:845191826742:repository/one-door-personal" }
}
override_resource {
  target          = aws_s3_bucket.state
  override_during = plan
  values          = { arn = "arn:aws:s3:::one-door-state-845191826742-us-west-2" }
}
override_resource {
  target          = aws_kms_key.state
  override_during = plan
  values          = { arn = "arn:aws:kms:us-west-2:845191826742:key/11111111-1111-4111-8111-111111111111" }
}
mock_provider "aws" {}
override_resource {
  target          = aws_iam_openid_connect_provider.github[0]
  override_during = plan
  values = {
    arn = "arn:aws:iam::845191826742:oidc-provider/token.actions.githubusercontent.com"
  }
}
variables {
  account_id             = "845191826742"
  region                 = "us-west-2"
  environment            = "personal"
  github_subject         = "repo:rswerve@8964335/one-door@1354631764:environment:personal"
  publish_github_subject = "repo:rswerve@8964335/one-door@1354631764:environment:personal-publish"
}
run "protected_state_and_immutable_images" {
  command = plan
  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement :
      s.Effect == "Deny" &&
      contains(try(tolist(s.Action), []), "ecs:UpdateService") &&
      contains(try(tolist(s.Action), []), "ecs:CreateService") &&
      try(s.Condition.Null["ecs:task-definition"], "") == "false" &&
      length(try(s.Condition.ArnNotLike["ecs:task-definition"], [])) == 2 &&
      contains(try(s.Condition.ArnNotLike["ecs:task-definition"], []), "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-web:*") &&
      contains(try(s.Condition.ArnNotLike["ecs:task-definition"], []), "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-worker:*")
    ])
    error_message = "A service must be refused any task definition outside the two application families, while a count-only update that names none still succeeds."
  }
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement : contains(try(tolist(s.Action), []), "iam:PassRole") && contains(try(tolist(s.Resource), []), "arn:aws:iam::845191826742:role/one-door-personal-bootstrap-execution")])
    error_message = "Routine deployment must not pass the bootstrap execution role; registering a task definition with it injects the RDS administrator credential."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement :
      !contains(try(tolist(s.Action), []), "ecs:RunTask") || (
        !contains(try(tolist(s.Resource), []), "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-bootstrap:*") &&
        contains(try(tolist(s.Resource), []), "arn:aws:ecs:us-west-2:845191826742:task-definition/one-door-personal-migration:*")
      )
    ])
    error_message = "Deployment may run only the release job families; the retained bootstrap family stays out of reach."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.ignore_public_acls && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    error_message = "Terraform state must not be public."
  }
  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State version history is required for recovery."
  }
  assert {
    condition     = aws_kms_key.state.enable_key_rotation && aws_ecr_repository.app.image_tag_mutability == "IMMUTABLE" && aws_ecr_repository.app.image_scanning_configuration[0].scan_on_push
    error_message = "State rotation, immutable image tags and vulnerability scanning are required."
  }
  assert {
    condition     = jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == var.github_subject
    error_message = "Deployment identity must match the exact protected GitHub environment."
  }
  assert {
    condition     = jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/${var.release_branch}"
    error_message = "AWS must independently enforce the release branch as well as GitHub environment protections."
  }

  assert {
    condition     = var.release_branch == "main"
    error_message = "The release role must trust main, the branch whose push runs the release workflow."
  }
  assert {
    condition     = anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement : contains(try(tolist(s.Action), []), "iam:PassRole") && contains(try(tolist(s.Resource), []), "arn:aws:iam::845191826742:role/one-door-personal-verification-execution")])
    error_message = "Deployment must be able to register the verification execution role before the verification task switches to it."
  }
  assert {
    condition     = jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == var.publish_github_subject && jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] != jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]
    error_message = "Publishing and deployment must present different OIDC subjects; separate role names alone are not a boundary."
  }
  assert {
    condition     = jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com" && jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/${var.release_branch}"
    error_message = "The publisher keeps the same audience and release-branch restrictions as deployment."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement : alltrue([for action in tolist(s.Action) :
      !contains(["ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload"], action)
    ])])
    error_message = "Only the publisher writes images; deployment keeps pull, metadata and scan reads."
  }
  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.publish.policy).Statement :
      contains(try(tolist(s.Action), []), "ecr:PutImage") && contains(try(tolist(s.Action), []), "ecr:CompleteLayerUpload")
    ])
    error_message = "The publisher must retain the image push actions deployment gave up."
  }
  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement :
      contains(try(tolist(s.Action), []), "ecr:BatchGetImage") && contains(try(tolist(s.Action), []), "ecr:DescribeImages")
    ])
    error_message = "Deployment still pulls the promoted image and reads its metadata."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.publish.policy).Statement : alltrue([for action in tolist(s.Action) :
      !startswith(action, "ecs:") && !startswith(action, "iam:") && !startswith(action, "s3:") && !startswith(action, "logs:") && !startswith(action, "secretsmanager:") && !startswith(action, "kms:")
    ])])
    error_message = "The publisher may reach the image registry only; task launch, PassRole, state, logs and secrets stay with deployment."
  }
}

run "deployment_can_tag_the_tasks_its_services_launch" {
  command = plan
  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement :
      contains(try(tolist(s.Action), []), "ecs:TagResource") &&
      contains(try(tolist(s.Resource), []), "arn:aws:ecs:us-west-2:845191826742:task/one-door-personal/*")
    ])
    error_message = "Propagating service tags to tasks needs no wider grant than this: removing the task resource would break cost attribution rather than tighten anything."
  }
}
run "reject_a_publisher_that_shares_the_deployment_subject" {
  command = plan
  variables { publish_github_subject = "repo:rswerve@8964335/one-door@1354631764:environment:personal" }
  expect_failures = [var.publish_github_subject]
}

run "reuse_shared_github_provider" {
  command = plan
  variables {
    existing_github_provider_arn = "arn:aws:iam::845191826742:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0 && jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Principal.Federated == var.existing_github_provider_arn
    error_message = "A shared account provider must be reused without adopting its configuration."
  }
}

run "truss_identities_follow_their_own_repository_and_account" {
  command = plan
  variables {
    account_id                   = "004351505091"
    environment                  = "truss"
    github_subject               = "repo:trussworks@1649505/one-door@1362084625:environment:truss"
    publish_github_subject       = "repo:trussworks@1649505/one-door@1362084625:environment:truss-publish"
    existing_github_provider_arn = "arn:aws:iam::004351505091:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0 && jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Principal.Federated == var.existing_github_provider_arn && jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Principal.Federated == var.existing_github_provider_arn
    error_message = "Truss reuses the account's provider for both identities and never creates a second one."
  }
  assert {
    condition     = jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:trussworks@1649505/one-door@1362084625:environment:truss" && jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:trussworks@1649505/one-door@1362084625:environment:truss-publish"
    error_message = "Each Truss identity trusts only its own GitHub environment subject; a shared subject would let the publisher assume the deployment role."
  }
  assert {
    condition = anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement :
      s.Effect == "Deny" &&
      contains(try(tolist(s.Action), []), "ecs:UpdateService") &&
      contains(try(s.Condition.ArnNotLike["ecs:task-definition"], []), "arn:aws:ecs:us-west-2:004351505091:task-definition/one-door-truss-web:*") &&
      contains(try(s.Condition.ArnNotLike["ecs:task-definition"], []), "arn:aws:ecs:us-west-2:004351505091:task-definition/one-door-truss-worker:*")
    ])
    error_message = "The service boundary must follow the target account and application name rather than the personal literals."
  }
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_role_policy.release.policy).Statement : contains(try(tolist(s.Action), []), "iam:PassRole") && contains(try(tolist(s.Resource), []), "arn:aws:iam::004351505091:role/one-door-truss-bootstrap-execution")])
    error_message = "Truss deployment must not pass the bootstrap execution role either."
  }
  assert {
    condition     = output.account_id == "004351505091" && output.region == "us-west-2" && output.environment == "truss"
    error_message = "The backend writer reads the target account, region and environment from bootstrap rather than repeating them."
  }
  assert {
    condition     = strcontains(file("../environments/truss.tfvars"), jsondecode(aws_iam_role.release.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]) && strcontains(file("../environments/truss.bootstrap.tfvars"), jsondecode(aws_iam_role.publish.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"])
    error_message = "The Truss inputs must name the same subjects the trust policy grants; changing one side alone leaves the deployment unable to assume its role."
  }
}
