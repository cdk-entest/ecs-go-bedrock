import * as cdk from "aws-cdk-lib";
import { EcsClusterStack } from "../lib/ecs-cluster";
import {
  VPC_ID,
  VPC_NAME,
  REGION,
  BUCKET_ANR,
  AOSS_ARN,
  GO_BLOG_ACM_CERT_ARN,
} from "../config";
import { GoBedrockService } from "../lib/service-go-bedrock";
import { BlogAppStack } from "../lib/service-go-blog";

const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

// create cdk app
const app = new cdk.App();

// create ecs cluster
const cluster = new EcsClusterStack(app, "EcsClusterStack", {
  vpcId: VPC_ID,
  vpcName: VPC_NAME,
  env: {
    region: REGION,
    account: ACCOUNT,
  },
});

// create a go hello app
new BlogAppStack(app, "BlogAppStack", {
  cluster: cluster.cluster,
  vpcId: VPC_ID,
  vpcName: VPC_NAME,
  certificate: GO_BLOG_ACM_CERT_ARN,
  ecrRepoName: "go-blog-app",
  env: {
    region: process.env.CDK_DEFAULT_REGION,
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
});

// create a go bedrock app
// new GoBedrockService(app, "GoBedrockService", {
//   cluster: cluster.cluster,
//   vpcId: VPC_ID,
//   vpcName: VPC_NAME,
//   certificate: "",
//   ecrRepoName: "go-bedrock-app",
//   aossCollectionArn: AOSS_ARN,
//   bucketArn: BUCKET_ANR,
//   env: {
//     region: process.env.CDK_DEFAULT_REGION,
//     account: process.env.CDK_DEFAULT_ACCOUNT,
//   },
// });
