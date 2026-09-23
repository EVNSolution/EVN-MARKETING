"""Run with python3; focused declaration checks with no AWS calls."""
import json
from pathlib import Path

template = json.loads((Path(__file__).resolve().parents[1] / "deploy/aws/foundation.json").read_text())
parameters = template["Parameters"]
resources = template["Resources"]
instance = resources["MarketingInstance"]["Properties"]

assert parameters["VpcId"]["Type"] == "AWS::EC2::VPC::Id"
assert parameters["PublicSubnetId"]["Type"] == "AWS::EC2::Subnet::Id"
assert parameters["UbuntuAmiId"]["Type"] == "AWS::EC2::Image::Id"
assert "Default" not in parameters["UbuntuAmiId"]
assert "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id" in parameters["UbuntuAmiId"]["Description"]
size = parameters["InstanceType"]
assert size["Type"] == "String" and size["Default"] == "t3a.small"
assert len(size["AllowedValues"]) == 4
assert set(size["AllowedValues"]) == {"t3a.small", "t3.small", "t3a.medium", "t3.medium"}
assert size["Default"] in size["AllowedValues"]

for name in ("MarketingInstance", "MarketingSecurityGroup", "MarketingElasticIp", "MarketingSecretsKey"):
    assert resources[name]["DeletionPolicy"] == resources[name]["UpdateReplacePolicy"] == "Retain"
assert instance["ImageId"] == {"Ref": "UbuntuAmiId"}
assert instance["SubnetId"] == {"Ref": "PublicSubnetId"}
assert instance["SecurityGroupIds"] == [{"Fn::GetAtt": ["MarketingSecurityGroup", "GroupId"]}]
assert instance["InstanceType"] == {"Ref": "InstanceType"}
assert instance["CreditSpecification"]["CPUCredits"] == "standard"
assert instance["MetadataOptions"]["HttpTokens"] == "required"
assert instance["MetadataOptions"]["HttpPutResponseHopLimit"] == 1
root = instance["BlockDeviceMappings"][0]
assert root["DeviceName"] == "/dev/sda1"
assert root["Ebs"] == {"DeleteOnTermination": False, "Encrypted": True, "VolumeSize": 40, "VolumeType": "gp3"}
assert instance["PropagateTagsToVolumeOnCreation"] is True

group = resources["MarketingSecurityGroup"]["Properties"]
assert group["VpcId"] == {"Ref": "VpcId"}
ingress = group["SecurityGroupIngress"]
assert len(ingress) == 2
assert {(rule["IpProtocol"], rule["FromPort"], rule["ToPort"], rule["CidrIp"]) for rule in ingress} == {
    ("tcp", 80, 80, "0.0.0.0/0"), ("tcp", 443, 443, "0.0.0.0/0")}
assert group["SecurityGroupEgress"] == [{"IpProtocol": "-1", "CidrIp": "0.0.0.0/0"}]

key = resources["MarketingSecretsKey"]["Properties"]
assert key["EnableKeyRotation"] is True
root_policy = key["KeyPolicy"]["Statement"][0]
assert root_policy["Principal"]["AWS"] == {"Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:root"}
assert root_policy["Action"] == "kms:*" and root_policy["Resource"] == "*"
assert resources["MarketingSecretsAlias"]["Properties"]["AliasName"] == "alias/evn-marketing/production"
assert resources["MarketingSecretsAlias"]["Properties"]["TargetKeyId"] == {"Ref": "MarketingSecretsKey"}

association = resources["MarketingElasticIpAssociation"]["Properties"]
assert association["InstanceId"] == {"Ref": "MarketingInstance"}
assert association["AllocationId"] == {"Fn::GetAtt": ["MarketingElasticIp", "AllocationId"]}
assert template["Outputs"]["MarketingInstanceId"]["Value"] == {"Ref": "MarketingInstance"}
assert template["Outputs"]["MarketingSecretsKmsKeyArn"]["Value"] == {"Fn::GetAtt": ["MarketingSecretsKey", "Arn"]}

assert "warp" not in json.dumps(template).lower()
assert not any(resource["Type"].startswith(("AWS::IAM::", "AWS::SSM::Parameter", "AWS::SecretsManager::")) for resource in resources.values())
assert not ({"UserData", "IamInstanceProfile", "KeyName"} & instance.keys())

print("server foundation declaration checks passed (synthetic only; no AWS operations)")
