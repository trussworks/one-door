import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class RestoreRequestTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(__file__).resolve().parents[2]
        artifacts = self.repo / ".harness"
        artifacts.mkdir(exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="restore-request-", dir=artifacts))
        print("Retained restore-request evidence:", self.root)
        self.platform = {
            "account_id": "845191826742",
            "region": "us-west-2",
            "name": "one-door-personal",
            "database_identifier": "one-door-personal",
            "database_host": "example.us-west-2.rds.amazonaws.com",
            "database_key_arn": "arn:aws:kms:us-west-2:845191826742:key/example",
        }
        self.source = {
            "DBInstanceArn": "arn:aws:rds:us-west-2:845191826742:db:one-door-personal",
            "DBInstanceIdentifier": "one-door-personal",
            "Endpoint": {"Address": self.platform["database_host"], "Port": 5432},
            "DBInstanceStatus": "available",
            "Engine": "postgres",
            "StorageEncrypted": True,
            "KmsKeyId": self.platform["database_key_arn"],
            "MultiAZ": True,
            "PubliclyAccessible": False,
            "DBSubnetGroup": {"SubnetGroupStatus": "Complete", "DBSubnetGroupName": "database-subnets"},
            "VpcSecurityGroups": [{"Status": "active", "VpcSecurityGroupId": "sg-database"}],
            "DBParameterGroups": [{"ParameterApplyStatus": "in-sync", "DBParameterGroupName": "postgres-parameters"}],
            "DBInstanceClass": "db.t4g.small",
            "EnabledCloudwatchLogsExports": ["postgresql", "upgrade"],
            "StorageType": "gp3",
            "MaxAllocatedStorage": 100,
            "BackupRetentionPeriod": 7,
        }
        self.backup = {
            "identifier": "one-door-personal",
            "status": "active",
            "window": {"EarliestTime": "2026-09-06T00:00:00Z", "LatestTime": "2026-09-07T12:00:00Z"},
        }
        (self.root / "quiesced-at.txt").write_text("2026-09-07T11:59:00Z\n")

    def run_command(self, python_args=()):
        for name, value in [
            ("platform.json", self.platform),
            ("source-instance.json", {"DBInstances": [self.source]}),
            ("restore-window.json", [self.backup]),
        ]:
            (self.root / name).write_text(json.dumps(value))
        return subprocess.run(
            [sys.executable, *python_args, str(self.repo / "scripts/deploy/build-restore-request.py"), str(self.root), str(self.root)],
            capture_output=True,
            text=True,
        )

    def test_command_preserves_source_settings_and_refuses_to_replace_saved_evidence(self):
        result = self.run_command()
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = self.root / "restore-request.json"
        original = saved.read_bytes()
        request = json.loads(original)
        target = request.pop("TargetDBInstanceIdentifier")
        self.assertRegex(target, r"^one-door-personal-restore-\d{14}$")
        self.assertEqual(request, {
            "SourceDBInstanceIdentifier": "one-door-personal",
            "RestoreTime": self.backup["window"]["LatestTime"],
            "DBInstanceClass": "db.t4g.small",
            "Port": 5432,
            "DBSubnetGroupName": "database-subnets",
            "VpcSecurityGroupIds": ["sg-database"],
            "DBParameterGroupName": "postgres-parameters",
            "MultiAZ": True,
            "PubliclyAccessible": False,
            "AutoMinorVersionUpgrade": False,
            "CopyTagsToSnapshot": True,
            "DeletionProtection": True,
            "EnableCloudwatchLogsExports": ["postgresql", "upgrade"],
            "StorageType": "gp3",
            "MaxAllocatedStorage": 100,
            "BackupRetentionPeriod": 7,
            "ManageMasterUserPassword": True,
            "MasterUserSecretKmsKeyId": self.platform["database_key_arn"],
            "Tags": [
                {"Key": "Application", "Value": "one-door"},
                {"Key": "Environment", "Value": "personal"},
                {"Key": "Purpose", "Value": "restore-rehearsal"},
            ],
        })
        self.assertEqual(result.stdout, f"Prepared restore request for {target} at {request['RestoreTime']}\n")
        retry = self.run_command()
        self.assertNotEqual(retry.returncode, 0)
        self.assertIn("FileExistsError", retry.stderr)
        self.assertEqual(saved.read_bytes(), original)

    def test_refuses_unverified_source_properties_before_writing_a_request(self):
        for field, invalid in [
            ("DBInstanceArn", "arn:aws:rds:us-west-2:000000000000:db:other"),
            ("DBInstanceStatus", "rebooting"),
            ("Engine", "mysql"),
            ("StorageEncrypted", False),
            ("KmsKeyId", "other-key"),
            ("MultiAZ", False),
            ("PubliclyAccessible", True),
            ("VpcSecurityGroups", []),
            ("DBParameterGroups", [{"ParameterApplyStatus": "pending-reboot"}]),
        ]:
            with self.subTest(field=field):
                original = self.source[field]
                self.source[field] = invalid
                result = self.run_command()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "restore-request.json").exists())
                self.source[field] = original

    def test_requires_a_restore_point_after_quiescence_in_the_retained_window(self):
        for earliest, latest in [
            ("2026-09-07T12:00:00Z", "2026-09-07T12:01:00Z"),
            ("2026-09-06T00:00:00Z", "2026-09-07T11:59:00Z"),
        ]:
            with self.subTest(earliest=earliest, latest=latest):
                self.backup["window"] = {"EarliestTime": earliest, "LatestTime": latest}
                result = self.run_command()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "restore-request.json").exists())

    def test_optimized_python_cannot_skip_restore_validation(self):
        self.source["PubliclyAccessible"] = True
        result = self.run_command(("-O",))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run without -O", result.stderr)
        self.assertFalse((self.root / "restore-request.json").exists())


if __name__ == "__main__":
    unittest.main()
