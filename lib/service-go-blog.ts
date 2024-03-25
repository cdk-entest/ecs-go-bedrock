import {
  aws_ec2,
  aws_ecr,
  aws_ecs,
  aws_elasticloadbalancingv2,
  aws_iam,
  Duration,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Effect } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

interface BlogProps extends StackProps {
  cluster: aws_ecs.Cluster;
  ecrRepoName: string;
  certificate: string;
  vpcId: string;
  vpcName: string;
}

export class BlogAppStack extends Stack {
  public readonly service: aws_ecs.FargateService;

  constructor(scope: Construct, id: string, props: BlogProps) {
    super(scope, id, props);

    // lookup an existed vpc
    const vpc = aws_ec2.Vpc.fromLookup(this, "LookUpVpcBlogService", {
      vpcId: props.vpcId,
      vpcName: props.vpcName,
    });

    // task role pull ecr image
    const executionRole = new aws_iam.Role(this, "RoleForEcsGoBlogApp", {
      assumedBy: new aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: "RoleForEcsGoBlogApp",
    });

    executionRole.addToPolicy(
      new aws_iam.PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ecr:*"],
        resources: ["*"],
      })
    );

    // ecs task definition
    const task = new aws_ecs.FargateTaskDefinition(
      this,
      "TaskDefinitionForGoBlogApp",
      {
        family: "latest",
        cpu: 2048,
        memoryLimitMiB: 4096,
        runtimePlatform: {
          operatingSystemFamily: aws_ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: aws_ecs.CpuArchitecture.X86_64,
        },
        // taskRole: "",
        // retrieve container images from ECR
        // executionRole: executionRole,
      }
    );

    // task add container
    task.addContainer("GoBlogAppTask", {
      containerName: props.ecrRepoName,
      memoryLimitMiB: 4096,
      memoryReservationMiB: 4096,
      stopTimeout: Duration.seconds(120),
      startTimeout: Duration.seconds(120),
      // image: aws_ecs.ContainerImage.fromRegistry(
      //   "public.ecr.aws/b5v7e4v7/blog-ecr:latest"
      // ),
      image: aws_ecs.ContainerImage.fromEcrRepository(
        aws_ecr.Repository.fromRepositoryName(
          this,
          props.ecrRepoName,
          props.ecrRepoName
        )
      ),
      portMappings: [{ containerPort: 3000 }],

      logging: new aws_ecs.AwsLogDriver({
        streamPrefix: props.ecrRepoName,
      }),

      // healthCheck: {
      //   command: []
      // },
    });

    // create ecs service
    const service = new aws_ecs.FargateService(this, "GoBlogAppService", {
      vpcSubnets: {
        subnetType: aws_ec2.SubnetType.PUBLIC,
      },
      assignPublicIp: true,
      cluster: props.cluster,
      taskDefinition: task,
      desiredCount: 1,
      // deploymentController: {
      // default rolling update
      // type: aws_ecs.DeploymentControllerType.ECS,
      // type: aws_ecs.DeploymentControllerType.CODE_DEPLOY,
      // },
      capacityProviderStrategies: [
        {
          capacityProvider: "FARGATE",
          weight: 1,
        },
        {
          capacityProvider: "FARGATE_SPOT",
          weight: 0,
        },
      ],
    });

    // scaling on cpu utilization
    const scaling = service.autoScaleTaskCount({
      maxCapacity: 4,
      minCapacity: 1,
    });

    scaling.scaleOnMemoryUtilization("CpuUtilization", {
      targetUtilizationPercent: 50,
    });

    // application load balancer
    const alb = new aws_elasticloadbalancingv2.ApplicationLoadBalancer(
      this,
      "ALBForGoBlogApp",
      {
        loadBalancerName: "ALBForGoBlogApp",
        vpc: vpc,
        internetFacing: true,
      }
    );

    // add listener
    const listener = alb.addListener("ListenerForGoBlogApp", {
      port: 80,
      open: true,
      protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
    });

    listener.addTargets("TargetForGoBlogApp", {
      port: 80,
      targets: [
        service.loadBalancerTarget({
          containerName: props.ecrRepoName,
          containerPort: 3000,
          protocol: aws_ecs.Protocol.TCP,
        }),
      ],
      healthCheck: {
        timeout: Duration.seconds(10),
      },
    });

    // exported
    this.service = service;
  }
}
