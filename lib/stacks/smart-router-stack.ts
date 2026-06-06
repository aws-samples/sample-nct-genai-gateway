import * as cdk from 'aws-cdk-lib/core';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'path';
import { Construct } from 'constructs';

export interface SmartRouterStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  /** Internal ALB DNS of LiteLLM (without scheme/port) */
  litellmEndpoint: string;
  /** Phase 8: ACM certificate ARN for HTTPS 443. HTTP-only when omitted. */
  certificateArn?: string;
}

export class SmartRouterStack extends cdk.Stack {
  /** Internal ALB DNS for the Smart Router — set as ANTHROPIC_BASE_URL for `general` use */
  public readonly albDnsName: string;
  /** ALB object — required by DnsStack for Route53 alias records */
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: SmartRouterStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'nct-smart-router',
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Build image from smart-router/Dockerfile — force amd64 for Fargate (Mac arm64 build host)
    const image = new ecr_assets.DockerImageAsset(this, 'RouterImage', {
      directory: path.join(__dirname, '../../smart-router'),
      platform: ecr_assets.Platform.LINUX_AMD64,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
    });

    const litellmScheme = props.certificateArn ? 'https' : 'http';
    const litellmPort   = props.certificateArn ? '443'  : '4000';

    // When an ACM-imported self-signed certificate fronts the internal LiteLLM
    // endpoint (https), the router must skip TLS verification for that self-signed
    // chain. Traffic is confined to the VPC CIDR by the security groups below.
    // Over plain http there is no TLS, so verification stays at its secure default.
    const verifyTls = props.certificateArn ? 'false' : 'true';

    taskDef.addContainer('router', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      environment: {
        LITELLM_BASE_URL: `${litellmScheme}://${props.litellmEndpoint}:${litellmPort}`,
        VERIFY_TLS: verifyTls,
      },
      portMappings: [{ containerPort: 8080, name: 'router' }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'smart-router' }),
    });

    const albSG = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: props.vpc,
      description: 'SmartRouter Internal ALB - allow from VPC',
      allowAllOutbound: true,
    });
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(4000));
    albSG.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443));

    const ecsSG = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc: props.vpc,
      description: 'SmartRouter ECS tasks - allow from ALB',
      allowAllOutbound: true,
    });
    ecsSG.addIngressRule(albSG, ec2.Port.tcp(8080));

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
      // Phase 8: HTTPS 443
      const httpsListener = albInstance.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
        open: false,
      });
      httpsListener.addTargets('Target', {
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      });
    } else {
      const httpListener = albInstance.addListener('Listener', {
        port: 4000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
      });
      httpListener.addTargets('Target', {
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck,
      });
    }

    this.albDnsName = albInstance.loadBalancerDnsName;
    this.alb = albInstance;

    const scheme = props.certificateArn ? 'https' : 'http';
    const port   = props.certificateArn ? '443' : '4000';
    new cdk.CfnOutput(this, 'SmartRouterEndpoint', {
      value: `${scheme}://${albInstance.loadBalancerDnsName}:${port}`,
      description: 'ANTHROPIC_BASE_URL for `general` alias routing',
    });
  }
}
