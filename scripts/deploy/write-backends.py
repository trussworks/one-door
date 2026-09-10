import argparse
import json
import re
from pathlib import Path


TARGETS = {"personal": "845191826742", "truss": "004351505091"}


def write_backends(root: Path, environment: str) -> None:
    outputs = json.loads((root / "bootstrap.json").read_text())
    account = outputs["account_id"]["value"]
    region = outputs["region"]["value"]
    if (
        account != TARGETS[environment]
        or region != "us-west-2"
        or outputs["environment"]["value"] != environment
    ):
        raise ValueError("Bootstrap outputs do not match the selected deployment")
    bucket = outputs["state_bucket"]["value"]
    key_arn = outputs["state_key_arn"]["value"]
    if bucket != f"one-door-state-{account}-{region}" or not re.fullmatch(
        rf"arn:aws:kms:{region}:{account}:key/[A-Za-z0-9-]+", key_arn
    ):
        raise ValueError("State bucket or encryption key is outside the selected deployment")
    files = {}
    # install/ holds the administrator bootstrap task. The release role's S3 grant
    # names only release/terraform.tfstate, so CI can neither read nor write it.
    for stack in ["bootstrap", "platform", "release", "install"]:
        config = {
            "bucket": bucket,
            "key": stack + "/terraform.tfstate",
            "region": region,
            "kms_key_id": key_arn,
            "encrypt": True,
            "use_lockfile": True,
            "allowed_account_ids": [account],
        }
        files[root / (stack + ".backend.hcl")] = (
            "\n".join(key + " = " + json.dumps(value) for key, value in config.items())
            + "\n"
        )
    files[root / "bootstrap/backend.tf"] = 'terraform {\n  backend "s3" {}\n}\n'
    # Reusing a private directory must never retarget an existing state's backend.
    for filename, content in files.items():
        if filename.exists() and filename.read_text() != content:
            raise ValueError("Refusing to replace a different backend: " + str(filename))
    for filename, content in files.items():
        if not filename.exists():
            filename.write_text(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Write Terraform backends from bootstrap outputs.")
    parser.add_argument("deployment_dir", type=Path)
    parser.add_argument("--environment", required=True, choices=TARGETS)
    args = parser.parse_args()
    write_backends(args.deployment_dir, args.environment)
