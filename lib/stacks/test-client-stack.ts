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
  /** Step Functions ARN — warm-up (read-only here: nct-status polls its executions). */
  warmupSfnArn: string;
  /** Step Functions ARN — scale-to-zero cooldown (nct-cooldown helper). */
  cooldownSfnArn: string;
  /** reserve-fn Lambda ARN — nct-warmup invokes it for a TIMED reservation that
   *  auto-cools-down at expiry (EventBridge Scheduler), instead of a never-expiring
   *  raw warm-up SFN start. */
  reserveFnArn: string;
  /** DynamoDB reservations table name — nct-status reads remaining time, nct-cooldown
   *  clears an alias's rows so a subsequent nct-warmup re-triggers the 0→1 boot. */
  reservationsTableName: string;
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
    // nct-warmup → reserve-fn (timed reservation + server-side auto-cooldown at expiry).
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.reserveFnArn],
    }));
    // nct-cooldown → scale the deployment to zero directly via the cooldown SFN.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [props.cooldownSfnArn],
    }));
    // nct-status reads recent warm-up runs to show boot progress (RUNNING -> SUCCEEDED).
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['states:ListExecutions'],
      resources: [props.warmupSfnArn],
    }));
    // nct-status reads remaining reservation time; nct-cooldown clears an alias's rows so
    // a later nct-warmup re-triggers reserve-fn's 0→1 boot (a stale row would no-op it).
    const reservationsTableArn =
      `arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${props.reservationsTableName}`;
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
      resources: [reservationsTableArn],
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
    // Space-joined alias list for nct-status's per-alias loop (single source: config).
    const aliasList = Object.values(VLLM_MODELS).map((m) => m.alias).join(' ');

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
      `export NCT_RESERVE_FN="${props.reserveFnArn}"`,
      `export NCT_RESERVATIONS_TABLE="${props.reservationsTableName}"`,
      `export NCT_CLUSTER="${props.clusterName}"`,
      `export AWS_DEFAULT_REGION="${region}"`,
      // Suppress Claude Code's non-essential egress (telemetry/auto-update/error/bug
      // reporting). In this locked-down private VPC those endpoints (e.g.
      // statsig.anthropic.com) time out and make the CLI hang on startup, so we
      // disable them up front rather than wait on the timeouts.
      'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      'export DISABLE_TELEMETRY=1',
      'export DISABLE_ERROR_REPORTING=1',
      'export DISABLE_AUTOUPDATER=1',
      'export DISABLE_BUG_COMMAND=1',
      'export CLAUDE_CODE_ENABLE_TELEMETRY=0',
      'PROFILE',
      'chmod 0644 /etc/profile.d/nct-gateway.sh',
      // (d) Helpers ---------------------------------------------------------------
      // All JSON payloads are written to /tmp via printf and passed as file:// — this
      // avoids the brittle nested-quote escaping of inline --input "{\"...\"}" and keeps
      // the AWS CLI's base64 interpretation out of the way (raw-in-base64-out for lambda).
      //
      // nct-warmup <alias> [duration]: place a TIMED warm-up reservation via reserve-fn.
      // reserve-fn writes a DynamoDB reservation (TTL), registers an EventBridge Scheduler
      // one-shot that auto-cools-down at expiry, and starts the warm-up SFN on a 0→1
      // transition. duration accepts 2h / 90m / 3600 (bare = seconds); default 1h. This is
      // a real cost-safety win over a raw warm-up SFN start, which never expires on its own.
      'cat > /usr/local/bin/nct-warmup <<\'WARMUP\'',
      '#!/bin/bash',
      'set -euo pipefail',
      'ALIAS="${1:-coding}"',
      'DUR_RAW="${2:-1h}"',
      'case "$ALIAS" in',
      aliasMapShell,
      '    *) SERVING="";;',
      'esac',
      'if [ -z "$SERVING" ]; then echo "unknown alias: $ALIAS (try: coding video ocr longcontext math audio)"; exit 1; fi',
      '# duration: 2h / 90m / 3600(=seconds). Integer only (no fractional units).',
      'case "$DUR_RAW" in',
      '    *h) DUR=$(( ${DUR_RAW%h} * 3600 ));;',
      '    *m) DUR=$(( ${DUR_RAW%m} * 60 ));;',
      '    *s) DUR=${DUR_RAW%s};;',
      '    *)  DUR=$DUR_RAW;;',
      'esac',
      'if ! [ "$DUR" -gt 0 ] 2>/dev/null; then echo "bad duration: $DUR_RAW (use 2h / 90m / 3600)"; exit 1; fi',
      'echo "Reserving $ALIAS for ${DUR}s — GPU boot takes several minutes; auto-cools-down at expiry. Watch: nct-status"',
      'printf \'{"alias":"%s","durationSecs":%s,"requester":"nct-warmup"}\' "$ALIAS" "$DUR" > /tmp/nct-reserve-in.json',
      'aws lambda invoke --function-name "$NCT_RESERVE_FN" \\',
      '  --cli-binary-format raw-in-base64-out \\',
      '  --payload file:///tmp/nct-reserve-in.json /tmp/nct-reserve-out.json >/dev/null',
      'jq -r \'"reservationId=\\(.reservationId)  scaledUp=\\(.scaledUp)  expiresIn=\\(.durationSecs)s"\' /tmp/nct-reserve-out.json 2>/dev/null || cat /tmp/nct-reserve-out.json',
      'WARMUP',
      // nct-cooldown <alias>: clear the alias's reservations THEN scale to zero. Clearing
      // the DDB rows is essential — reserve-fn only boots on a 0→1 reservation transition,
      // so a leftover row would make the next nct-warmup silently no-op. The orphaned
      // EventBridge one-shot self-deletes when it fires (harmless scale-0 on already-0).
      'cat > /usr/local/bin/nct-cooldown <<\'COOL\'',
      '#!/bin/bash',
      'set -euo pipefail',
      'ALIAS="${1:-coding}"',
      'case "$ALIAS" in',
      aliasMapShell,
      '    *) SERVING="";;',
      'esac',
      'if [ -z "$SERVING" ]; then echo "unknown alias: $ALIAS"; exit 1; fi',
      '# 1) Clear active reservations so a future nct-warmup re-triggers the 0→1 boot.',
      'printf \'{":a":{"S":"%s"}}\' "$ALIAS" > /tmp/nct-q.json',
      'RIDS=$(aws dynamodb query --table-name "$NCT_RESERVATIONS_TABLE" \\',
      '  --key-condition-expression "alias = :a" \\',
      '  --expression-attribute-values file:///tmp/nct-q.json \\',
      '  --query "Items[].reservationId.S" --output text 2>/dev/null || true)',
      'for RID in $RIDS; do',
      '  printf \'{"alias":{"S":"%s"},"reservationId":{"S":"%s"}}\' "$ALIAS" "$RID" > /tmp/nct-k.json',
      '  aws dynamodb delete-item --table-name "$NCT_RESERVATIONS_TABLE" --key file:///tmp/nct-k.json >/dev/null || true',
      'done',
      '[ -n "$RIDS" ] && echo "cleared reservation(s): $RIDS" || true',
      '# 2) Scale the deployment to zero (stop GPU billing).',
      'echo "Cooling down $ALIAS ($SERVING) to zero replicas"',
      'printf \'{"deployments":["%s"],"namespace":"vllm","clusterName":"%s"}\' "$SERVING" "$NCT_CLUSTER" > /tmp/nct-cool-in.json',
      'aws stepfunctions start-execution --state-machine-arn "$NCT_COOLDOWN_SFN" \\',
      '  --input file:///tmp/nct-cool-in.json --query executionArn --output text',
      'COOL',
      // nct <alias>: back-compat shim — the cooldown command was renamed to nct-cooldown.
      'cat > /usr/local/bin/nct <<\'NCTSHIM\'',
      '#!/bin/bash',
      '# Deprecated name kept for back-compat; forwards to the renamed nct-cooldown.',
      'exec /usr/local/bin/nct-cooldown "$@"',
      'NCTSHIM',
      // nct-which [max_tokens]: which backend answers the coding alias right now? Prints the
      // model field + request id + the x-nct-fallback header. cold = bedrock-direct + a
      // Claude model; warm = qwen35-27b + no fallback header. (Short input only — large-input
      // clamp behaviour is exercised by the harness, not this quick probe.)
      'cat > /usr/local/bin/nct-which <<\'WHICH\'',
      '#!/bin/bash',
      'set -uo pipefail',
      'MT="${1:-32000}"',
      'printf \'{"model":"coding","max_tokens":%s,"messages":[{"role":"user","content":"Reply with exactly: PING"}]}\' "$MT" > /tmp/nct-which.json',
      'BODY=$(curl -sS -k -m 60 -D /tmp/nct-which-h.txt -X POST "$ANTHROPIC_BASE_URL/v1/messages" \\',
      '  -H \'content-type: application/json\' -H \'anthropic-version: 2023-06-01\' \\',
      '  -H "x-api-key: $ANTHROPIC_API_KEY" --data @/tmp/nct-which.json)',
      'echo "$BODY" | jq -r \'"model=\\(.model)  id=\\(.id)"\' 2>/dev/null || echo "$BODY"',
      'HDR=$(grep -i \'^x-nct-fallback:\' /tmp/nct-which-h.txt | tail -1 | tr -d \'\\r\' || true)',
      'echo "${HDR:-x-nct-fallback: (none = vLLM-direct)}"',
      'WHICH',
      // nct-status: per-alias warm/cold from active reservations (time left) + recent
      // warm-up executions for boot progress. No emoji — plain text markers.
      'cat > /usr/local/bin/nct-status <<\'STATUS\'',
      '#!/bin/bash',
      'set -uo pipefail',
      'NOW=$(date +%s)',
      'echo "Model status (WARM = active reservation; cold = scaled to zero):"',
      `for A in ${aliasList}; do`,
      '  printf \'{":a":{"S":"%s"}}\' "$A" > /tmp/nct-q.json',
      '  EXP=$(aws dynamodb query --table-name "$NCT_RESERVATIONS_TABLE" \\',
      '    --key-condition-expression "alias = :a" \\',
      '    --expression-attribute-values file:///tmp/nct-q.json \\',
      '    --query "Items[].expireAt.N" --output text 2>/dev/null | tr \'\\t\' \'\\n\' | sort -n | tail -1 || true)',
      '  if [ -n "$EXP" ] && [ "$EXP" -gt "$NOW" ] 2>/dev/null; then',
      '    LEFT=$(( (EXP - NOW + 59) / 60 ))',
      '    printf \'  %-12s WARM   (reserved, ~%sm left)\\n\' "$A" "$LEFT"',
      '  else',
      '    printf \'  %-12s cold\\n\' "$A"',
      '  fi',
      'done',
      'echo',
      'echo "Recent warm-up executions (RUNNING = still booting, SUCCEEDED = ready):"',
      'aws stepfunctions list-executions --state-machine-arn "$NCT_WARMUP_SFN" \\',
      '  --max-items 5 --query "executions[].{status:status,started:startDate,name:name}" --output table 2>/dev/null || true',
      'STATUS',
      // nct-demo: print the before/after walkthrough.
      'cat > /usr/local/bin/nct-demo <<\'DEMO\'',
      '#!/bin/bash',
      'cat <<TXT',
      'NCT GenAI Gateway — in-VPC test client',
      '======================================',
      'The gateway env is already set (ANTHROPIC_BASE_URL / _API_KEY / _MODEL=general).',
      'Which backend answers right now?   nct-which        (model + x-nct-fallback header)',
      '',
      '1) BEFORE warm-up (GPU cold): the vLLM alias has 0 replicas, so SmartRouter',
      '   falls back to in-region Bedrock (Claude 3.5 Sonnet, Seoul).',
      '     claude "Refactor this function for readability: ..."',
      '',
      '2) Warm up the GPU model (timed; auto-cools-down at expiry):',
      '     nct-warmup coding 2h     # then poll: nct-status   (a few minutes to boot)',
      '',
      '3) AFTER warm-up: the SAME command now hits self-hosted Qwen3.5-27B on vLLM.',
      '     claude "Refactor this function for readability: ..."',
      '',
      '4) Stop GPU billing early (before the reservation expires):',
      '     nct-cooldown coding      # clear reservation + scale the deployment to zero',
      'TXT',
      'DEMO',
      'chmod 0755 /usr/local/bin/nct-warmup /usr/local/bin/nct-cooldown /usr/local/bin/nct ' +
        '/usr/local/bin/nct-which /usr/local/bin/nct-status /usr/local/bin/nct-demo',
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

    // Short, stable Name tag so the instance can be located by tag instead of a
    // hard-coded id: `--filters Name=tag:Name,Values=nct-test-client`. (CDK also adds
    // the long path-style tag NctTestClientStack/Instance; this is the friendly one.)
    cdk.Tags.of(instance).add('Name', 'nct-test-client');

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'aws ssm start-session --target <this>  (region ap-northeast-2)',
    });
  }
}
