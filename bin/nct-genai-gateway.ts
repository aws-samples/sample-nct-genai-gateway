#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { NetworkStack } from '../lib/stacks/network-stack';
import { EksClusterStack } from '../lib/stacks/eks-cluster-stack';
import { KarpenterStack } from '../lib/stacks/karpenter-stack';
import { VllmStack } from '../lib/stacks/vllm-stack';
import { LiteLLMEcsStack } from '../lib/stacks/litellm-ecs-stack';
import { SmartRouterStack } from '../lib/stacks/smart-router-stack';
import { CertStack } from '../lib/stacks/cert-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { WarmupStack } from '../lib/stacks/warmup-stack';
import { ReservationStack, DAILY_WARMUP_RULE_NAME } from '../lib/stacks/reservation-stack';
import { AdminConsoleStack } from '../lib/stacks/admin-console-stack';
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

// vllmEndpoints: per-alias NLB DNS map.
// First deploy: omit — VllmStack deploys with placeholder endpoints in LiteLLM.
// After VllmStack deploy, get NLB DNS:
//   kubectl get svc -n vllm <servingName>-nlb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
// Then set via cdk.json context or the CLI:
//   "vllmEndpoints": { "coding": "http://internal-xxx.elb.amazonaws.com", "ocr": "..." }
//   -c vllmEndpoints='{"coding":"http://internal-xxx.elb.amazonaws.com"}'
// and redeploy: cdk deploy NctLiteLLMStack
const vllmEndpoints = getJsonContext<Record<string, string>>('vllmEndpoints', {});

// operatorRoleArns: IAM role ARNs granted AmazonEKSClusterAdminPolicy for break-glass kubectl.
// Default [] in cdk.json; override via cdk.json/cdk.context.json or the CLI:
//   -c operatorRoleArns='["arn:aws:iam::123456789012:role/Admin"]'
const operatorRoleArns = getJsonContext<string[]>('operatorRoleArns', []);

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

const litellmStack = new LiteLLMEcsStack(app, 'NctLiteLLMStack', {
  env,
  vpc: networkStack.vpc,
  vllmModels: Object.values(VLLM_MODELS),
  vllmEndpoints,
  certificateArn: certStack.certificateArn,
});
litellmStack.addDependency(networkStack);
litellmStack.addDependency(certStack);

// SmartRouter: intercepts `general` alias → detects scenario → rewrites to coding/math/video/...
// Phase 8: HTTPS 443 via ACM cert.
// ANTHROPIC_BASE_URL=https://gateway.nct-gateway.internal (via DnsStack Route53 PHZ)
const smartRouterStack = new SmartRouterStack(app, 'NctSmartRouterStack', {
  env,
  vpc: networkStack.vpc,
  litellmEndpoint: litellmStack.albDnsName,
  certificateArn: certStack.certificateArn,
});
smartRouterStack.addDependency(litellmStack);

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

// Route53 Private Hosted Zone: gateway / litellm / admin .nct-gateway.internal
const dnsStack = new DnsStack(app, 'NctDnsStack', {
  env,
  vpc: networkStack.vpc,
  zoneName: GATEWAY_ZONE,
  smartRouterAlb: smartRouterStack.alb,
  litellmAlb: litellmStack.alb,
  adminAlb: adminConsoleStack.alb,
});
dnsStack.addDependency(smartRouterStack);
dnsStack.addDependency(litellmStack);
dnsStack.addDependency(adminConsoleStack);
