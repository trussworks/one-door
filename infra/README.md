# Operate One Door on AWS

> Truss is the client deployment. Keep the personal rehearsal available until Truss acceptance; retiring it requires a separate approval. RDS restore and failover rehearsals remain deferred.

One Door helps people describe a software or infrastructure need and follow the request through review and delivery. This runbook lets an engineer familiar with AWS, Terraform, Docker and GitHub Actions operate the personal rehearsal and carry out the approved Truss installation. Use fictional information: the reference services and policies are demo fixtures, and model calls send request content to Anthropic. The shared access code is a demo gate, not agency identity management.

The personal rehearsal explicitly accepts **TLS 1.0 as the minimum viewer protocol** on the AWS-generated CloudFront hostname, and only that account may. The Truss installation serves `one-door.sandbox.truss.coffee` on its own certificate with `TLSv1.2_2025`; the platform refuses to plan a client distribution on the default certificate.

This runbook covers two deployments. The personal rehearsal uses account `845191826742` and stays available until Truss acceptance. The Truss installation uses sandbox account `004351505091`, region `us-west-2`, the public hostname `one-door.sandbox.truss.coffee`, and repository `trussworks/one-door`. Each has its own Terraform state, secrets, database and artifacts, and each step below says which deployment it belongs to when the two differ.

Never copy Terraform state between accounts. Moving the application means reproducing the installation, not transferring it; drafts and browser sessions do not carry over.

Two images are involved, and confusing them would credit the wrong one. Before the launch, the approved personal image is copied into the Truss registry byte for byte so the installation can be rehearsed on an artifact that already passed its checks, and that copy is retained afterwards as a rollback candidate where schema and job contracts allow. The launch run then builds and deploys a new image from the frozen commit. Record the new digest as the released one; do not describe it as the copied artifact. Copy the image with `promote-image.ts`, described in [Promote the approved image](#promote-the-approved-image).

## What runs, and what it costs

CloudFront accepts HTTPS traffic and a web application firewall checks requests. Static files come from a private S3 bucket. Application requests pass through a CloudFront VPC origin to an internal load balancer, then to private Fargate tasks. A running release uses two web tasks and two workers across two availability zones. PostgreSQL runs on encrypted, private Multi-AZ RDS. Each application subnet has its own NAT gateway; database subnets have no internet route.

Connections from CloudFront to the load balancer and from the load balancer to web tasks use HTTP over the private network. Database connections verify the RDS hostname and certificate; provider calls use HTTPS. `allow_legacy_viewer_tls` is accepted only for account `845191826742` with `environment = "personal"`. Any other deployment must set `app_hostname`, `route53_zone_name` and `route53_zone_id` together, which is what gives it a certificate and a modern viewer policy; the flag alone would not.

The approved estimate is $8–10 per day with little traffic, plus $5–15 for bounded recovery rehearsals. The personal $65 monthly **whole-account** budget sends notices at $50 and $65; Truss has a project budget with $75/$100 notices; the budget is an alert, not a spending limit. NAT gateways, the load balancer and RDS continue charging when ECS task counts are zero. No resource deletion or automatic cleanup is part of the release commands.

## Stacks and release identity

Each deployment has four stacks with separate ownership and state keys. The release role's state grant names only `release/terraform.tfstate`, so a release can neither read nor write installation state.

| Stack       | Owns                                                                    | Remote state key              |
| ----------- | ----------------------------------------------------------------------- | ----------------------------- |
| `bootstrap` | State storage and encryption, image repository, GitHub release identity | `bootstrap/terraform.tfstate` |
| `platform`  | Network, database, Secrets Manager resources, ingress, logs and alarms  | `platform/terraform.tfstate`  |
| `install`   | The administrator bootstrap task, applied by an operator only           | `install/terraform.tfstate`   |
| `release`   | Application task definitions and ECS services                           | `release/terraform.tfstate`   |

The release role cannot replace the network or database, grant itself permissions, or call Secrets Manager directly to read application values. Approved deployment code is nevertheless trusted with secrets injected into the tasks it can launch. The role can publish executable images, register tasks, pass execution roles and read task logs; it is a privileged deployment identity. The image publisher obtains temporary AWS credentials through GitHub OIDC. Both AWS's role trust and the deployment's GitHub environment restrict the release branch. The workflow checks the actual OIDC claims before assuming the role. GitHub's [immutable subject format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) includes this repository's numeric owner and repository IDs.

## Prerequisites

Use the requirements below for a new installation. The [rehearsal tool record](#rehearsal-tool-record) preserves versions used in earlier verification.

| Tool or access      | Required version or scope                                                         | Check                                                                    |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Node.js and npm     | Node 24 for release checks; npm available                                         | `node --version` and `npm --version`                                     |
| Terraform           | Exactly 1.16.1                                                                    | `terraform version`                                                      |
| AWS CLI             | v2 with a working temporary credential profile                                    | `aws --version` and `aws sts get-caller-identity`                        |
| Docker              | A running Linux-container engine with Buildx                                      | `docker version` and `docker buildx version`                             |
| Python              | 3.10 or newer for probe tests and the examples below                              | `python3 --version`                                                      |
| GitHub CLI          | Authenticated repository access                                                   | `gh auth status`                                                         |
| Git                 | Source checkout                                                                   | `git --version`                                                          |
| AWS operator access | Infrastructure provisioning in the intended account                               | Confirm the STS account before any apply                                 |
| Provider credential | The intended Anthropic runtime account                                            | Supply through the environment or macOS Keychain service `anthropic-api` |
| Source AWS profile  | A working profile for account `845191826742`, needed to read the promotion source | `aws --profile <name> sts get-caller-identity`                           |

Start in the root of a separate clone of [trussworks/one-door](https://github.com/trussworks/one-door). Use [DEVELOPMENT.md](../DEVELOPMENT.md) for PostgreSQL 18.6 test setup and isolation. The upgrade tests use checked-in baseline fixtures and do not need development history from the personal repository. Tests must use a separate PostgreSQL cluster and fresh databases; the live local demo database is not a test target.

```sh
npm ci
```

The helpers resolve AWS and Docker from fixed absolute paths; use `ONE_DOOR_AWS` or `ONE_DOOR_DOCKER` with an absolute executable path for another installation.

## Select the personal account

Select the intended AWS CLI profile using `AWS_PROFILE`, then confirm the account. These examples assume credentials already work in `us-west-2`.

The personal source login lives in `us-east-1`, and two different failures look alike.

A session that has merely aged out is refreshable. Exporting it against `--region us-west-2` is rejected while the same export against `--region us-east-1` succeeds, so a private profile whose `credential_process` runs `aws configure export-credentials --profile personal-sandbox --region us-east-1 --format process` renews it without any interactive step. Resources stay in `us-west-2`: only the export uses the login region, and the profile file holds no access key.

A sign-in grant that has expired is not refreshable. The tools profile then returns `TOKEN_EXPIRED`, and `credential_process` cannot renew it however many times it runs. Sign in again with `aws login --remote --profile personal-sandbox --region us-east-1`, then continue.

```sh
aws sts get-caller-identity --region us-west-2
```

The account must be `845191826742`. Both Terraform providers and S3 backends also restrict account IDs. An expired credential must be renewed before continuing.

## Select the Truss sandbox account

The Truss installation uses sandbox account `004351505091` in `us-west-2`. Enter its credential context first; every AWS command below runs inside that context, so open a shell in it once rather than prefixing each command:

```sh
aws-vault --keychain=login --prompt=osascript exec trussworks-sandbox -- /bin/zsh -f
```

`-f` skips the startup scripts, because a profile reinstalled through `direnv` would put the commands back in another account. A single command takes the same form, with the command in place of `/bin/zsh -f`. Inside that shell, confirm the account before anything else:

```sh
aws sts get-caller-identity --region us-west-2
```

The account must be `004351505091`. Terraform providers and S3 backends restrict it as well, and `write-backends.py --environment truss` refuses bootstrap outputs from any other account or region.

The infrastructure procedures were exercised in Truss on 9 September 2026: all four states converged, the certificate and DNS worked, and the approved image was copied and scanned. Preserve the receipts from subsequent installation and release commands; an infrastructure receipt does not prove application readiness. Local Docker validation uses Linux ARM because the x86-64 build failed inside QEMU; launch CI validates the x86-64 image on an x86-64 runner.

The rest of this runbook is written for the Truss installation. Set the deployment name once and every later command follows it:

```sh
umask 077
export ONE_DOOR_ENVIRONMENT=truss
export DEPLOYMENT_DIR="$PWD/.deployment-private/$ONE_DOOR_ENVIRONMENT"
mkdir -p "$DEPLOYMENT_DIR"
```

This installation path targets Truss. For personal maintenance, select personal credentials and its existing private directory, and set `ONE_DOOR_ENVIRONMENT=personal` when selecting variable files. Use [Manual subsequent releases and rollback](#manual-subsequent-releases-and-rollback) for the running personal installation; do not initialize it again or run the Truss-only image promotion against it.

`truss.platform.tfvars` records the approved recipient `maz@truss.works` and budget notices at $75 and $100. Review the deployment one week after provisioning; that review does not automatically stop or delete resources. The existing demo Anthropic credential remains the selected provider credential.

The budget filters on the `Application` tag. Truss services set `propagate_tags = "SERVICE"` with ECS managed tags enabled, because Fargate usage is billed against the task and a task carries no tag of its own; without propagation the budget would cover the database, gateways and load balancer but omit compute. Personal services keep the tagging they were installed with, since a whole-account budget needs no filter. AWS reports no spend against the filter until the tag is activated as a cost-allocation tag. A linked account cannot list or activate one, so activation belongs to the payer account's owner and is not arranged yet. Until the owner confirms it, treat the budget as unproven: a zero reads the same as a cheap month, and no attribution has been demonstrated.

Confirm the shared account controls before creating anything. The GitHub OIDC provider already exists and `truss.bootstrap.tfvars` reuses it through `existing_github_provider_arn`, so Terraform leaves its configuration alone. GuardDuty and the organization CloudTrail belong to the account team, so `create_guardduty_detector = false` and `include_management_events = false` keep the application from duplicating either. Check the VPC address ranges already in use before accepting the default `vpc_cidr`, and check free Elastic IP quota immediately before the platform apply: the installation allocates two addresses for its two NAT gateways, and a shared account's free quota can change between the check and the apply.

The platform stack owns the certificate for `one-door.sandbox.truss.coffee`, its DNS validation record and the A and AAAA aliases. It reads the existing public zone `sandbox.truss.coffee` as data and never creates or replaces a zone, and it refuses to plan when the zone it finds is not the approved `ZF5E6T2ONJR1H` or does not answer for the hostname on a label boundary. Certificate validation and the distribution complete inside one apply, which takes tens of minutes.

The private directory set above holds every plan, output and access detail for the selected deployment.

## First installation

This section is only for a new account installation. If the state bucket already exists, recover its existing remote state and initialize the backend; do not start an empty bootstrap state against existing resources. Review existing OIDC providers and shared account controls before creating anything in a shared account. Set `existing_github_provider_arn` when another stack owns the GitHub provider; Terraform then leaves that provider's configuration alone. Set platform variable `create_guardduty_detector=false` when the account team already owns the regional detector. Confirm that protection is active with `aws guardduty list-detectors --region us-west-2`; the application must not duplicate or adopt an account-owned detector.

### Create and secure state

Copy the bootstrap configuration into the private working directory, then initialize and save a plan:

```sh
mkdir -p "$DEPLOYMENT_DIR/bootstrap"
cp infra/bootstrap/main.tf infra/bootstrap/.terraform.lock.hcl "$DEPLOYMENT_DIR/bootstrap/"
terraform -chdir="$DEPLOYMENT_DIR/bootstrap" init -input=false
terraform -chdir="$DEPLOYMENT_DIR/bootstrap" plan -input=false -var-file="$PWD/infra/environments/$ONE_DOOR_ENVIRONMENT.tfvars" -var-file="$PWD/infra/environments/$ONE_DOOR_ENVIRONMENT.bootstrap.tfvars" -out=bootstrap.plan
```

Review the plan before applying it. Stop on an unexpected account, existing-resource replacement, deletion or wider permissions. Bootstrap creates AWS resources that retain state and can incur charges.

```sh
terraform -chdir="$DEPLOYMENT_DIR/bootstrap" apply -input=false bootstrap.plan
terraform -chdir="$DEPLOYMENT_DIR/bootstrap" output -json > "$DEPLOYMENT_DIR/bootstrap.json"
```

The selected `*.bootstrap.tfvars` names the publishing job's OIDC subject. Bootstrap refuses a subject equal to the deployment subject, because an identical subject would let a compromised publishing job assume the deployment role.

Generate account-restricted backend files for all four stacks from the actual outputs. The `install` backend is written here and used later; the release role's state grant does not name its key, so the deployment pipeline can neither read nor write installation state:

```sh
python3 scripts/deploy/write-backends.py "$DEPLOYMENT_DIR" --environment "$ONE_DOOR_ENVIRONMENT"
terraform -chdir="$DEPLOYMENT_DIR/bootstrap" init -migrate-state -backend-config="$DEPLOYMENT_DIR/bootstrap.backend.hcl"
```

Confirm the migrated state exists in S3, has a version ID and reports `ServerSideEncryption: aws:kms`. Retain the initial local state and migration artifacts until cleanup is explicitly approved.

```sh
aws s3api head-object --region us-west-2 --bucket "one-door-state-$(aws sts get-caller-identity --query Account --output text)-us-west-2" --key bootstrap/terraform.tfstate --query '{encryption:ServerSideEncryption,key:SSEKMSKeyId,version:VersionId}'
```

### Create the platform

The platform notification switch is `alarm_actions_enabled`. If an existing private variable file uses the previous `monitoring_enabled` name, rename that key while keeping its boolean value before the next plan. The rename does not change alarm evaluation or notification settings.

```sh
terraform -chdir=infra/platform init -input=false -backend-config="$DEPLOYMENT_DIR/platform.backend.hcl"
terraform -chdir=infra/platform plan -input=false -var-file="../environments/$ONE_DOOR_ENVIRONMENT.tfvars" -var-file="../environments/$ONE_DOOR_ENVIRONMENT.platform.tfvars" -out="$DEPLOYMENT_DIR/platform.plan"
```

Review the saved plan. The personal inputs enable the explicit temporary viewer-TLS exception, set `biz@atighi.com` as the alert recipient, and enable alarm actions. The Truss inputs instead configure the hostname, its zone and certificate, keep management events with the organization trail, and leave the detector to the account team; the checked-in Truss input supplies the approved alert recipient and budget. Alarms therefore notify from the first apply, so confirm the SNS subscription promptly; probes run either way. Applying the plan can take tens of minutes while RDS and CloudFront become available. Keep the Terraform process running while AWS reports progress.

```sh
terraform -chdir=infra/platform apply -input=false "$DEPLOYMENT_DIR/platform.plan"
terraform -chdir=infra/platform output -json deployment > "$DEPLOYMENT_DIR/platform.json"
```

After creation completes, confirm that the database is private, uses encrypted storage and has Multi-AZ enabled. Confirm the SNS email subscription using the confirmation email. A subscription alone does not prove alarm delivery; the rehearsal must also exercise the CloudWatch-to-SNS-to-email path.

### Install secrets

Secret values belong in Secrets Manager, never in Terraform variables, plans, GitHub variables or command arguments. The helper generates database credentials, an application access code and a session-signing secret only when no value exists. It reads the Anthropic credential from `ANTHROPIC_API_KEY` or the named macOS Keychain item, sends values to AWS through standard input, and reads them back before reporting success.

```sh
node --experimental-strip-types scripts/deploy/install-secrets.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/access.txt"
```

The access file is private (`0600`). Do not paste its contents into CI logs. Re-running installation preserves existing secret values and refuses an existing access file with different contents. Installation does not rotate credentials; use the rotation procedure after the initial environment works.

### Configure GitHub and deploy the checked image

The publisher is `trussworks/one-door` on branch `main`. Repository Actions stays disabled until the launch, and the tracked `Truss AWS release` workflow runs only on a manual dispatch: it has no push or pull-request trigger, and `Harness CI` runs only as a reusable call inside it. One dispatch therefore performs every check, publishes and scans the image, and deploys, consuming a single workflow run.

The launch uses one such run after local validation. Obtain Maz's explicit authorization for that run in the session that performs it before enabling Actions or dispatching. A failed run consumes the reservation; a rerun requires a new authorization.

The release uses two GitHub environments so its two jobs carry different OIDC subjects. The publishing job runs in `truss-publish` and assumes an image-registry-only role. The deployment job runs in `truss` and assumes the deployment role. Separate role names with the same subject would not create that boundary, and both jobs check their own claims before assuming anything. Before a release advances, the workflow requires actual AWS denials when the deployment role tries to read bootstrap, platform and installation state or the runtime database secret. It records those results in `iam-read-boundary.json`; missing resources and command failures do not count as access denials.

The workflow has no first-installation route. Installation is the explicit operator procedure in [First installation](#first-installation) and [Initialize the database before admitting traffic](#initialize-the-database-before-admitting-traffic).

Configure both environments before their first use, and inspect an existing environment instead of replacing someone else's protection rules. Read the repository's actual numeric identifiers rather than assuming them; the trust policy and both workflow claims name `1362084625` for the repository and `1649505` for the owner, and a repository created or transferred later has different values.

```sh
gh api --method PUT repos/trussworks/one-door/environments/truss --input - <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api --method POST repos/trussworks/one-door/environments/truss/deployment-branch-policies --input - <<'JSON'
{"name":"main","type":"branch"}
JSON
gh api --method PUT repos/trussworks/one-door/environments/truss-publish --input - <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api --method POST repos/trussworks/one-door/environments/truss-publish/deployment-branch-policies --input - <<'JSON'
{"name":"main","type":"branch"}
JSON
gh variable set AWS_ROLE_ARN --repo trussworks/one-door --env truss --body arn:aws:iam::004351505091:role/one-door-truss-release
gh variable set AWS_PUBLISH_ROLE_ARN --repo trussworks/one-door --env truss-publish --body arn:aws:iam::004351505091:role/one-door-truss-publish
gh variable set DEPLOYMENT_PLATFORM --repo trussworks/one-door --env truss < "$DEPLOYMENT_DIR/platform.json"
```

Verify the branch policies, the role variables and the platform metadata before the dispatch:

```sh
gh api repos/trussworks/one-door/environments/truss/deployment-branch-policies --jq '.branch_policies[].name'
gh api repos/trussworks/one-door/environments/truss-publish/deployment-branch-policies --jq '.branch_policies[].name'
gh variable list --repo trussworks/one-door --env truss
gh variable list --repo trussworks/one-door --env truss-publish
gh api repos/trussworks/one-door/actions/permissions
```

Both branch policies must name `main`. `AWS_ROLE_ARN` must name the Truss release role and `AWS_PUBLISH_ROLE_ARN` the Truss publish role above. Refresh `DEPLOYMENT_PLATFORM` from the applied platform output and compare the stored JSON with that output whenever an operator changes the platform. Stale metadata carries the old origin into `APP_ORIGIN`, and the application compares the browser's `Origin` header with it exactly, so every state-changing request would fail with `ORIGIN_MISMATCH`. A different repository or branch requires corresponding reviewed changes to the Terraform trust policy and workflow claims; do not substitute another identity only on one side.

The personal deployment used `rswerve/one-door` with `personal` and `personal-publish` environments and a push trigger on `main`. Its automatic releases are paused, and pausing them is what keeps one approved commit from deploying to both accounts.

When the launch run is authorized, dispatch `Truss AWS release` against `main`. The workflow runs every repository check through its reusable call before publishing a `linux/amd64` image with an immutable tag, digest, provenance and software bill of materials (SBOM). It also records the exact image's static manifest and the source's migration, fixture, job and dependency identities. After checks and image scanning pass, the deploy job uses the GitHub OIDC release role to publish and verify assets, apply the release stack and roll the two services. It cannot initialize a database or start a stopped installation: both are the operator procedure above. No workstation AWS session is required for those release steps. `DEPLOYMENT_PLATFORM` contains platform resource references, not secret values.

The commit the run builds must already be on `main`, and pushing it starts nothing while Actions stays disabled. Enable Actions immediately before the dispatch and disable it again once the run finishes, so no later push can consume a second run.

```sh
gh workflow run release.yml --repo trussworks/one-door --ref main
gh run list --workflow release.yml --repo trussworks/one-door --limit 5
```

Every release command takes the full forty-character revision of the record it is about to run, and compares the two, so a mismatch stops before anything is applied. The revisions differ by operation: the rehearsal's start action runs the promoted personal release and takes that record's revision, which [Promote the approved image](#promote-the-approved-image) exports; a rolling release after launch takes the launch commit.

Choose the successful run for the exact approved revision. Enter its numeric run ID into the following `read` command, then download the artifact. A failed run is not eligible.

```sh
read -r RELEASE_RUN
export RELEASE_RUN
mkdir -p "$DEPLOYMENT_DIR/releases"
RELEASE_DIR="$(mktemp -d "$DEPLOYMENT_DIR/releases/$RELEASE_RUN-XXXXXXXX")"
export RELEASE_DIR
printenv RELEASE_DIR
gh run view "$RELEASE_RUN" --repo trussworks/one-door --json headSha,status,conclusion
export IMAGE_ARTIFACT="$(gh api "repos/trussworks/one-door/actions/runs/$RELEASE_RUN/artifacts" --jq '[.artifacts[] | select(.name | startswith("truss-release-image-"))] | max_by(.id).name')"
gh run download "$RELEASE_RUN" --repo trussworks/one-door --name "$IMAGE_ARTIFACT" --dir "$RELEASE_DIR/image"
```

Keep the printed `RELEASE_DIR` for this attempt; each download uses a fresh directory and preserves earlier evidence. Require `status: completed`, `conclusion: success`, and a `headSha` equal to `image.json`'s `sourceRevision`. Preserve the downloaded `image.json`, `assets.json` and `release.json`. Review the retained `scans.json`; the workflow enforces the image-scan gate before starting tasks.

Download the deployment evidence from the same successful run and verify public readiness:

```sh
export DEPLOYMENT_ARTIFACT="$(gh api "repos/trussworks/one-door/actions/runs/$RELEASE_RUN/artifacts" --jq '[.artifacts[] | select(.name | startswith("truss-deployment-evidence-"))] | max_by(.id).name')"
gh run download "$RELEASE_RUN" --repo trussworks/one-door --name "$DEPLOYMENT_ARTIFACT" --dir "$RELEASE_DIR/deployment"
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const result = JSON.parse(readFileSync(process.env.RELEASE_DIR + '/deployment/result.json', 'utf8'));
assert.equal(result.ready, true);
const response = await fetch(result.origin + '/api/health');
assert.equal(response.status, 200);
assert.equal((await response.json()).status, 'ok');
console.log('Public readiness confirmed:', result.origin);
JS
```

The full release record is stored with a conditional create under `release-records/RELEASE_ID/release.json` in the private assets bucket and read back before a service advances. Existing task-definition revisions and asset namespaces are retained.

Open the `origin` from `deployment/result.json` in a browser and use the access code in the private access file. Follow the [first request](../README.md#first-request) journey. A green deployment establishes exact running images and public readiness; hosted login, model processing, alert delivery and recovery evidence still need their respective checks before the rehearsal is declared complete.

After hosted checks pass, follow [Enable notifications and rollback alarms](#enable-notifications-and-rollback-alarms). Those steps apply after automated or manual installation. Platform notification changes and RDS failover or restore operations require current infrastructure credentials; release OIDC credentials cannot modify those resources.

## Enable notifications and rollback alarms

Both platform variable files set `alarm_actions_enabled = true`, so alarm actions are live from the platform apply and no separate step turns them on. The variable has no default: a platform plan that omits the value fails rather than silently disabling notifications. What remains is proving delivery and arming rollback.

Prove delivery on a notification-only alarm, never on the readiness alarm that ECS rolls back from. Set `one-door-truss-ecs-api` (`one-door-personal-ecs-api` for the personal deployment) to `ALARM` with an explicit test reason and let the next evaluation return it to OK; that alarm carries both an alarm action and an OK action, so the recipient should receive two messages. Require the alarm history and the recipient's confirmation of receipt. A confirmed subscription is not delivery. Require valid, healthy probe measurements as well, not merely an alarm that has never evaluated.

If a platform change is needed for another reason, save and review the plan the same way:

```sh
terraform -chdir=infra/platform plan -input=false -var-file="../environments/$ONE_DOOR_ENVIRONMENT.tfvars" -var-file="../environments/$ONE_DOOR_ENVIRONMENT.platform.tfvars" -out="$DEPLOYMENT_DIR/monitoring.plan"
```

After reviewing the plan:

```sh
terraform -chdir=infra/platform apply -input=false "$DEPLOYMENT_DIR/monitoring.plan"
```

Keep `alarm_actions_enabled = true` in both checked-in inputs; a plan that drops it fails. Expect the readiness, web-count and worker-count alarms to sit in ALARM from the platform apply until the first tasks are healthy, and to notify the recipient while they do. That is a normal first installation, not a fault, and suppressing the actions is not an option: a release refuses to proceed unless every application alarm has its notification actions enabled. To enable rollback alarms after a manual release, start from the actual current release settings:

```sh
terraform -chdir=infra/release init -input=false -backend-config="$DEPLOYMENT_DIR/release.backend.hcl"
terraform -chdir=infra/release output -json settings > "$DEPLOYMENT_DIR/monitoring-release.json"
```

Then save and review the alarm plan:

```sh
python3 - <<'PYVARS'
import json, os
from pathlib import Path
file = Path(os.environ['DEPLOYMENT_DIR']) / 'monitoring-release.json'
settings = json.loads(file.read_text())
settings['deployment_alarms_enabled'] = True
file.write_text(json.dumps(settings, indent=2) + '\n')
PYVARS
terraform -chdir=infra/release plan -input=false -var-file="$DEPLOYMENT_DIR/monitoring-release.json" -out="$DEPLOYMENT_DIR/rollback-alarms.plan"
```

After reviewing the plan:

```sh
terraform -chdir=infra/release apply -input=false "$DEPLOYMENT_DIR/rollback-alarms.plan"
```

First installation acceptance requires actual alarm delivery, hosted access and processing receipts, and database acceptance. RDS restore and failover exercises remain deferred. The alert recipient must confirm receipt of the delivery test.

## Subsequent automated releases

Automatic releases are paused in both accounts, and the launch reserves the one authorized Truss run, so there is no routine automated release today. Restoring one needs a separate ruling on the ongoing CI budget. When that happens, repeat the successful-run verification, artifact downloads and public readiness checks above, and refresh `DEPLOYMENT_PLATFORM` whenever an operator changes the platform. The workflow always deploys in release mode; it cannot start a first installation. Until then, use [Manual release operations](#manual-release-operations).

Automation verifies the current running image and task counts before preparing a candidate. After migration, a separate fixture-upgrade task applies known reference updates while preserving live rows and manual review assignments. An unknown installed fixture manifest blocks release before services advance. Every reference-fixture change must register the outgoing fixture hash and its safe upgrade in the same change. Missing reference data also blocks a release; first installation seeds it explicitly. Changed schemas or incompatible job contracts require a separately verified maintenance release. Use [Manual release operations](#manual-release-operations) for that path or a compatible rollback.

If an installation fails, inspect its retained task output and deployment evidence before retrying. Reusing the same image and operation ID recovers an uncertain task submission; it does not re-execute a task already known to have failed. A corrected source release receives a new image and operation ID. If tasks already started, inspect actual counts, task definitions, image digests and readiness before continuing. A partial or rolled-back deployment needs the manual recovery path; do not force saved counts to zero to make an installation step pass.

## Manual release operations

The launch workflow is reserved for the final approved run; the rehearsal uses the operator procedure below. The commands in this section are for an operator deliberately performing or recovering a release manually. Do not run first-install zero-count plans against an application that the pipeline has already started; export and preserve the actual current settings first. The installer refuses that case for you: it requires both services to be stopped before it plans and before it applies.

### Promote the approved image

The rehearsal runs on the approved personal image, so it takes its own read-only download from the selected successful `rswerve/one-door` release. Do not reuse the Truss launch-run artifacts here: that run installs onto a rehearsal that already exists, so waiting for it would leave the rehearsal with nothing to run.

Choose the successful `rswerve` run for the revision you approved and download its image record:

```sh
read -r SOURCE_RUN
export SOURCE_RUN
mkdir -p "$DEPLOYMENT_DIR/source"
export SOURCE_DIR="$(mktemp -d "$DEPLOYMENT_DIR/source/$SOURCE_RUN-XXXXXXXX")"
printenv SOURCE_DIR
gh run view "$SOURCE_RUN" --repo rswerve/one-door --json headSha,status,conclusion
export SOURCE_ARTIFACT="$(gh api "repos/rswerve/one-door/actions/runs/$SOURCE_RUN/artifacts" --jq '[.artifacts[] | select(.name | startswith("personal-release-image-"))] | max_by(.id).name')"
gh run download "$SOURCE_RUN" --repo rswerve/one-door --name "$SOURCE_ARTIFACT" --dir "$SOURCE_DIR/image"
export SOURCE_REVISION="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.SOURCE_DIR + "/image/image.json", "utf8")).sourceRevision')"
```

Require `status: completed`, `conclusion: success`, and a `headSha` equal to the exported `SOURCE_REVISION`. The download reads a `rswerve` run and changes nothing there.

Authenticate to both registries under a private Docker configuration, so no credential reaches the shared one. On macOS an empty private configuration hides Buildx, because the plugins live beside the Docker application rather than in the configuration directory, so name that directory and confirm Buildx answers before going further:

```sh
export DOCKER_CONFIG="$DEPLOYMENT_DIR/docker-auth"
export DOCKER_CLI_PLUGINS=/Applications/Docker.app/Contents/Resources/cli-plugins
test -x "$DOCKER_CLI_PLUGINS/docker-buildx" || exit 1
mkdir -p "$DOCKER_CONFIG"
node --input-type=module <<'JS'
import {existsSync, writeFileSync} from 'node:fs';
const file = process.env.DOCKER_CONFIG + '/config.json';
if (!existsSync(file)) writeFileSync(file, JSON.stringify({cliPluginsExtraDirs: [process.env.DOCKER_CLI_PLUGINS]}), {mode: 0o600, flag: 'wx'});
JS
docker buildx version || exit 1
```

A new configuration initially contains only the plugin directory. The logins below add short-lived registry credentials to this private file; reruns preserve them. Nothing is copied from the shared configuration. Require a Buildx version from the last command; promotion copies through Buildx and would otherwise fail after the logins. Adjust the plugin path for another installation, and stop if the directory is absent rather than continuing without Buildx.

Reading the source registry needs the personal account and writing the destination needs Truss, so each login proves its account before taking a token. Set `ONE_DOOR_SOURCE_PROFILE` to the working personal profile on this workstation; the name varies by installation:

```sh
export ONE_DOOR_SOURCE_PROFILE=personal-sandbox-tools
set -o pipefail
test "$(aws --profile "$ONE_DOOR_SOURCE_PROFILE" sts get-caller-identity --region us-west-2 --query Account --output text)" = 845191826742 || exit 1
aws --profile "$ONE_DOOR_SOURCE_PROFILE" ecr get-login-password --region us-west-2 |
  docker login --username AWS --password-stdin 845191826742.dkr.ecr.us-west-2.amazonaws.com || exit 1

test "$(aws sts get-caller-identity --region us-west-2 --query Account --output text)" = 004351505091 || exit 1
aws ecr get-login-password --region us-west-2 |
  docker login --username AWS --password-stdin 004351505091.dkr.ecr.us-west-2.amazonaws.com || exit 1
```

Use the explicit `--profile` flag for the source: setting `AWS_PROFILE` alone does not override the temporary credential environment created by `aws-vault`. Both account checks were exercised on the operator workstation. The explicit exits and pipeline failure handling stop on a failed check or login. The second uses the surrounding Truss context from [Select the Truss sandbox account](#select-the-truss-sandbox-account), so a shell opened for another account stops here. A failed check closes that credential shell. Re-enter it and restore the exports before resuming, keeping the existing state and artifacts.

Commit the reviewed deployment changes first. The command records the revision of the tooling that performed the copy, and refuses to run with modified tracked files, so an uncommitted change would leave a promotion nobody can reproduce.

Then copy the image. The command takes the Truss platform output, the downloaded personal release record, the source revision it carries, and a private directory that must not already exist:

```sh
node --experimental-strip-types scripts/deploy/promote-image.ts "$DEPLOYMENT_DIR/platform.json" "$SOURCE_DIR/image/release.json" "$SOURCE_REVISION" "$DEPLOYMENT_DIR/promotion"
```

The promoted record keeps the selected source revision and release ID; never rebuild a record from the current tools.

It refuses a destination that is not the Truss account, a release record whose revision differs from the one you supplied, a record whose digest disagrees with its own image reference, and a destination repository whose tags are mutable. If the release tag already exists in the destination it must name the same digest; a tag pointing at another image stops the promotion rather than moving it.

The copy uses Docker Buildx `imagetools create` against the source index. Afterwards the command re-reads the destination tag and requires the approved digest, then copies the result into a local OCI layout and walks it: the index, every child manifest, each manifest's config and every layer, checking each blob's byte length and SHA-256 against its own descriptor. A matching index alone would not establish a complete copy, so the whole referenced set is read back.

Four files land in the private directory at mode `0600`, and the command refuses to overwrite any of them. `source-release.json` keeps the personal record unchanged. `release.json` is the same record with only the image reference rebound to the Truss repository, preserving the release ID, source revision and content identities. `image.json` names the revision, release ID, image, account and region. `promotion.json` records the copy time, both image references, the Buildx version, the deployment-tool revision and every verified blob digest.

`promotion.json` records `scan: "pending"`, and the command says so when it finishes: promotion copies and verifies, and never scans.

Both the start action and a rolling release scan the image they are about to run before they publish assets or advance either service, and write the result to `scans.json` in the operation's private directory. A critical or high finding stops service rollout. The earlier installer also scans before creating the definitions used for database initialization. The launch run scans the image it builds through the same check.

### Publish the release assets

Read the image reference and release ID from the promotion record, then pull the exact Linux image. Both registry logins are already in place from the promotion above:

```sh
export ONE_DOOR_IMAGE="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.DEPLOYMENT_DIR + "/promotion/image.json", "utf8")).image')"
export RELEASE_ID="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.DEPLOYMENT_DIR + "/promotion/image.json", "utf8")).releaseId')"
docker pull --platform linux/amd64 "$ONE_DOOR_IMAGE"
```

Export and upload only the image's `.next/static` files. The helper uses a fresh export directory on every attempt, accepts already-published identical objects, refuses conflicting objects and uses conditional S3 creates. It verifies every stored checksum, size and cache/content header. The containers and exported files remain available for inspection.

```sh
node --experimental-strip-types scripts/deploy/upload-assets.ts "$DEPLOYMENT_DIR/platform.json" "$ONE_DOOR_IMAGE" "$RELEASE_ID" > "$DEPLOYMENT_DIR/assets-upload.log"
```

Require `Release assets published and verified.` in the log. Compare its `manifestSha256` with the downloaded release record's `assetsManifestSha256`. Retain and publish the full release record with a conditional create; never overwrite another record for the same release ID. Do not use `sync --delete`.

Check ECR's executable-image scan and resolve material findings before starting public tasks; a successful build does not establish a safe image.

### Initialize the database before admitting traffic

Create the variable file from the actual platform output and approved image artifact. The first installation defaults to zero web and worker tasks and disabled rollback alarms; this file makes those values explicit.

```sh
python3 - <<'PYVARS'
import json, os
from pathlib import Path
root = Path(os.environ['DEPLOYMENT_DIR'])
platform = json.loads((root / 'platform.json').read_text())
image = json.loads((Path(os.environ['DEPLOYMENT_DIR']) / 'promotion/image.json').read_text())
settings = dict(platform=platform, candidate_image=image['image'],
                released_image=image['image'], web_count=0, worker_count=0,
                deployment_alarms_enabled=False)
(root / 'release.json').write_text(json.dumps(settings, indent=2) + '\n')
PYVARS
```

Save the plan through the guarded installer rather than calling Terraform directly. It confirms the account, requires both services to be stopped now, checks the variable file keeps both counts at zero on the approved image, scans that image and writes the result beside the plan as `<plan>.scan.json`, runs the plan, and then reads the saved plan back to require that it names exactly the two application services in this cluster and starts no task:

```sh
terraform -chdir=infra/release init -input=false -backend-config="$DEPLOYMENT_DIR/release.backend.hcl"
node --experimental-strip-types scripts/deploy/initialize-deployment.ts "$DEPLOYMENT_DIR/platform.json" plan "$DEPLOYMENT_DIR/release.json" "$DEPLOYMENT_DIR/release-prepare.plan"
```

Require `Installation plan verified; review it before applying.` and review the saved plan yourself, along with its `.scan.json`. Then apply it through the same installer, which re-checks the plan, scans the image the plan names again into `<plan>.apply-scan.json` so the plan's own `<plan>.scan.json` survives, and confirms the services are still stopped both before and after, and export the actual one-off task definitions:

```sh
node --experimental-strip-types scripts/deploy/initialize-deployment.ts "$DEPLOYMENT_DIR/platform.json" apply "$DEPLOYMENT_DIR/release-prepare.plan"
terraform -chdir=infra/release output -json tasks > "$DEPLOYMENT_DIR/tasks.json"
```

Require `Installation services are confirmed stopped; bootstrap may proceed.` before running any task.

The release stack does not own the `bootstrap` task, so `tasks.json` above does not contain it. Database bootstrap is the only task that receives the RDS administrator credential, and ECS authorizes `iam:PassRole` when a task definition is registered rather than when it runs. Keeping that definition out of release Terraform is what lets the deployment role give up administrator reach. Apply the installation stack with your own infrastructure credentials, and export its task separately:

```sh
python3 - <<'PYVARS'
import json, os
from pathlib import Path
root = Path(os.environ['DEPLOYMENT_DIR'])
image = json.loads((Path(os.environ['DEPLOYMENT_DIR']) / 'promotion/image.json').read_text())
settings = dict(platform=json.loads((root / 'platform.json').read_text()), image=image['image'])
(root / 'install.json').write_text(json.dumps(settings, indent=2) + '\n')
PYVARS
terraform -chdir=infra/install init -input=false -backend-config="$DEPLOYMENT_DIR/install.backend.hcl"
terraform -chdir=infra/install plan -input=false -var-file="$DEPLOYMENT_DIR/install.json" -out="$DEPLOYMENT_DIR/install.plan"
```

Review that plan, then apply it and export the installation task:

```sh
terraform -chdir=infra/install apply -input=false "$DEPLOYMENT_DIR/install.plan"
terraform -chdir=infra/install output -json tasks > "$DEPLOYMENT_DIR/install-tasks.json"
```

Run bootstrap from the installation task file, then migration and seed from the release task file, in that order. Each operation has a distinct ID derived from this immutable release. Reuse an ID only when retrying the same submission whose outcome is unknown.

```sh
node --experimental-strip-types scripts/deploy/run-task.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/install-tasks.json" bootstrap "$RELEASE_ID-bootstrap"
node --experimental-strip-types scripts/deploy/run-task.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/tasks.json" migration "$RELEASE_ID-migration"
node --experimental-strip-types scripts/deploy/run-task.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/tasks.json" seed "$RELEASE_ID-seed"
node --experimental-strip-types scripts/deploy/run-task.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/tasks.json" verification "$RELEASE_ID-database-verification"
node --experimental-strip-types scripts/deploy/run-task.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/tasks.json" diagnostic "$RELEASE_ID-initial-digest" > "$DEPLOYMENT_DIR/initial-digest.log"
```

Each command must confirm that the named task stopped with exit code zero. The `verification` task runs packaged `scripts/rds-acceptance.mjs`; require its final `complete: true` with no failed or limited checks. Packaging the program avoids the ECS task-override size limit. Task submission alone does not establish completion. Bootstrap checks database and role ownership before making changes, creates a database with the `C` locale and UTF-8 encoding, separates migrator/runtime/diagnostic roles, and grants access to future objects. Migration checks the migration ledger and applies changes transactionally. Seed is for first installation; normal releases do not reset fixtures. Diagnostics emit each table's count and full-row digest, including the ledger and fixture-manifest tables; compare those contents with the approved release evidence rather than interpreting counts alone as a match.

After database acceptance and asset verification pass, start the application through the guarded installer. Give it the release record and the source revision you selected yourself; the installer refuses a record whose revision differs, so a record from another commit cannot start a deployment.

```sh
node --experimental-strip-types scripts/deploy/initialize-deployment.ts "$DEPLOYMENT_DIR/platform.json" start "$DEPLOYMENT_DIR/promotion/release.json" "$DEPLOYMENT_DIR/start" "$SOURCE_REVISION"
```

The start action requires both services stopped, no serving revision pins, rollback alarms unarmed and a platform matching the one you supplied, then re-checks that nothing is running immediately before it raises the counts. It scans the image and writes `scans.json` before anything else advances, registers the task definitions, runs the migration, fixture-upgrade and verification jobs, raises both counts to two, verifies the release, confirms public readiness over HTTPS, waits for the readiness alarm to report OK, and only then arms rollback alarms and verifies their wiring. It never runs bootstrap or seed, so the database work above stays an explicit operator step.

Rolling releases are a separate command and cannot start a stopped installation: `deploy-release.ts` requires two web tasks and two workers already running.

A failed first start needs care, because neither command will resume it. If the failure happens after the counts reach two, the start action refuses the state as no longer stopped, and a rolling release refuses it because verification fails against the unhealthy tasks. AWS does not recover it either: the ECS circuit breaker rolls back only to a previous completed deployment, and a first deployment has none, so a failed first rollout stalls rather than reverting. Recover through Terraform in `infra/release` with your own credentials. Preserve the evidence first, because neither part survives a retry:

```sh
terraform -chdir=infra/release output -json settings > "$DEPLOYMENT_DIR/failed-settings.json"
node --experimental-strip-types scripts/deploy/verify-release.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/start/tasks.json" "$ONE_DOOR_IMAGE" > "$DEPLOYMENT_DIR/failed-verification.log" 2>&1 || true
```

Keep the stopped-task events as well; they name the cause. Then work from the exported settings rather than any plan saved before the failure: state has changed since those plans were made, so applying one would act on a deployment that no longer exists. Correct the diagnosed cause in the exported settings, save a fresh plan, review it, and apply it. Verify the intended image and task revisions afterwards before calling the deployment recovered.

Three shortcuts make the state worse rather than better. Resetting the counts to zero to make the start action accept the installation again discards the running deployment's evidence and re-runs work that already happened. Rerunning the seed task overwrites reference data the migration and fixture-upgrade jobs have already advanced. Bypassing the running-release preflight hides the unhealthy tasks that stopped the release in the first place.

### Manual subsequent releases and rollback

Export `terraform -chdir=infra/release output -json settings` into a new private variable file before preparing a candidate. The output preserves the current released image, counts and alarm setting. Change only `candidate_image` for the preparation phase; web and worker images must remain on `released_image`. Preparation registers the candidate task definitions and leaves the running services on the definitions they already serve, so a source change that the running image cannot satisfy cannot reach a task before promotion. The release inputs carry the currently serving definitions for that purpose; read them immediately before preparing, and require the preparation plan to show no service change at all. Keep every previous release record and asset namespace.

Require the candidate's exact-commit CI, asset verification, migration checksums and prompt/job-contract compatibility checks. Run the candidate migration task before changing `released_image`. Test the prior image against the resulting schema. Additive SQL alone is not evidence of compatibility.

Workers mark a job as `superseded` when its prompt version differs from the version the worker uses for that job's purpose. A changed prompt/job contract therefore blocks a normal rolling release. Pause new writes, drain the old jobs and plan a controlled maintenance release; do not let incompatible workers consume each other's jobs.

Once the running environment is healthy, enable platform notifications with `alarm_actions_enabled=true` and release rollback alarms with `deployment_alarms_enabled=true`, using separately reviewed plans. Do not begin later releases while readiness alarms are already in `ALARM` or missing valid measurements.

For a compatible rollback, set `released_image` to the retained, verified prior digest through Terraform. Keep the current schema and assets. Apply the saved rollback plan, re-export task definitions, and run exact release verification plus hosted smoke checks. Database recovery is a separate operation, because a restored database can omit newer writes.

### Move an existing bootstrap task into the installation stack

An installation made before the installation stack existed has its bootstrap task definition in release state. Move ownership once, without registering a new revision. Both stacks declare `skip_destroy`, so removing the resource from release state deregisters nothing in AWS.

Stop all release and installation activity first, and keep it stopped for the whole sequence. Two states describing the same task definition is safe only while nothing applies; an apply from either side during the move can register a competing revision.

Record what you need privately and record only what you need. Raw Terraform state and full `state show` output can contain sensitive values, so do not print or paste either. Write down the task-definition revision ARN, the image digest, and the release and installation state version IDs, into `$DEPLOYMENT_DIR` under `umask 077`.

```sh
terraform -chdir=infra/release state list | grep 'aws_ecs_task_definition.job\["bootstrap"\]'
aws s3api head-object --region us-west-2 --bucket "one-door-state-$(aws sts get-caller-identity --query Account --output text)-us-west-2" --key release/terraform.tfstate --query VersionId
```

Import the existing revision into the installation stack using the same variable file the stack normally takes, then require a no-op plan:

```sh
terraform -chdir=infra/install init -input=false -backend-config="$DEPLOYMENT_DIR/install.backend.hcl"
terraform -chdir=infra/install import -var-file="$DEPLOYMENT_DIR/install.json" aws_ecs_task_definition.bootstrap "$BOOTSTRAP_TASK_ARN"
terraform -chdir=infra/install plan -input=false -var-file="$DEPLOYMENT_DIR/install.json" -out="$DEPLOYMENT_DIR/install-adopt.plan"
```

Review that plan and require no changes, with one exception. `terraform import` records a task definition without the `skip_destroy` setting, which the configuration declares, so the first plan after an import may show that one attribute moving from null to true and nothing else. The AWS provider applies that attribute in state alone: its task-definition update path performs a read and no API write. Apply that plan, then take a second plan and require it to be empty before continuing. Reject every other difference — anything touching the family, image, execution role, secrets, command or container settings means the rendered definition differs from the live one, and registering a new revision is not an adoption. Import records attributes from the live resource, so a refresh is needed only when the plan reports one; if it does, apply the reviewed no-op plan before continuing.

Only after the plan is clean, release the old ownership and prove both sides agree:

```sh
terraform -chdir=infra/release state rm 'aws_ecs_task_definition.job["bootstrap"]'
terraform -chdir=infra/release plan -input=false -var-file="$DEPLOYMENT_DIR/release.json" -out="$DEPLOYMENT_DIR/release-check.plan"
terraform -chdir=infra/install output -json tasks > "$DEPLOYMENT_DIR/install-tasks.json"
```

The release plan must contain no action for the bootstrap family, and the installation output must name the revision ARN recorded at the start. Only then apply the bootstrap change that removes administrator `iam:PassRole` from the deployment role. Applied earlier, a release still registering that family fails partway through its apply.

If the sequence is interrupted after the import and before the removal, both states describe the same revision; resume by repeating the removal, with applies still stopped. If the removal ran but the release source still declares the job, the next release re-registers the family under the old grants; land the release-source change before narrowing. To return ownership, import the revision back into release state and remove it from installation state, in that order.

## Diagnose and recover

| Symptom                                        | Check and response                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS account mismatch; no changes attempted`   | Select the intended temporary credentials; do not change the account guard to match an accidental profile.                                     |
| Terraform reports a lock                       | Identify the other operation and let it finish. Never force-unlock while another writer might be alive.                                        |
| Saved plan is stale                            | Save a fresh plan from current remote state and review it. Do not bypass locking or state checks.                                              |
| ECS stabilizes on an old task definition       | Treat the candidate as failed, inspect service events and logs, and retain the last working image.                                             |
| `/api/live` works but `/api/health` fails      | Investigate database reachability, TLS, grants and migrations. Local health deliberately avoids replacing every task during a database outage. |
| `probe-missing` alarms                         | Check Lambda errors, invocation permissions and CloudWatch publishing. Missing measurements are not healthy measurements.                      |
| `ecs-api` alarms but HTTP readiness is healthy | Investigate the ECS API measurement path; the probe preserves the independent HTTP result.                                                     |
| Provider processing fails                      | Inspect sanitized worker logs and the stored provider receipt. Never report a generated answer unless the real call and persistence completed. |
| Existing bootstrap roles are rejected          | Investigate ownership. Do not adopt an unrelated role or reset its password to make installation pass.                                         |

Application, operations and worker logs live under `/one-door/personal/` in `us-west-2`. CloudFront and WAF logs live in `us-east-1`. CloudFront logs omit cookies and query strings; WAF logging redacts authentication fields. Database and flow logs have bounded retention. Check actual log arrival, not just resource existence.

A database that stops answering behaves in a measured way. Each worker pass opens its own connection, so an unreachable database is bounded by the client's five-second connect timeout and the loop keeps iterating. A connection whose response is withheld after the query is already running is different: the loop blocks inside that query and the health marker stops advancing. In a relay experiment the container health check reported live at 299,538 ms of marker age and not live at 304,548 ms, which brackets the five-minute bound. A worker stalled that way did not exit within 60 seconds of SIGTERM and needed SIGKILL; the release stack configures `stopTimeout = 120`, and the experiment did not run long enough to observe that full window. Delivering the withheld response resumed normal iteration within one five-second sample, with no restart and no operator step. Detection comes from the metrics rather than the health check: `QueueCollectionSucceeded` falls and `WorkerPollErrors` rises within one metrics interval, while `Heartbeat` holds until the last successful poll is more than five minutes old.

Use the allowlisted one-off diagnostic task for database inspection. ECS Exec, SSH and operator credentials in application tasks remain disabled. A repair requires a separately reviewed migration or operation using its own execution role.

Use [Pause, rotate and recover](RECOVERY.md) to save and restore service counts, rotate or roll back the access code or session-signing secret, and prepare an isolated RDS restore. Hosted rotation checks and the complete restored-application rehearsal remain pending. Before database recovery, record the source instance, restorable time and encryption key. Restore to a **new** RDS identifier in private database subnets with the intended security group and parameter group. Keep the original database. Compare full-row table digests, the migration ledger and fixture metadata. Test an application connected to the restored instance before deciding whether to cut over. Counts alone do not establish restoration correctness. Record elapsed time and the gap between the restore point and the latest committed writes.

Database and provider credential rotation require coordinated updates to the database or provider and Secrets Manager, followed by new tasks and verification before retiring the old credentials. Access-code changes affect subsequent logins; signing-secret changes invalidate existing sessions. Rehearse those consequences with disposable identities. Never revoke a shared provider key merely to test failure.

## Maintenance and retention

Maz owns the personal environment. Nothing in this section deletes or expires anything; activating any expiry rule needs Maz's explicit approval of the concrete policy and the concrete candidate list first.

### Dependency and patch cadence

[Dependabot](../.github/dependabot.yml) opens weekly update pull requests for npm packages, the Dockerfile's base images and the pinned GitHub Actions, in bounded batches with no automatic merging. Updates reach Truss through a reviewed, manually dispatched release. Personal releases remain paused.

Weekly, and again before a client rehearsal, review three things beyond those pull requests. Re-read the scan findings for the digest that is actually running, because a push-time scan reports what was known when the image was pushed rather than what is known now, and ECR basic scanning re-scans an image at most once every 24 hours. Check the Terraform and provider versions pinned in each stack. Check the RDS engine version against the available minor releases.

Update pinned base-image digests and the affected packages before rebuilding. Rebuilding unchanged pinned inputs is not patching. `auto_minor_version_upgrade` is disabled for the database, so a database patch is a deliberate operator action, planned outside an application release and outside any release window, because a maintenance reboot breaches the readiness alarm and arms the deployment circuit breaker.

### Retention

Nothing expired as of the 8 September 2026 audit, and no expiry has been added since. The logs bucket had no lifecycle configuration and the image repository had no lifecycle policy; task-definition revisions are retained by `skip_destroy`, and both assets and logs are versioned. Confirm the live state before acting on any of it. Retaining that evidence is deliberate. The risk is unbounded growth if a short rehearsal becomes a long-lived environment.

Proposed personal defaults, for approval rather than for installation: 90 days for S3 access logs, 365 days for audit logs, and current CloudWatch retention unchanged. Keep Terraform state versions, database backups and security evidence out of any blanket expiry.

Before proposing image or asset expiry, produce the candidate list from the actual references: every digest currently running or in flight, every designated rollback release, the most recent three verified releases, and at least 30 days of release history together with the matching asset namespaces, OCI manifests and attestations. A count-based or age-based ECR rule cannot recognise which digest a service is running, and a run of failed builds can age out the last good release, so do not install a rule that claims otherwise. Expiring an asset namespace while its image is still a rollback target breaks that rollback.

### What retirement actually costs

Scaling both services to zero stops Fargate charges and nothing else. Two NAT gateways, the load balancer and the Multi-AZ database keep charging until the environment is actually retired. Retirement is a separate approved operation: deletion protection, final snapshots and Terraform `prevent_destroy` stay in place until then. The personal budget notifies at $50/$65 and Truss at $75/$100; both are alerts, not spending limits.

## Validation and retained state

Run the [application checks and isolated database/browser/container procedures](../DEVELOPMENT.md) as well as the infrastructure checks below. Include `npm run test:inspect` against the administrative URL of the dedicated validation cluster. The maintained check inventory remains in [package.json](../package.json) and [Harness CI](../.github/workflows/harness-ci.yml).

```sh
terraform fmt -check -recursive infra
python3 -m unittest discover -s test/deployment -p 'test_*.py'
```

```sh
for stack in bootstrap platform release install; do
  terraform -chdir="infra/$stack" init -backend=false -input=false -lockfile=readonly &&
  terraform -chdir="infra/$stack" validate &&
  terraform -chdir="infra/$stack" test || exit 1
done
```

The Terraform tests use mocked providers and plans. They verify configuration policies; they do not prove AWS delivery, failover or recovery.

### Deliberate hosted acceptance journey

Automated release verification proves that the intended revision runs, that its tasks are healthy and that the worker loop is polling. It does not prove that the provider accepts a call, that a completion is persisted, or that a receipt is written. Only this journey does, and only for the release an operator binds it to afterwards.

Run it before a client rehearsal, and after a change to the worker, the provider, authentication, persistence or deployment. Never per commit and never on a schedule: it dispatches real provider work and spends from the demo caps that real visitors share.

The journey enters through the public demo gate, creates one obviously fictional request, waits for intake and risk processing, verifies the current asset assessment, and reloads to confirm both assessments were persisted. Assets can reuse the combined intake result; the journey requires that result's provider receipt or the receipt of a separate asset refresh. It asks for no extra model work, resets no fixtures, changes no catalog entry, deletes nothing and bypasses no quota.

After installing secrets for the selected environment, supply the journey inputs through the environment. `install-secrets.ts` writes `$DEPLOYMENT_DIR/access.txt` as the origin on the first line and `Access code: ` followed by the code on the second, so read each part rather than the whole file, and never print or paste the code:

```sh
umask 077
export ACCESS_FILE="$DEPLOYMENT_DIR/access.txt"
export E2E_BASE_URL="$(head -n 1 "$ACCESS_FILE")"
export DEMO_ACCESS_CODE="$(sed -n 's/^Access code: //p' "$ACCESS_FILE")"
export ONE_DOOR_SMOKE_MAX_MICROS=<the allowance you calculated>
export ONE_DOOR_SMOKE_EVIDENCE_DIR="$DEPLOYMENT_DIR/hosted-journeys"
npx playwright test --config playwright.hosted.config.ts
```

Before it drafts anything, the journey requires every shared bucket to have room for its whole worst case: the intake attempt budget plus the automatic attempt limit for asset matching and for risk assessment. That ceiling is read from the source the origin runs, so it needs no operator input.

`ONE_DOOR_SMOKE_MAX_MICROS` is different. No public view reports what a provider call costs, so the figure is one you calculate from the current corpus, request and prompt sizes, and it is **verified after the run, not enforced before dispatch**. The application's own daily and monthly caps remain the only limit that stops a call from being made. If you want a bound computed rather than estimated, the smallest inputs are the current per-corpus token counts for the three prompts and the model's input and output rates; a read-only diagnostic can produce both.

Cost is measured from this draft's own model-call ledger, which the request view already serves, not from a quota delta. Other visitors spend from the same buckets, so a global delta could not be attributed to this journey. A call that has not settled counts at what it reserved.

The receipt is written to `$ONE_DOOR_SMOKE_EVIDENCE_DIR/<run>/hosted-journey-receipt.json` at mode `0600`, in a fresh directory per run and outside the Playwright output directory, which is cleared on every start. It is written whether the journey succeeds or fails, so a retained request is never left unfindable. It records the origin, run, request, draft and job identities, the outcomes, the timestamps, and every model call with its purpose, status, attempt count, reserved cost and settled cost. It contains no request content, no model output, no access code, no cookie and no token, and screenshots, video and trace are disabled.

The receipt from a browser run is always `incomplete`, because nothing observed through a browser establishes which release served the request. To finish it, take a release-verification receipt before the run and another after it, then pass both with the journey receipt to the exported `finalize` helper in `test/hosted-journey.ts`. Each receipt names its verification time, the origin, the account, the released image, the acceptable digests, and for every service its task count, image digests, task ARNs, task definition, health result and, for the worker, its progress result. `finalize` takes the environment and the origin as separate inputs and checks the receipts against both, so a receipt from the other deployment cannot complete a journey. It refuses a receipt that is missing or malformed, that covers anything other than that environment's own web and worker services, that does not report exactly two distinct tasks for either, that runs a digest the released image does not cover, or that lacks progress evidence naming both verified worker tasks. It marks the journey complete only when the two observations bracket the run in time and agree on every one of those identities, so a release that changed underneath the journey cannot be credited with it.

The pair binds the journey to an immutable image digest and nothing more. Verification reports no source revision and none is inferred; the approved release record is what ties that image to a commit.

Keep the request and its cost receipts. Report their identifiers for later approved cleanup rather than removing them.

Backup, restore and failover rehearsals remain deferred for Truss. `scripts/deploy/build-restore-request.py` still tags its request `Environment=personal`, and the account guard in [RECOVERY.md](RECOVERY.md) admits the personal account only, so neither is an approved Truss restore route until both are adapted and verified. Nothing in this runbook establishes Truss backup or failover behaviour.

The deployment evidence must record live account guards, state locking, direct-origin denial, database TLS/permissions, two-user cache isolation, WAF limits, exact asset integrity, old-tab behavior, bad-candidate rollback, worker interruption/recovery, a bounded real-provider journey, rotation and actual alert delivery. Record execution gaps separately from passed checks. RDS failover and restore are not on that list: both remain deferred, so a completed installation neither includes them nor claims them.

Tests retain isolated databases, roles, worktrees, Docker containers and volumes and exported assets. AWS rehearsals also retain restored databases, snapshots, task revisions, S3 object versions and plans. Inventory exact identifiers and continuing costs before asking Maz which resources to remove. Scaling services to zero does not retire the environment; RDS, NAT gateways and the load balancer continue to incur charges. Keep deletion protection, final snapshots and Terraform `prevent_destroy` in place until a specific retirement operation is approved.

Maz owns the demo deployments. Report sanitized failures through the [private repository issues](https://github.com/trussworks/one-door/issues); include the failed command and release record, never credentials or cookies. The [application guide](../README.md#first-request) describes the requester journey.

## Rehearsal tool record

The rehearsal tools were Node.js 26.8.1/npm 11.19.0 on macOS, Node.js 24.20.0 in CI and the first runtime image, Docker Engine 29.7.2, AWS CLI 2.36.39, GitHub CLI 2.100.0, Git 2.50.1 and Python 3.14.7.

## Original personal login workaround

This is an alternative for Maz's original workstation only. Other operators keep the working profile selected above; do not run these exports on another machine.

For the original personal login, `aws sts get-caller-identity --profile personal-sandbox` and `aws login --remote --profile personal-sandbox` use the source profile. During this rehearsal, direct use of that login in `us-west-2` failed when CreateOAuth2Token returned an INVALID_REQUEST error. The verified local bridge is:

```sh
export AWS_CONFIG_FILE=/Users/atighi/.local/state/one-door/personal/aws-config
export AWS_PROFILE=one-door-personal
```

That local file uses `credential_process` to export temporary credentials from the original profile in its login region. It contains no access keys. Other operators use their own valid profile; do not copy personal login tokens.
