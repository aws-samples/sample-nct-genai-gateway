import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { VLLM_MODELS } from '../../config/models';

/**
 * Optional in-VPC test client.
 *
 * Deploys a single private EC2 instance (no public IP) reachable only via SSM
 * Session Manager. User-data installs Claude Code (the GenAI harness) and points
 * it at the gateway. Because SmartRouter falls back vLLM aliases to in-region
 * Bedrock when the GPU is cold (cold-vLLM pre-flight → Bedrock-direct), the SAME
 * `claude "..."` command returns a Bedrock answer before warm-up and a vLLM
 * (Qwen3.5) answer after `nct-warmup`. No client-side model switch.
 *
 * Gated behind `-c deployTestClient=true` in bin (default off).
 */
export interface TestClientStackProps extends cdk.StackProps {
  /** Shared VPC (NctNetworkStack) — instance lands in PRIVATE_WITH_EGRESS. */
  vpc: ec2.IVpc;
  /** Private hosted zone base, e.g. 'nct-gateway.internal'. Gateway = gateway.<zone>. */
  gatewayZone: string;
  /** Gateway consumer key-auth secret (/nct/higress/master-key) — ANTHROPIC_API_KEY = its `.key`. */
  masterKeySecret: secretsmanager.ISecret;
  /** Step Functions ARN — ad-hoc warm-up (nct-warmup helper). */
  warmupSfnArn: string;
  /** Step Functions ARN — scale-to-zero cooldown (nct helper). */
  cooldownSfnArn: string;
  /** Secrets Manager name holding the self-signed CA cert (cert-stack). */
  caCertSecretName: string;
  /** EKS cluster / warm-up namespace target — passed in the SFN start-execution input. */
  clusterName: string;
}

export class TestClientStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TestClientStackProps) {
    super(scope, id, props);

    // CA cert secret imported by name — fromSecretNameV2 grants on the
    // `<name>-??????` ARN form so least-privilege GetSecretValue still matches.
    const caCertSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'CaCertSecret', props.caCertSecretName,
    );

    // Instance role: SSM Session Manager + read the two gateway secrets +
    // start the warm-up / cooldown state machines. No inbound SSH — SSM only.
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // Session Manager agent + (via the SSM VPC endpoints) no public path needed.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    props.masterKeySecret.grantRead(role);
    caCertSecret.grantRead(role);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [props.warmupSfnArn, props.cooldownSfnArn],
    }));
    // nct-status reads recent warm-up runs to show readiness (RUNNING -> SUCCEEDED).
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['states:ListExecutions'],
      resources: [props.warmupSfnArn],
    }));

    // Outbound-only SG: 443 (SSM endpoints + Secrets Manager EP + npm/Claude Code
    // over NAT) and 80 (package mirrors). No ingress — SSM tunnels in over the
    // endpoint, not an inbound port.
    const sg = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc: props.vpc,
      description: 'NCT test client - outbound 443/80 only, SSM Session Manager (no SSH)',
      allowAllOutbound: false,
    });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS - SSM/Secrets endpoints, gateway, npm');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP - package mirrors');

    // alias -> K8s serving (Deployment) name. The warm-up state machine takes
    // `deployments: [<servingName>]` (NOT the scenario alias), so nct-warmup must
    // translate. Built from the single source of truth (config/models.ts).
    const aliasToServing: Record<string, string> = {};
    for (const m of Object.values(VLLM_MODELS)) {
      aliasToServing[m.alias] = m.servingName;
    }
    // Assign SERVING inside the case (no $(...) wrapper) — portable across bash
    // 3.x/5.x; the command-substitution-wrapped form misparses on older bash.
    const aliasMapShell = Object.entries(aliasToServing)
      .map(([alias, serving]) => `    ${alias}) SERVING="${serving}";;`)
      .join('\n');

    const gatewayUrl = `https://gateway.${props.gatewayZone}`;
    const region = cdk.Stack.of(this).region;

    // User-data: install Claude Code, trust the gateway CA, export the gateway
    // env, and drop helper CLIs (nct-warmup / nct-status / nct / nct-demo).
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nodejs jq awscli',
      // (a) Claude Code (the GenAI harness)
      'npm install -g @anthropic-ai/claude-code',
      // (b) Trust the self-signed gateway CA — OS store + NODE_EXTRA_CA_CERTS
      `aws secretsmanager get-secret-value --secret-id ${props.caCertSecretName} ` +
        `--query SecretString --output text --region ${region} ` +
        '> /etc/pki/ca-trust/source/anchors/nct-gateway-ca.crt',
      'update-ca-trust',
      // (c) Gateway env for every login shell. ANTHROPIC_MODEL pinned to one alias;
      //     SmartRouter's fallback decides Bedrock (cold) vs vLLM (warm) transparently.
      'MASTER_KEY=$(aws secretsmanager get-secret-value ' +
        `--secret-id ${props.masterKeySecret.secretName} ` +
        `--query SecretString --output text --region ${region} | jq -r .key)`,
      'cat > /etc/profile.d/nct-gateway.sh <<PROFILE',
      `export ANTHROPIC_BASE_URL="${gatewayUrl}"`,
      'export ANTHROPIC_API_KEY="$MASTER_KEY"',
      'export ANTHROPIC_MODEL="general"',
      'export NODE_EXTRA_CA_CERTS="/etc/pki/ca-trust/source/anchors/nct-gateway-ca.crt"',
      `export NCT_WARMUP_SFN="${props.warmupSfnArn}"`,
      `export NCT_COOLDOWN_SFN="${props.cooldownSfnArn}"`,
      `export NCT_CLUSTER="${props.clusterName}"`,
      `export AWS_DEFAULT_REGION="${region}"`,
      'PROFILE',
      'chmod 0644 /etc/profile.d/nct-gateway.sh',
      // (d) Helpers ---------------------------------------------------------------
      // nct-warmup <alias>: spin up the GPU deployment behind an alias.
      'cat > /usr/local/bin/nct-warmup <<\'WARMUP\'',
      '#!/bin/bash',
      'set -euo pipefail',
      'ALIAS="${1:-coding}"',
      'case "$ALIAS" in',
      aliasMapShell,
      '    *) SERVING="";;',
      'esac',
      'if [ -z "$SERVING" ]; then echo "unknown alias: $ALIAS (try: coding video ocr longcontext math audio)"; exit 1; fi',
      'echo "Warming up $ALIAS ($SERVING) — GPU boot takes several minutes. Watch with: nct-status"',
      'aws stepfunctions start-execution --state-machine-arn "$NCT_WARMUP_SFN" \\',
      '  --input "{\\"deployments\\":[\\"$SERVING\\"],\\"namespace\\":\\"vllm\\",\\"clusterName\\":\\"$NCT_CLUSTER\\"}" \\',
      '  --query executionArn --output text',
      'WARMUP',
      // nct <alias>: scale the deployment back to zero (stop GPU billing).
      'cat > /usr/local/bin/nct <<\'COOL\'',
      '#!/bin/bash',
      'set -euo pipefail',
      'ALIAS="${1:-coding}"',
      'case "$ALIAS" in',
      aliasMapShell,
      '    *) SERVING="";;',
      'esac',
      'if [ -z "$SERVING" ]; then echo "unknown alias: $ALIAS"; exit 1; fi',
      'echo "Cooling down $ALIAS ($SERVING) to zero replicas"',
      'aws stepfunctions start-execution --state-machine-arn "$NCT_COOLDOWN_SFN" \\',
      '  --input "{\\"deployments\\":[\\"$SERVING\\"],\\"namespace\\":\\"vllm\\",\\"clusterName\\":\\"$NCT_CLUSTER\\"}" \\',
      '  --query executionArn --output text',
      'COOL',
      // nct-status: latest warm-up execution states (RUNNING -> SUCCEEDED = vLLM ready).
      'cat > /usr/local/bin/nct-status <<\'STATUS\'',
      '#!/bin/bash',
      'set -euo pipefail',
      'echo "Recent warm-up executions (SUCCEEDED = GPU ready, RUNNING = still booting):"',
      'aws stepfunctions list-executions --state-machine-arn "$NCT_WARMUP_SFN" \\',
      '  --max-items 5 --query "executions[].{status:status,started:startDate,name:name}" --output table',
      'STATUS',
      // nct-demo: print the before/after walkthrough.
      'cat > /usr/local/bin/nct-demo <<\'DEMO\'',
      '#!/bin/bash',
      'cat <<TXT',
      'NCT GenAI Gateway — in-VPC test client',
      '======================================',
      'The gateway env is already set (ANTHROPIC_BASE_URL / _API_KEY / _MODEL=general).',
      '',
      '1) BEFORE warm-up (GPU cold): the vLLM alias has 0 replicas, so SmartRouter',
      '   falls back to in-region Bedrock (Claude 3.5 Sonnet, Seoul).',
      '     claude "Refactor this function for readability: ..."',
      '',
      '2) Warm up the GPU model:',
      '     nct-warmup coding        # then poll: nct-status   (a few minutes)',
      '',
      '3) AFTER warm-up: the SAME command now hits self-hosted Qwen3.5-27B on vLLM.',
      '     claude "Refactor this function for readability: ..."',
      '',
      '4) Stop GPU billing when done:',
      '     nct coding               # scale the deployment back to zero',
      'TXT',
      'DEMO',
      'chmod 0755 /usr/local/bin/nct-warmup /usr/local/bin/nct /usr/local/bin/nct-status /usr/local/bin/nct-demo',
    );

    const instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: sg,
      userData,
      requireImdsv2: true,
      // Burstable in STANDARD credit mode: bursts above the CPU baseline are throttled,
      // not billed as surcharge vCPU-hours (the default 'unlimited' would bill them).
      // The demo workload (npm install + a few `claude` runs) is short and bursty, so
      // standard keeps idle cost negligible (~$0.024/hr) with no surprise charges.
      creditSpecification: ec2.CpuCredits.STANDARD,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(20, {
          encrypted: true,
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'aws ssm start-session --target <this>  (region ap-northeast-2)',
    });
  }
}
