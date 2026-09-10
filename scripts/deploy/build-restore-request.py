import argparse
import json
from datetime import datetime
from pathlib import Path


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))


def build_restore_request(deployment_dir: Path, maintenance_dir: Path) -> dict:
    if not __debug__:
        raise RuntimeError("Restore request validation requires Python assertions; run without -O.")
    platform = json.loads((deployment_dir / "platform.json").read_text())
    source, = json.loads((maintenance_dir / "source-instance.json").read_text())["DBInstances"]
    backup, = json.loads((maintenance_dir / "restore-window.json").read_text())
    assert platform["account_id"] == "845191826742" and platform["region"] == "us-west-2"
    assert source["DBInstanceArn"] == (
        "arn:aws:rds:us-west-2:845191826742:db:" + platform["database_identifier"]
    )
    assert source["Endpoint"]["Address"] == platform["database_host"]
    assert source["DBInstanceStatus"] == "available" and source["Engine"] == "postgres"
    assert source["StorageEncrypted"] and source["KmsKeyId"] == platform["database_key_arn"]
    assert source["MultiAZ"] and not source["PubliclyAccessible"]
    assert source["DBSubnetGroup"]["SubnetGroupStatus"] == "Complete"
    assert source["VpcSecurityGroups"] and all(
        group["Status"] == "active" for group in source["VpcSecurityGroups"]
    )
    parameter, = source["DBParameterGroups"]
    assert parameter["ParameterApplyStatus"] == "in-sync"
    assert backup["identifier"] == source["DBInstanceIdentifier"] and backup["status"] == "active"
    point = backup["window"]["LatestTime"]
    assert (
        parse_time(backup["window"]["EarliestTime"])
        <= parse_time((maintenance_dir / "quiesced-at.txt").read_text())
        < parse_time(point)
    )
    target = platform["name"] + "-restore-" + datetime.now().strftime("%Y%m%d%H%M%S")
    return {
        "SourceDBInstanceIdentifier": source["DBInstanceIdentifier"],
        "TargetDBInstanceIdentifier": target,
        "RestoreTime": point,
        "DBInstanceClass": source["DBInstanceClass"],
        "Port": source["Endpoint"]["Port"],
        "DBSubnetGroupName": source["DBSubnetGroup"]["DBSubnetGroupName"],
        "VpcSecurityGroupIds": [group["VpcSecurityGroupId"] for group in source["VpcSecurityGroups"]],
        "DBParameterGroupName": parameter["DBParameterGroupName"],
        "MultiAZ": True,
        "PubliclyAccessible": False,
        "AutoMinorVersionUpgrade": False,
        "CopyTagsToSnapshot": True,
        "DeletionProtection": True,
        "EnableCloudwatchLogsExports": source["EnabledCloudwatchLogsExports"],
        "StorageType": source["StorageType"],
        "MaxAllocatedStorage": source["MaxAllocatedStorage"],
        "BackupRetentionPeriod": source["BackupRetentionPeriod"],
        "ManageMasterUserPassword": True,
        "MasterUserSecretKmsKeyId": source["KmsKeyId"],
        "Tags": [
            {"Key": "Application", "Value": "one-door"},
            {"Key": "Environment", "Value": "personal"},
            {"Key": "Purpose", "Value": "restore-rehearsal"},
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a restore request from recorded RDS evidence.")
    parser.add_argument("deployment_dir", type=Path)
    parser.add_argument("maintenance_dir", type=Path)
    args = parser.parse_args()
    request = build_restore_request(args.deployment_dir, args.maintenance_dir)
    with (args.maintenance_dir / "restore-request.json").open("x") as output:
        json.dump(request, output, indent=2)
        output.write("\n")
    print("Prepared restore request for", request["TargetDBInstanceIdentifier"], "at", request["RestoreTime"])


if __name__ == "__main__":
    main()
