# Pause, rotate and recover the personal deployment

Use the account selection, private `DEPLOYMENT_DIR`, tools and initialized Terraform backends from [Operate One Door on AWS](README.md). Assign one operator to run the entire maintenance window and exclude concurrent infrastructure or secret changes. Terraform locks each apply, but the lock does not cover the secret operations between applies. These procedures retain databases, secret versions and evidence. They do not authorize deletion.

The commands below were checked against the implementation and AWS API documentation. Cloud execution is pending the first approved application release. In particular, creating an RDS instance is only the beginning of a restore test; restored application behavior and a cutover have not been exercised.

## Pause and resume application work

Pausing interrupts access to the demo. Workers receive their normal shutdown signal; any unfinished job retains its lease and provider accounting for recovery after restart. RDS, NAT gateways and the load balancer continue charging. The public URL returns an unavailable response while no web tasks run, and enabled platform alarms report the outage.

Before rotating login credentials, keep one authenticated browser session open and confirm the current access code works in a separate browser profile. Those sessions provide the before/after checks without copying cookies into logs.

Save the actual release settings before changing counts. This section starts from a running deployment with nonzero web and worker counts; first installation uses the startup procedure in the main runbook. Use a new maintenance directory so an earlier recovery record remains intact:

```sh
export MAINTENANCE_DIR="$DEPLOYMENT_DIR/maintenance-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$MAINTENANCE_DIR"
terraform -chdir=infra/release output -json settings > "$MAINTENANCE_DIR/resume.json"
```

Create a separate pause input. Preserve the platform, both image digests and all other release settings; disable deployment rollback alarms during deliberate downtime:

```sh
python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ['MAINTENANCE_DIR'])
settings = json.loads((root / 'resume.json').read_text())
settings.update(web_count=0, worker_count=0, deployment_alarms_enabled=False)
with (root / 'pause.json').open('x') as output:
    json.dump(settings, output, indent=2)
    output.write('\n')
PY
terraform -chdir=infra/release plan -input=false -var-file="$MAINTENANCE_DIR/pause.json" -out="$MAINTENANCE_DIR/pause.plan"
```

Review the saved plan: only service counts and deployment-alarm settings should change. Stop if the plan changes task definitions, images or platform settings, or replaces or deletes a resource. Apply, then inspect actual counts:

```sh
terraform -chdir=infra/release apply -input=false "$MAINTENANCE_DIR/pause.plan"
aws ecs describe-services --region us-west-2 --cluster one-door-personal --services one-door-personal-web one-door-personal-worker --query '{failures:failures,services:services[].{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}}'
aws ecs list-tasks --region us-west-2 --cluster one-door-personal --desired-status RUNNING
```

Confirm that both services appear in the response and that each has zero desired, running and pending tasks. Require an empty `failures` array and an empty task list. The task list also exposes one-off operations still running in this dedicated cluster. Wait for those operations to finish; do not rotate while another operator is migrating or inspecting the database. The rotation helper additionally checks tasks whose desired state is `STOPPED` and refuses any whose actual state is still draining.

Before recording a database restore point, confirm that workers and other tasks requested to stop have actually finished. A desired state of `STOPPED` can precede process exit:

```sh
node --experimental-strip-types --input-type=module - <<'JS'
import { aws, readPlatform, requireAccount } from './scripts/deploy/aws.ts';
import { describeTaskBatches, listDrainingTasks } from './scripts/deploy/run-task.ts';
const p = readPlatform(process.env.DEPLOYMENT_DIR + '/platform.json');
requireAccount(p);
const running = aws(['ecs', 'list-tasks', '--region', p.region, '--cluster', p.cluster_arn, '--desired-status', 'RUNNING']);
if (running.taskArns.length) throw new Error('Tasks still request RUNNING; maintenance is not quiescent');
const draining = listDrainingTasks(p);
if (draining === null) throw new Error('Task process shutdown is unconfirmed');
for (const { requested, response } of describeTaskBatches(p, draining))
  if (response.failures?.length || response.tasks.length !== requested.length ||
      response.tasks.some(task => task.lastStatus !== 'STOPPED'))
    throw new Error('Task process shutdown is unconfirmed');
console.log('Retained tasks all report STOPPED.');
JS
```

To resume after the applicable checks below, first create an input that restores the saved counts while keeping deployment rollback alarms disabled. A readiness alarm triggered by the planned outage must not roll back the intentional restart:

```sh
python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ['MAINTENANCE_DIR'])
settings = json.loads((root / 'resume.json').read_text())
settings['deployment_alarms_enabled'] = False
with (root / 'restart.json').open('x') as output:
    json.dump(settings, output, indent=2)
    output.write('\n')
PY
terraform -chdir=infra/release plan -input=false -var-file="$MAINTENANCE_DIR/restart.json" -out="$MAINTENANCE_DIR/restart.plan"
```

Review and apply the restart plan. Terraform records the submitted configuration before convergence. Re-export the task definitions, then run the verifier, which waits for completed ECS rollouts and checks the exact saved image and saved counts:

```sh
terraform -chdir=infra/release apply -input=false "$MAINTENANCE_DIR/restart.plan"
terraform -chdir=infra/release output -json tasks > "$DEPLOYMENT_DIR/tasks.json"
node --experimental-strip-types --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const settings = JSON.parse(readFileSync(process.env.MAINTENANCE_DIR + '/resume.json', 'utf8'));
execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/deploy/verify-release.ts',
  process.env.DEPLOYMENT_DIR + '/platform.json', process.env.DEPLOYMENT_DIR + '/tasks.json',
  settings.released_image, String(settings.web_count), String(settings.worker_count)], { stdio: 'inherit' });
JS
```

Complete the hosted checks for login, reading and writing required by the maintenance operation. Wait for current healthy readiness measurements, then plan and apply `resume.json` to restore the saved deployment-alarm setting. Keep the settings that actually run as the next release's input; do not return to an older file with different counts or alarm settings.

```sh
aws cloudwatch describe-alarms --region us-west-2 --alarm-names one-door-personal-readiness --query 'MetricAlarms[].{name:AlarmName,state:StateValue,reason:StateReason,updated:StateUpdatedTimestamp}' --output json
```

Require the named alarm to appear with state `OK` and a reason describing successful readiness measurements after the restart. Do not use `set-alarm-state` to satisfy this checkpoint. Then save a fresh plan, review it, and apply it:

```sh
terraform -chdir=infra/release plan -input=false -var-file="$MAINTENANCE_DIR/resume.json" -out="$MAINTENANCE_DIR/restore-alarms.plan"
```

Review the saved plan before applying it. Require only the expected count and alarm-setting changes:

```sh
terraform -chdir=infra/release apply -input=false "$MAINTENANCE_DIR/restore-alarms.plan"
terraform -chdir=infra/release output -json settings
```

Confirm the output's counts, images and `deployment_alarms_enabled` match the original `resume.json`.

## Rotate the access code or session-signing secret

[ECS injects secret values when a task starts](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html); changing Secrets Manager does not update a running task. A maintenance restart avoids web tasks disagreeing about login credentials. Changing the access code affects new logins. Changing the signing secret invalidates existing sessions, including their access to drafts tied to the old session.

Set `ROTATION_SECRET` to `gate` to rotate the access code or `session` to rotate the session-signing secret. Start with `gate` for the rehearsal, and use a separate record for each secret. Preparation creates a new retained secret version without changing `AWSCURRENT`. It records version identifiers and a verification digest locally and sends the generated value through standard input, never an argument or log:

```sh
export ROTATION_SECRET=gate
export ROTATION_RECORD="$MAINTENANCE_DIR/$ROTATION_SECRET-rotation.json"
node --experimental-strip-types scripts/deploy/rotate-secret.ts "$DEPLOYMENT_DIR/platform.json" "$ROTATION_SECRET" "$ROTATION_RECORD" prepare
```

Require `Secret version prepared; AWSCURRENT is unchanged:`. If a response is lost, repeat the command with the same `ROTATION_RECORD` path. Do not create a new record when retrying an operation whose outcome is unknown. The helper recovers the prepared version by its persisted request token and checks its content against the digest recorded before the first write. If the record exists but the version is unavailable, the command fails without guessing another value. Resolve the previous attempt before starting a new preparation; do not promote an unverified version. Each preparation retains a staging label and uses Secrets Manager quota for secret versions and staging labels; this bounded rehearsal does not install an automatic rotation service or clean up versions.

After pausing the services, activate the prepared version:

```sh
node --experimental-strip-types scripts/deploy/rotate-secret.ts "$DEPLOYMENT_DIR/platform.json" "$ROTATION_SECRET" "$ROTATION_RECORD" activate
```

Require `Current secret version confirmed; web service remains stopped:`. The helper refuses active, provisioning or draining web tasks, checks the account, and asks AWS to reject a competing change to `AWSCURRENT`. Readback confirms the requested version before the command reports success. Concurrent infrastructure changes must remain excluded throughout maintenance.

For an access-code change, write the new access details to a fresh private file through the existing installer. Existing secret values are preserved:

```sh
node --experimental-strip-types scripts/deploy/install-secrets.ts "$DEPLOYMENT_DIR/platform.json" "$MAINTENANCE_DIR/access-after-rotation.txt"
```

Resume the services as above. In separate browser sessions, check that the new access code permits login and the previous code is rejected. An already authenticated session should remain valid when only the access code changes. For a signing-secret change, check that the old cookie is rejected and a new login works. Keep secret values and cookies out of evidence logs.

If validation fails, keep the original `MAINTENANCE_DIR`, `resume.json`, `restart.json` and rotation record. Do not repeat the file-creation steps or capture new resume settings while alarms are disabled. Prepare a fresh plan from the saved pause input, review it and apply it:

```sh
terraform -chdir=infra/release plan -input=false -var-file="$MAINTENANCE_DIR/pause.json" -out="$MAINTENANCE_DIR/rollback-pause.plan"
```

Review the saved plan before applying it. Require only the expected count and alarm-setting changes:

```sh
terraform -chdir=infra/release apply -input=false "$MAINTENANCE_DIR/rollback-pause.plan"
```

Restoring an old signing secret can make old cookies valid again; never use that rollback if the old signing secret is compromised. A new signing secret and fresh logins are required in that case.

Repeat the pause-state checks, then restore the specific secret version recorded before this rotation:

```sh
node --experimental-strip-types scripts/deploy/rotate-secret.ts "$DEPLOYMENT_DIR/platform.json" "$ROTATION_SECRET" "$ROTATION_RECORD" rollback
```

The command verifies the current version belongs to this rotation before moving the label. Restart from the existing `restart.json` after reviewing a fresh plan:

```sh
terraform -chdir=infra/release plan -input=false -var-file="$MAINTENANCE_DIR/restart.json" -out="$MAINTENANCE_DIR/rollback-restart.plan"
```

Review the saved plan before applying it. Require only the expected count and alarm-setting changes:

```sh
terraform -chdir=infra/release apply -input=false "$MAINTENANCE_DIR/rollback-restart.plan"
```

Re-export the task definitions and run the exact-image/count verification from the resume procedure. After an access-code rollback, the previous code must work and the replacement code must fail. After a session-signing-secret rollback, verify a fresh login and session behavior against the restored version. For a gate rollback, run the installer with a new output path, `$MAINTENANCE_DIR/access-after-rollback.txt`, so the access file names the restored code. Restore the original alarm settings from `resume.json` only after readiness is healthy.

Database and provider rotation are separate procedures and remain unrehearsed. Do not pass their secret names to this helper. Database rotation must coordinate PostgreSQL role passwords, Secrets Manager and new task connections; changing only a URL's password breaks access. Provider rotation requires a separately issued credential and a successful bounded call before the provider owner retires the previous key. A shared provider key must not be revoked for a demo test.

## Prepare an isolated point-in-time restore

AWS point-in-time restoration creates a **new** instance. [RDS restore defaults](https://docs.aws.amazon.com/cli/latest/reference/rds/restore-db-instance-to-point-in-time.html) can select default networking and parameter groups and a single availability zone. The request below supplies the current deployment's settings explicitly. This one-off recovery instance is separate from the platform's Terraform state; no command below changes the live endpoint or adopts the restored instance as the application database.

After pausing writes, collect a diagnostic with a unique operation ID and retain its full-row digests, migration ledger and fixture metadata. Record the UTC time after inspection:

```sh
node --experimental-strip-types scripts/deploy/run-task.ts "$DEPLOYMENT_DIR/platform.json" "$DEPLOYMENT_DIR/tasks.json" diagnostic "$(basename "$MAINTENANCE_DIR")-before-restore" > "$MAINTENANCE_DIR/source-digest.log"
date -u +%Y-%m-%dT%H:%M:%SZ > "$MAINTENANCE_DIR/quiesced-at.txt"
aws rds describe-db-instances --region us-west-2 --db-instance-identifier one-door-personal --output json > "$MAINTENANCE_DIR/source-instance.json"
aws rds describe-db-instance-automated-backups --region us-west-2 --db-instance-identifier one-door-personal --query 'DBInstanceAutomatedBackups[].{identifier:DBInstanceIdentifier,status:Status,window:RestoreWindow}' --output json > "$MAINTENANCE_DIR/restore-window.json"
```

Require the diagnostic's confirmed success and complete JSON result. Keep writes and credential rotation paused. Repeat the two RDS read commands until the latest restorable time is **after** the timestamp recorded in `quiesced-at.txt`. A restore point before the diagnostic snapshot cannot be expected to reproduce its digests. The backup response's `RestoreWindow` supplies both earliest and latest times; `describe-db-instances` does not supply an earliest-restorable field.

Generate the restore request from the recorded source-instance details. The script checks the account, endpoint, encryption key, network settings and backup times before writing a local JSON file. It makes no AWS changes:

```sh
python3 scripts/deploy/build-restore-request.py "$DEPLOYMENT_DIR" "$MAINTENANCE_DIR"
```

Review the request. The next command checks the actual AWS account before creating a billable Multi-AZ database and a managed administrative secret. Preserve the response and instance identifier for the retained-resource inventory:

```sh
node --experimental-strip-types --input-type=module - <<'JS'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { aws, readPlatform, requireAccount } from './scripts/deploy/aws.ts';
const p = readPlatform(process.env.DEPLOYMENT_DIR + '/platform.json');
if (p.account_id !== '845191826742' || p.region !== 'us-west-2') throw new Error('Personal recovery only');
requireAccount(p);
const root = process.env.MAINTENANCE_DIR;
const request = JSON.parse(readFileSync(root + '/restore-request.json', 'utf8'));
if (request.SourceDBInstanceIdentifier !== p.database_identifier ||
    !request.TargetDBInstanceIdentifier.startsWith(p.name + '-restore-'))
  throw new Error('Restore request does not name this deployment and a separate target');
if (existsSync(root + '/restore-response.json')) throw new Error('Response already retained; inspect the existing restore');
const response = aws(['rds', 'restore-db-instance-to-point-in-time', '--region', p.region,
  '--cli-input-json', JSON.stringify(request)]);
writeFileSync(root + '/restore-response.json', JSON.stringify(response, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Restore submission response retained; availability and data verification are pending.');
JS
```

Do not create another target after an uncertain response. Read `TargetDBInstanceIdentifier` from the saved request and describe that target using the command below. Continue waiting while AWS reports creation progress. A timeout from the standard waiter does not establish that the restore failed. After availability, verify the actual subnet group, security groups, parameter group, encryption key, engine version, public-access setting, Multi-AZ setting, backups and deletion protection against the source/request. Verify database log retention for the new identifier separately.

```sh
export RESTORE_TARGET="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.env.MAINTENANCE_DIR + "/restore-request.json", "utf8")).TargetDBInstanceIdentifier')"
aws rds describe-db-instances --region us-west-2 --db-instance-identifier "$RESTORE_TARGET" --output json > "$MAINTENANCE_DIR/restored-instance.json"
```

After a successful submission response for the saved request, the source application may resume using the saved maintenance inputs. The restore point and comparison digests remain fixed; later source writes are intentionally absent from that restored copy. Keep database credential rotation paused until restored login testing is finished. After a lost submission response, describe the target and inspect the RDS `RestoreDBInstanceToPointInTime` event in CloudTrail. Require matching source, target and restore time, no `errorCode` or `errorMessage`, and successful `responseElements` naming the target before resuming or retrying; a matching instance name alone does not prove which restore point was used.

**Recovery is not yet proven at this checkpoint.** The restore helper runs the released image in a private task with no inbound access. It captures the restored diagnostic before any write, checks application health, login, retained review history and session readback, then compares every captured table digest, migration and fixture with the saved source diagnostic before reporting success. The helper changes the database host inside the task; it never changes live secret URLs or puts passwords into task overrides. Current Secrets Manager values must still match the passwords at the restore point.

Extract the single diagnostic result from the confirmed source operation. Preserve the original log:

```sh
node --experimental-strip-types --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDiagnostic } from './scripts/deploy/check-restore.ts';
const root = process.env.MAINTENANCE_DIR;
const lines = readFileSync(root + '/source-digest.log', 'utf8').split('\n').filter(line => line.startsWith('{'));
assert.equal(lines.length, 1, 'Require one complete diagnostic from the successful source task');
const diagnostic = parseDiagnostic(lines[0], 'source-digest.log');
writeFileSync(root + '/source-digest.json', JSON.stringify(diagnostic, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
JS
```

Run the rehearsal against the saved release image and its matching web task revision. Keep the current task export from the resume procedure:

```sh
node --experimental-strip-types --input-type=module - <<'JS' > "$MAINTENANCE_DIR/restore-rehearsal.log"
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = process.env.MAINTENANCE_DIR;
const deployment = process.env.DEPLOYMENT_DIR;
const settings = JSON.parse(readFileSync(root + '/resume.json', 'utf8'));
const tasks = JSON.parse(readFileSync(deployment + '/tasks.json', 'utf8'));
const revision = tasks.services.web.split(':').at(-1);
execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/deploy/check-restore.ts',
  deployment + '/platform.json', process.env.RESTORE_TARGET, revision, settings.released_image,
  root + '/source-digest.json'], { stdio: 'inherit' });
JS
```

Require a confirmed zero task exit, every reported HTTP status `200`, positive queue history, `serverStopped: 1`, an exact diagnostic match, and `Restore rehearsal confirmed against the released image.` An uncertain submission or task result needs investigation of the task named in the log; do not repeat the command blindly. The task and the visitor created in the restored database remain as evidence. Record elapsed recovery time and the time between the restore point and the latest committed writes to the source database.

The probe has run against a local runtime image and populated PostgreSQL database. Execution on restored RDS and Fargate networking remains pending. The isolated rehearsal does not prove a live cutover or public ingress to the restored application.
