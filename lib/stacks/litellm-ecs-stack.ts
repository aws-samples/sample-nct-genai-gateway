import * as cdk from 'aws-cdk-lib/core';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { VllmModelConfig, BedrockModelConfig, BEDROCK_MODELS } from '../../config/models';

export interface LiteLLMEcsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  /** v2: per-model config list (replaces flat vllmModels + single vllmEndpoint) */
  vllmModels: VllmModelConfig[];
  /**
   * Per-alias NLB endpoint map.
   * Key: model.alias (e.g. 'coding'), Value: Internal NLB DNS
   *   http://internal-<hash>.ap-northeast-2.elb.amazonaws.com
   *
   * First deploy: omit or set 'placeholder' values; deploy VllmStack first,
   * then kubectl get svc to get NLB DNS, update cdk.json context 'vllmEndpoints',
   * and redeploy NctLiteLLMStack.
   */
  vllmEndpoints: Record<string, string>;
  bedrockModels?: BedrockModelConfig[];
  litellmVersion?: string;
  /** Phase 8: ACM certificate ARN for HTTPS 443 listener. HTTP-only when omitted. */
  certificateArn?: string;
}

export class LiteLLMEcsStack extends cdk.Stack {
  /** Internal ALB DNS for use by SmartRouterStack */
  public readonly albDnsName: string;
  /** ALB object — required by DnsStack for Route53 alias records */
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: LiteLLMEcsStackProps) {
    super(scope, id, props);

    const bedrockModels = props.bedrockModels ?? BEDROCK_MODELS;

    // PROXY_MASTER_KEY — auto-generated, never leaves Secrets Manager
    const masterKeySecret = new secretsmanager.Secret(this, 'LiteLLMMasterKey', {
      secretName: '/nct/litellm/master-key',
      description: 'LiteLLM proxy master key for NCT GenAI Gateway',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'key',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // Task Role: Bedrock invoke + Secrets Manager read
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Scope Bedrock invoke to in-region (Seoul) foundation models only — NCT
    // requires inference to stay in ap-northeast-2, and least-privilege keeps
    // this off cross-region inference profiles.
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/*`],
    }));
    masterKeySecret.grantRead(taskRole);

    // Execution Role: ECR pull + CloudWatch logs
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    masterKeySecret.grantRead(executionRole);

    const configYaml = buildProxyConfig(props.vllmModels, bedrockModels, props.vllmEndpoints);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'nct-litellm',
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
      executionRole,
    });

    const litellmVersion = props.litellmVersion ?? 'main-latest';
    taskDef.addContainer('litellm', {
      image: ecs.ContainerImage.fromRegistry(`ghcr.io/berriai/litellm:${litellmVersion}`),
      // LiteLLM image ENTRYPOINT is 'litellm'; override with sh to run config-setup + litellm
      entryPoint: ['sh', '-c'],
      command: [
        'echo "$LITELLM_CONFIG_B64" | base64 -d > /tmp/config.yaml && litellm --config /tmp/config.yaml --port 4000',
      ],
      environment: {
        LITELLM_CONFIG_B64: Buffer.from(configYaml).toString('base64'),
        AWS_DEFAULT_REGION: 'ap-northeast-2',
      },
      secrets: {
        PROXY_MASTER_KEY: ecs.Secret.fromSecretsManager(masterKeySecret, 'key'),
      },
      portMappings: [{ containerPort: 4000, name: 'litellm' }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'litellm' }),
    });

    const albSG = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'LiteLLM Internal ALB - allow port 4000 from VPC',
      allowAllOutbound: true,
    });
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(4000));

    const ecsSG = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc: props.vpc,
      description: 'LiteLLM ECS Fargate tasks - allow from ALB only',
      allowAllOutbound: true,
    });
    ecsSG.addIngressRule(albSG, ec2.Port.tcp(4000));

    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443));

    const albInstance = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [ecsSG],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    const healthCheck = {
      path: '/health/liveliness',
      interval: cdk.Duration.seconds(30),
      healthyHttpCodes: '200',
    };

    if (props.certificateArn) {
      // Phase 8: HTTPS 443 with ACM cert
      const httpsListener = albInstance.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
        open: false,
      });
      httpsListener.addTargets('Target', {
        port: 4000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      });
    } else {
      // HTTP only (Phase 7 baseline)
      const httpListener = albInstance.addListener('Listener', {
        port: 4000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
      });
      httpListener.addTargets('Target', {
        port: 4000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      });
    }

    this.albDnsName = albInstance.loadBalancerDnsName;
    this.alb = albInstance;

    const scheme = props.certificateArn ? 'https' : 'http';
    const port   = props.certificateArn ? '443' : '4000';
    new cdk.CfnOutput(this, 'LiteLLMEndpoint', {
      value: `${scheme}://${albInstance.loadBalancerDnsName}:${port}`,
      description: 'LiteLLM endpoint (ANTHROPIC_BASE_URL for direct alias access)',
    });
    new cdk.CfnOutput(this, 'MasterKeySecretArn', {
      value: masterKeySecret.secretArn,
      description: 'aws secretsmanager get-secret-value --secret-id /nct/litellm/master-key --query SecretString --output text | jq -r .key',
    });
  }
}

function buildProxyConfig(
  vllmModels: VllmModelConfig[],
  bedrockModels: BedrockModelConfig[],
  vllmEndpoints: Record<string, string>,
): string {
  const lines: string[] = [
    'general_settings:',
    '  master_key: os.environ/PROXY_MASTER_KEY',
    'litellm_settings:',
    '  success_callback: []',
    '  failure_callback: []',
    'model_list:',
  ];

  for (const model of vllmModels) {
    const endpoint = vllmEndpoints[model.alias] ?? `http://placeholder-${model.alias}.internal:8000`;
    const aliases = [model.alias, ...(model.extraAliases ?? [])];

    for (const alias of aliases) {
      lines.push(
        `- model_name: ${alias}`,
        `  litellm_params:`,
        `    model: openai/${model.servingName}`,
        `    api_base: ${endpoint}/v1`,
        `    api_key: fake-key`,
        // drop_params: vLLM does not support extended_thinking / thinking fields
        `    drop_params: true`,
      );
    }
  }

  for (const m of bedrockModels) {
    lines.push(
      `- model_name: ${m.modelName}`,
      `  litellm_params:`,
      `    model: bedrock/${m.bedrockModelId}`,
      `    aws_region_name: ${m.awsRegion ?? 'ap-northeast-2'}`,
      // Claude Code 4.x sends `thinking: {type:"adaptive"}` — Bedrock Seoul Sonnet/Haiku
      // (non-Claude-4 models) reject this field → drop_params removes unsupported keys safely.
      `    drop_params: true`,
    );
  }

  return lines.join('\n');
}
