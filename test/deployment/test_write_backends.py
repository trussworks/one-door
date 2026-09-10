import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class WriteBackendsTest(unittest.TestCase):
    def setUp(self):
        self.repo = Path(__file__).resolve().parents[2]
        artifacts = self.repo / ".harness"
        artifacts.mkdir(exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="backend-config-", dir=artifacts))
        (self.root / "bootstrap").mkdir()
        print("Retained backend configuration:", self.root)

    def outputs(self, environment):
        account = {"personal": "845191826742", "truss": "004351505091"}[environment]
        return {
            "account_id": {"value": account},
            "region": {"value": "us-west-2"},
            "environment": {"value": environment},
            "state_bucket": {"value": f"one-door-state-{account}-us-west-2"},
            "state_key_arn": {"value": f"arn:aws:kms:us-west-2:{account}:key/example"},
        }

    def command(self, environment, outputs):
        (self.root / "bootstrap.json").write_text(json.dumps(outputs))
        return subprocess.run(
            [sys.executable, str(self.repo / "scripts/deploy/write-backends.py"),
             str(self.root), "--environment", environment],
            capture_output=True, text=True,
        )

    def assert_backends(self, environment):
        outputs = self.outputs(environment)
        result = self.command(environment, outputs)
        self.assertEqual(result.returncode, 0, result.stderr)
        for stack in ["bootstrap", "platform", "release", "install"]:
            config = {
                key: json.loads(value)
                for line in (self.root / (stack + ".backend.hcl")).read_text().splitlines()
                for key, value in [line.split(" = ", 1)]
            }
            self.assertEqual(config, {
                "bucket": outputs["state_bucket"]["value"],
                "key": stack + "/terraform.tfstate",
                "region": "us-west-2",
                "kms_key_id": outputs["state_key_arn"]["value"],
                "encrypt": True,
                "use_lockfile": True,
                "allowed_account_ids": [outputs["account_id"]["value"]],
            })
        self.assertEqual(
            (self.root / "bootstrap/backend.tf").read_text(),
            'terraform {\n  backend "s3" {}\n}\n',
        )
        self.assertEqual(self.command(environment, outputs).returncode, 0)

    def test_personal_backends_preserve_account_restrictions(self):
        self.assert_backends("personal")

    def test_truss_backends_isolate_all_four_state_keys(self):
        self.assert_backends("truss")

    def test_rejects_mismatched_identity_bucket_or_key_before_writing(self):
        for field, value in [
            ("account_id", "845191826742"),
            ("region", "us-east-1"),
            ("environment", "personal"),
            ("state_bucket", "one-door-state-845191826742-us-west-2"),
            ("state_key_arn", "arn:aws:kms:us-west-2:845191826742:key/example"),
        ]:
            with self.subTest(field=field):
                outputs = self.outputs("truss")
                outputs[field]["value"] = value
                result = self.command("truss", outputs)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(list(self.root.glob("*.backend.hcl")), [])
                self.assertFalse((self.root / "bootstrap/backend.tf").exists())

    def test_refuses_retargeting_an_existing_installation_directory(self):
        self.assert_backends("personal")
        files = [*self.root.glob("*.backend.hcl"), self.root / "bootstrap/backend.tf"]
        before = {file: file.read_bytes() for file in files}
        result = self.command("truss", self.outputs("truss"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing to replace", result.stderr)
        self.assertEqual({file: file.read_bytes() for file in files}, before)

    def test_requires_bootstrap_identity_outputs(self):
        outputs = self.outputs("truss")
        del outputs["account_id"]
        self.assertNotEqual(self.command("truss", outputs).returncode, 0)
        self.assertEqual(list(self.root.glob("*.backend.hcl")), [])


if __name__ == "__main__":
    unittest.main()
