import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { Resources } = JSON.parse(
  readFileSync(new URL("./community-media.cfn.json", import.meta.url), "utf8"),
);

test("both media buckets remain private and only approved prefixes expire", () => {
  for (const bucket of [Resources.Media, Resources.AccessLogs]) {
    assert.equal(bucket.DeletionPolicy, "Retain");
    assert.equal(bucket.UpdateReplacePolicy, "Retain");
    const properties = bucket.Properties;
    assert.deepEqual(properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.equal(
      properties.OwnershipControls.Rules[0].ObjectOwnership,
      "BucketOwnerEnforced",
    );
    assert.equal(
      properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
        .ServerSideEncryptionByDefault.SSEAlgorithm,
      "AES256",
    );
    for (const key of [
      "ObjectLockEnabled",
      "VersioningConfiguration",
      "ReplicationConfiguration",
    ]) {
      assert.equal(properties[key], undefined);
    }
  }

  for (const [resource, prefix, days] of [
    [Resources.Media, "quarantine/", 1],
    [Resources.AccessLogs, "access/", 30],
  ]) {
    const [rule] = resource.Properties.LifecycleConfiguration.Rules;
    assert.equal(resource.Properties.LifecycleConfiguration.Rules.length, 1);
    assert.equal(rule.Prefix, prefix);
    assert.equal(rule.ExpirationInDays, days);
  }
  assert.equal(
    Resources.Media.Properties.LifecycleConfiguration.Rules[0]
      .AbortIncompleteMultipartUpload.DaysAfterInitiation,
    1,
  );
  assert.deepEqual(
    Resources.Media.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins,
    [{ Ref: "BrowserOrigin" }],
  );
});

test("request log reads are denied outside the selected Ops role", () => {
  const statements =
    Resources.AccessLogsPolicy.Properties.PolicyDocument.Statement;
  const opsRole = {
    "Fn::Sub":
      "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${OpsReaderRolePath}",
  };
  const allow = statements.find((s) => s.Sid === "AllowOpsLogReads");
  assert.equal(allow.Effect, "Allow");
  assert.deepEqual(allow.Condition.ArnEquals["aws:PrincipalArn"], opsRole);
  const deny = statements.find((s) => s.Sid === "DenyNonOpsLogReads");
  assert.equal(deny.Effect, "Deny");
  assert.equal(deny.Principal, "*");
  assert.deepEqual(deny.Action, [
    "s3:GetObject*",
    "s3:ListBucket*",
    "s3:GetBucketLocation",
  ]);
  assert.deepEqual(deny.Condition.ArnNotEquals["aws:PrincipalArn"], opsRole);
});

test("API and worker grants are distinct and limited to the same environment's media objects", () => {
  const matrix = [
    [
      Resources.ApiMediaRole,
      "ApiCallerRolePath",
      [
        ["quarantine", ["s3:GetObject", "s3:PutObject"]],
        ["processed", ["s3:GetObject"]],
      ],
    ],
    [
      Resources.WorkerMediaRole,
      "WorkerCallerRolePath",
      [
        ["quarantine", ["s3:GetObject", "s3:DeleteObject"]],
        ["processed", ["s3:PutObject", "s3:DeleteObject"]],
      ],
    ],
  ];
  for (const [role, caller, permissions] of matrix) {
    const properties = role.Properties;
    const [trust] = properties.AssumeRolePolicyDocument.Statement;
    assert.equal(properties.AssumeRolePolicyDocument.Statement.length, 1);
    assert.equal(trust.Action, "sts:AssumeRole");
    assert.deepEqual(trust.Principal, {
      AWS: { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:root" },
    });
    assert.deepEqual(trust.Condition.ArnEquals["aws:PrincipalArn"], {
      "Fn::Sub":
        "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${" + caller + "}",
    });
    assert.equal(properties.ManagedPolicyArns, undefined);
    assert.equal(properties.Policies.length, 1);
    assert.deepEqual(
      properties.Policies[0].PolicyDocument.Statement,
      permissions.map(([prefix, Action]) => ({
        Effect: "Allow",
        Action,
        Resource: { "Fn::Sub": "${Media.Arn}/" + prefix + "/*" },
      })),
    );
  }
});
