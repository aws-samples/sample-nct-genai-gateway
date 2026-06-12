#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EksClusterStack } from '../lib/stacks/eks-cluster-stack';
import { KarpenterStack } from '../lib/stacks/karpenter-stack';
import { VllmStack } from '../lib/stacks/vllm-stack';
import { SmartRouterStack } from '../lib/stacks/smart-router-stack';
import { CertStack } from '../lib/stacks/cert-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { WarmupStack } from '../lib/stacks/warmup-stack';
import { ReservationStack, DAILY_WARMUP_RULE_NAME } from '../lib/stacks/reservation-stack';
import { AdminConsoleStack } from '../lib/stacks/admin-console-stack';
import { TestClientStack } from '../lib/stacks/test-client-stack';
import { HigressStack } from '../lib/stacks/higress-stack';
import { VLLM_MODELS } from '../config/models';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-northeast-2', // NCT 준수: 서울 고정 (환경 변수로 변경 불가)
};

// Read a context value that may arrive as a real JSON value (from cdk.json /
// cdk.context.json) or as a string (from the CLI `-c key=value`, which always
// passes strings). When it's a string, JSON.parse it so `-c operatorRoleArns='[...]'`
// and `-c vllmEndpoints='{...}'` work the same as the cdk.json defaults.
function getJsonContext<T>(key: string, fallback: T): T {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') return raw as T;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch (e) {
    throw new Error(
      `Context "${key}" must be valid JSON when passed via -c (got: ${raw}). ` +
      `Example: -c ${key}='${JSON.stringify(fallback)}'`,
    );
  }
}

const clusterName  = app.node.tryGetContext('clusterName') ?? 'nct-gateway';
const GATEWAY_ZONE = 'nct-gateway.internal';
const GATEWAY_DOMAIN = `*.${GATEWAY_ZONE}`;

// vllmEndpoints: per-alias NLB DNS map. Consumed by the Higress applier
// (apply-higress.sh) to register the vLLM providers and by SmartRouter's cold-vLLM
// pre-flight. First deploy: omit — providers are applied post-deploy once the NLBs exist.
// After VllmStack deploy, get each NLB DNS:
//   kubectl get svc -n vllm <servingName>-nlb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
// Then set via cdk.json context or the CLI:
//   "vllmEndpoints": { "coding": "http://internal-xxx.elb.amazonaws.com", "ocr": "..." }
//   -c vllmEndpoints='{"coding":"http://internal-xxx.elb.amazonaws.com"}'
// and redeploy NctSmartRouterStack (and re-run apply-higress.sh).
const vllmEndpoints = getJsonContext<Record<string, string>>('vllmEndpoints', {});

// operatorRoleArns: IAM role ARNs granted AmazonEKSClusterAdminPolicy for break-glass kubectl.
// Default [] in cdk.json; override via cdk.json/cdk.context.json or the CLI:
//   -c operatorRoleArns='["arn:aws:iam::123456789012:role/Admin"]'
const operatorRoleArns = getJsonContext<string[]>('operatorRoleArns', []);

// higressEndpoint: internal NLB DNS of the Higress gateway — the SmartRouter upstream.
// The NLB is provisioned by k8s post-deploy (no CDK token), so its DNS is fed in like
// vllmEndpoints rather than referenced cross-stack. First deploy: omit — SmartRouter
// synthesizes with an empty upstream and is redeployed once the gateway NLB exists:
//   kubectl get svc -n higress-system higress-gateway-nlb \
//     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
//   -c higressEndpoint=internal-xxx.elb.amazonaws.com   (host only, no scheme/port)
// then redeploy NctSmartRouterStack to point it at the gateway.
const higressEndpoint = (app.node.tryGetContext('higressEndpoint') ?? '').toString().trim();

const networkStack = new NetworkStack(app, 'NctNetworkStack', { env, clusterName });

const eksStack = new EksClusterStack(app, 'NctEksStack', {
  env,
  vpc: networkStack.vpc,
  clusterName,
  operatorRoleArns,
});
eksStack.addDependency(networkStack);

const karpenterStack = new KarpenterStack(app, 'NctKarpenterStack', {
  env,
  cluster: eksStack.cluster,
});
karpenterStack.addDependency(eksStack);

// Deployment order: coding → ocr → video → longcontext → math → audio (PE&D priority)
// Each scenario gets its own instance for fault isolation and independent scaling (min=0 for cost).
// Deploy selectively: cdk deploy NctVllm-Coding (others remain dormant)
const vllmStacksConfig = [
  { id: 'NctVllm-Coding',       model: VLLM_MODELS['coding'] },
  { id: 'NctVllm-Ocr',          model: VLLM_MODELS['ocr'] },
  { id: 'NctVllm-Video',        model: VLLM_MODELS['video'] },
  { id: 'NctVllm-Longcontext',  model: VLLM_MODELS['longcontext'] },
  { id: 'NctVllm-Math',         model: VLLM_MODELS['math'] },
  { id: 'NctVllm-Audio',        model: VLLM_MODELS['audio'] },
];

for (const { id, model } of vllmStacksConfig) {
  const vllmStack = new VllmStack(app, id, {
    env,
    cluster: eksStack.cluster,
    efsFs: eksStack.efs,
    model,
    vllmNamespaceManifest: eksStack.vllmNamespaceManifest,
    modelCacheBucketName: eksStack.modelCacheBucket.bucketName,
    hfTokenSpcDependency: eksStack.hfTokenSpcManifest,
  });
  vllmStack.addDependency(karpenterStack);
}

// Phase 8: self-signed wildcard cert for *.nct-gateway.internal
// CertStack runs first — imports cert into ACM, stores CA cert in Secrets Manager.
// Skip NctCertStack on first deploy (Phases 0-7); add back for Phase 8.
const certStack = new CertStack(app, 'NctCertStack', {
  env,
  domain: GATEWAY_DOMAIN,
  baseDomain: GATEWAY_ZONE,
});
certStack.addDependency(networkStack);

// Higress AI gateway — the LLM gateway. Installs Higress onto
// the shared EKS Auto Mode cluster; the Helm release + internal-NLB Service synthesize
// into NctEksStack (the cluster's owning stack) per addHelmChart scoping, while this stack
// owns the deploy-ordering edge and the Bedrock IAM user / consumer-key Secrets.
// Provider/route/key-auth config is applied post-deploy via scripts/apply-higress.sh.
const higressStack = new HigressStack(app, 'NctHigressStack', {
  env,
  cluster: eksStack.cluster,
  certificateArn: certStack.certificateArn,
});
higressStack.addDependency(eksStack);
higressStack.addDependency(certStack);

// SmartRouter: intercepts `general` alias → detects scenario → rewrites to coding/math/video/...
// Phase 8: HTTPS 443 via ACM cert.
// ANTHROPIC_BASE_URL=https://gateway.nct-gateway.internal (via DnsStack Route53 PHZ)
// Upstream is the Higress internal NLB — fed in via `-c higressEndpoint=<NLB DNS>` after the
// gateway NLB is provisioned (k8s post-deploy, no CDK token). On a fresh deploy the upstream
// is empty; redeploy this stack once the NLB DNS is known.
const smartRouterStack = new SmartRouterStack(app, 'NctSmartRouterStack', {
  env,
  vpc: networkStack.vpc,
  upstreamEndpoint: higressEndpoint,
  certificateArn: certStack.certificateArn,
  // Reuse the per-alias vLLM NLB map for the router's cold-vLLM pre-flight (skip the
  // gateway when the target alias is scaled to zero). Empty when vllmEndpoints is omitted
  // → pre-flight disabled, reactive fallback only (the public-repo default).
  vllmEndpoints,
});

// Phase 9: Step Functions warm-up/cool-down SFN machines
// EventBridge schedule moved to NctReservationStack (Phase 10).
const warmupStack = new WarmupStack(app, 'NctWarmupStack', {
  env,
  cluster: eksStack.cluster,
  vllmModels: Object.values(VLLM_MODELS),
});
warmupStack.addDependency(karpenterStack);

// Phase 10: Reservation-based warm-up timer + daily schedule integration
// DynamoDB + reserve-fn + expire-fn + EventBridge daily reservation (08:30 KST, 11h)
const reservationStack = new ReservationStack(app, 'NctReservationStack', {
  env,
  vllmModels: Object.values(VLLM_MODELS),
  warmupSfnArn:  warmupStack.warmupMachine.stateMachineArn,
  cooldownSfnArn: warmupStack.cooldownMachine.stateMachineArn,
  clusterName,
});
reservationStack.addDependency(warmupStack);

// Phase 10: Admin Console (FastAPI ECS, admin.nct-gateway.internal)
const adminConsoleStack = new AdminConsoleStack(app, 'NctAdminConsoleStack', {
  env,
  vpc: networkStack.vpc,
  cluster: eksStack.cluster,
  vllmModels: Object.values(VLLM_MODELS),
  reservationsTableName: 'NctWarmupReservations',
  cooldownSfnArn: warmupStack.cooldownMachine.stateMachineArn,
  clusterName,
  certificateArn: certStack.certificateArn,
  dailyWarmupRuleName: DAILY_WARMUP_RULE_NAME,
});
adminConsoleStack.addDependency(reservationStack);
adminConsoleStack.addDependency(certStack);

// Route53 Private Hosted Zone: gateway / admin .nct-gateway.internal
const dnsStack = new DnsStack(app, 'NctDnsStack', {
  env,
  vpc: networkStack.vpc,
  zoneName: GATEWAY_ZONE,
  smartRouterAlb: smartRouterStack.alb,
  adminAlb: adminConsoleStack.alb,
});
dnsStack.addDependency(smartRouterStack);
dnsStack.addDependency(adminConsoleStack);

// In-VPC test client (included by default; opt out with -c deployTestClient=false).
// Deploys ONE private EC2 reachable only via SSM Session Manager, pre-wired to the
// gateway with Claude Code installed. Runs as a burstable t3.small in STANDARD credit
// mode (throttle, not surcharge) so idle cost stays negligible.
//   warm-up cold  -> SmartRouter falls back to in-region Bedrock (low-spec answer)
//   nct-warmup    -> GPU spins up, the SAME `claude` command now hits vLLM (Qwen3.5)
const deployTestClient = getJsonContext<boolean>('deployTestClient', true);
if (deployTestClient) {
  const testClientStack = new TestClientStack(app, 'NctTestClientStack', {
    env,
    vpc: networkStack.vpc,
    gatewayZone: GATEWAY_ZONE,
    masterKeySecret: higressStack.masterKeySecret,
    warmupSfnArn:   warmupStack.warmupMachine.stateMachineArn,
    cooldownSfnArn: warmupStack.cooldownMachine.stateMachineArn,
    caCertSecretName: '/nct/gateway/ca-cert',
    clusterName,
  });
  testClientStack.addDependency(higressStack);
  testClientStack.addDependency(warmupStack);
  testClientStack.addDependency(certStack);
  testClientStack.addDependency(dnsStack);
}
