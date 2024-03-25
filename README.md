---
title: build a simple genai app hosting on amazon ecs
author: haimtran
date: 01/02/2024
---

## Introduction

- create a ecs cluster
- create a blog app
- create a chatbot using bedrock

let create a stack to deploy chatbot service

<details>
<summary>chatstack.ts</summary>

```ts
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
import { ListenerCertificate } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Effect } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

interface GotBedrockProps extends StackProps {
  cluster: aws_ecs.Cluster;
  ecrRepoName: string;
  certificate: string;
  vpcId: string;
  vpcName: string;
  aossCollectionArn: string;
  bucketArn: string;
}

export class GoBedrockService extends Stack {
  public readonly service: aws_ecs.FargateService;

  constructor(scope: Construct, id: string, props: GotBedrockProps) {
    super(scope, id, props);

    // lookup an existed vpc
    const vpc = aws_ec2.Vpc.fromLookup(this, "LookUpVpcBlogService", {
      vpcId: props.vpcId,
      vpcName: props.vpcName,
    });

    // task role
    const taskRole = new aws_iam.Role(this, "RoleForGoBedrockSimpleService", {
      assumedBy: new aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: "RoleForGoBedrockSimpleService",
    });

    const task = new aws_ecs.FargateTaskDefinition(
      this,
      "TaskDefinitionForGoBedrockSimpleService",
      {
        family: "latest",
        cpu: 4096,
        memoryLimitMiB: 8192,
        runtimePlatform: {
          operatingSystemFamily: aws_ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: aws_ecs.CpuArchitecture.X86_64,
        },
        // default cdk create
        taskRole: taskRole,
        // retrieve container images from ECR
        // executionRole: executionRole,
      }
    );

    // call bedrock models
    task.addToTaskRolePolicy(
      new aws_iam.PolicyStatement({
        effect: Effect.ALLOW,
        resources: ["arn:aws:bedrock:us-east-1::foundation-model/*"],
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
      })
    );

    // access s3 bucket
    task.addToTaskRolePolicy(
      new aws_iam.PolicyStatement({
        effect: Effect.ALLOW,
        resources: [`${props.bucketArn}/*`],
        actions: ["s3:*"],
      })
    );

    // invoke opensearch
    task.addToTaskRolePolicy(
      new aws_iam.PolicyStatement({
        effect: Effect.ALLOW,
        resources: [props.aossCollectionArn],
        actions: ["aoss:APIAccessAll"],
      })
    );

    // task add container
    task.addContainer("GoBedrockSimpleServiceTask", {
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
    });

    const service = new aws_ecs.FargateService(
      this,
      "EcsGoBedrockSimpleService",
      {
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
      }
    );

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
      "AlbForGoBedrockSimpleService",
      {
        loadBalancerName: "AlbForGoBedrockSimpleService",
        vpc: vpc,
        internetFacing: true,
      }
    );

    // add listener
    const listener = alb.addListener("ListenerEcsGoBedrockSimpleService", {
      port: 80,
      open: true,
      protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
    });

    listener.addTargets("EcsGoBedrockSimpleService", {
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

    // // add listener https
    // const listenerHttps = alb.addListener(
    //   "ListenerHttpsGoBedrockSimpleService",
    //   {
    //     port: 443,
    //     open: true,
    //     protocol: aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
    //     certificates: [ListenerCertificate.fromArn(props.certificate)],
    //   }
    // );

    // // listner add target
    // listenerHttps.addTargets("EcsServiceHttpsGoBedrockSimpleService", {
    //   port: 80,
    //   targets: [
    //     service.loadBalancerTarget({
    //       containerName: props.ecrRepoName,
    //       containerPort: 3000,
    //       protocol: aws_ecs.Protocol.TCP,
    //     }),
    //   ],
    //   healthCheck: {
    //     timeout: Duration.seconds(10),
    //   },
    // });

    this.service = service;
  }
}
```

</details>

And another for blogapp

<details>
<summary>blogapp.stack</summary>

```ts
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
```

</details>

## ECS Cluster

Let create a ecs cluser within an existing VPC

```ts
import {
  aws_ec2,
  aws_ecs,
  Stack,
  StackProps,
  IAspect,
  Aspects,
} from "aws-cdk-lib";
import { Construct, IConstruct } from "constructs";

interface EcsProps extends StackProps {
  vpcId: string;
  vpcName: string;
}

export class EcsClusterStack extends Stack {
  public readonly cluster: aws_ecs.Cluster;

  constructor(scope: Construct, id: string, props: EcsProps) {
    super(scope, id, props);

    Aspects.of(this).add(new CapacityProviderDependencyAspect());

    // lookup an existed vpc
    const vpc = aws_ec2.Vpc.fromLookup(this, "LookUpVpcForEcsCluster", {
      vpcId: props.vpcId,
      vpcName: props.vpcName,
    });

    // ecs cluster
    this.cluster = new aws_ecs.Cluster(this, "EcsClusterForNextApps", {
      vpc: vpc,
      clusterName: "EcsClusterForNextApps",
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });
  }
}

/**
 * Add a dependency from capacity provider association to the cluster
 * and from each service to the capacity provider association.
 */
class CapacityProviderDependencyAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof aws_ecs.CfnClusterCapacityProviderAssociations) {
      // IMPORTANT: The id supplied here must be the same as the id of your cluster. Don't worry, you won't remove the cluster.
      node.node.scope?.node.tryRemoveChild("EcsClusterForNextApps");
    }

    if (node instanceof aws_ecs.Ec2Service) {
      const children = node.cluster.node.findAll();
      for (const child of children) {
        if (child instanceof aws_ecs.CfnClusterCapacityProviderAssociations) {
          child.node.addDependency(node.cluster);
          node.node.addDependency(child);
        }
      }
    }
  }
}
```

## ECS Service

- blog app service
- chatbot service using amazon bedrock
- expose via application load balancer

## Deployment

Dockefile

```go
# syntax=docker/dockerfile:1

# Build the application from source
FROM golang:1.21.5 AS build-stage

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -o /entest

# Run the tests in the container
FROM build-stage AS run-test-stage

# Deploy the application binary into a lean image
FROM gcr.io/distroless/base-debian11 AS build-release-stage

WORKDIR /

COPY --from=build-stage /entest /entest
COPY *.html ./
COPY static ./static

EXPOSE 3000

USER nonroot:nonroot

ENTRYPOINT ["/entest"]
```

and build script

```go
"""
haimtran 12/03/2024
build golang chatbot demo
deploy and update serivce
"""

import os
import boto3

# parameters
REGION = "ap-southeast-1"
ACCOUNT = os.environ["ACCOUNT_ID"]

# delete all docker images
os.system("sudo docker system prune -a")

# build go-blog-app image
os.system("sudo docker build -t go-blog-app . ")

#  aws ecr login
os.system(
    f"aws ecr get-login-password --region {REGION} | sudo docker login --username AWS --password-stdin {ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com"
)

# get image id
IMAGE_ID = os.popen("sudo docker images -q go-blog-app:latest").read()

# tag go-blog-app image
os.system(
    f"sudo docker tag {IMAGE_ID.strip()} {ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/go-blog-app:latest"
)

# create ecr repository
os.system(
    f"aws ecr create-repository --registry-id {ACCOUNT} --repository-name go-blog-app --region {REGION}"
)

# push image to ecr
os.system(
    f"sudo docker push {ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/go-blog-app:latest"
)

# run locally to test
# os.system(f"sudo docker run -d -p 3001:3000 go-blog-app:latest")


def update_service():
    """
    update service
    """
    # cluster
    ecs = boto3.client("ecs", region_name=REGION)
    cluster = "EcsClusterForNextApps"
    # update service
    response = ecs.update_service(
        cluster=cluster,
        service="",
        forceNewDeployment=True,
    )
    print(response)


# update_service()

```

## Bedrock App

- project structure
- integrate with bedrock
- http webserver and frontend

Here is example code to integrate with bedrock and response stream to client

```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

// claude3 request data type
type Content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type Message struct {
	Role    string    `json:"role"`
	Content []Content `json:"content"`
}

type RequestBodyClaude3 struct {
	MaxTokensToSample int       `json:"max_tokens"`
	Temperature       float64   `json:"temperature,omitempty"`
	AnthropicVersion  string    `json:"anthropic_version"`
	Messages          []Message `json:"messages"`
}

// frontend request data type
type FrontEndRequest struct {
	Messages []Message `json:"messages"`
}

// claude3 response data type
type Delta struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type ResponseClaude3 struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
	Delta Delta  `json:"delta"`
}


func HandleBedrockClaude3HaikuChat(w http.ResponseWriter, r *http.Request) {

	// list of messages sent from frontend client
	var request FrontEndRequest

	// parse mesage from request
	error := json.NewDecoder(r.Body).Decode(&request)

	if error != nil {
		panic(error)
	}

	messages := request.Messages

	fmt.Println(messages)

	payload := RequestBodyClaude3{
		MaxTokensToSample: 2048,
		AnthropicVersion:  "bedrock-2023-05-31",
		Temperature:       0.9,
		Messages:          messages,
	}

	payloadBytes, error := json.Marshal(payload)

	if error != nil {
		fmt.Fprintf(w, "ERROR")
		// return "", error
	}

	output, error := BedrockClient.InvokeModelWithResponseStream(
		context.Background(),
		&bedrockruntime.InvokeModelWithResponseStreamInput{
			Body:        payloadBytes,
			ModelId:     aws.String("anthropic.claude-3-haiku-20240307-v1:0"),
			ContentType: aws.String("application/json"),
			Accept:      aws.String("application/json"),
		},
	)

	if error != nil {
		fmt.Fprintf(w, "ERROR")
		// return "", error
	}

	for event := range output.GetStream().Events() {
		switch v := event.(type) {
		case *types.ResponseStreamMemberChunk:

			//fmt.Println("payload", string(v.Value.Bytes))

			var resp ResponseClaude3
			err := json.NewDecoder(bytes.NewReader(v.Value.Bytes)).Decode(&resp)
			if err != nil {
				fmt.Fprintf(w, "ERROR")
				// return "", err
			}

			fmt.Println(resp.Delta.Text)

			fmt.Fprintf(w, resp.Delta.Text)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			} else {
				fmt.Println("Damn, no flush")
			}

		case *types.UnknownUnionMember:
			fmt.Println("unknown tag:", v.Tag)

		default:
			fmt.Println("union is nil or unknown type")
		}
	}
}

```

Here is a simple web server

```go
package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

var BedrockClient *bedrockruntime.Client

func init() {

	cfg, err := config.LoadDefaultConfig(context.Background(), config.WithRegion("us-east-1"))

	if err != nil {
		log.Fatal(err)
	}
	BedrockClient = bedrockruntime.NewFromConfig(cfg)

}

func main() {

	mux := http.NewServeMux()

	// home page
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./static/haiku.html")
	})

	// book page
	mux.HandleFunc("/book", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./static/book.html")
	})

	// bedrock batch response
	mux.HandleFunc("/bedrock-haiku", HandleBedrockClaude3HaikuChat)

	// create web server
	server := &http.Server{
		Addr:           ":3001",
		Handler:        mux,
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   30 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}

	// enable logging
	log.Fatal(server.ListenAndServe())

}

```

and here is simple frontend

<details>
<summary>chat.html</summary>

```go
<html>
  <head>
    <meta name="viewport" content="width=device-width" />
    <style>
      :root {
        box-sizing: border-box;
      }
      *,
      ::before,
      ::after {
        box-sizing: inherit;
      }

      body {
        /* background-color: antiquewhite; */
      }

      .container {
        width: 100%;
        max-width: 500px;
        margin: auto;
        /* background-color: antiquewhite; */
      }

      .button {
        background-color: #43a047;
        padding: 8px 20px;
        border-radius: 5px;
        border: none;
        cursor: pointer;
        position: absolute;
        transform: translateY(-50%);
        top: 50%;
        right: 10px;
        opacity: 0.8;
      }

      .button:hover {
        background-color: orange;
      }

      .text-input {
        padding: 10px 15px;
        width: 100%;
        outline: none;
        border: solid black 1px;
        background-color: #e0e0e0;
        box-shadow: 0 10px 15px -3px #e0e0e0;

        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
          sans-serif;
        font-size: medium;
        font-weight: 400;
        letter-spacing: normal;
        line-height: 25px;
      }

      .text-input:focus {
        border: solid #4caf50 1.5px;
        outline: none;
      }

      .container-input {
        position: relative;
      }

      .form {
        margin-top: 20px;
      }

      .text-model {
        /* color: #4caf50; */
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue",
          sans-serif;
        font-size: medium;
        font-weight: 400;
        letter-spacing: normal;
        line-height: 25px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <form id="form" onkeydown="return event.key != 'Enter';" class="form">
        <div class="container-input">
          <input class="text-input" type="text" id="text-input" />
          <button id="submit" class="button">Ask</button>
        </div>
      </form>
      <div>
        <p id="model-answer" class="text-model"></p>
      </div>
    </div>
    <script>
      // conversation turns
      let messages = [];

      // get html component for model answer
      const modelAnswer = document.getElementById("model-answer");

      const callBedrockStream = async () => {
        // present model answer to frontend
        modelAnswer.innerText = "";

        // get user question
        const userQuestion = document.getElementById("text-input").value;

        // push user question to messages
        messages.push({
          role: "user",
          content: [{ type: "text", text: userQuestion }],
        });

        if (userQuestion) {
          try {
            const response = await fetch("/bedrock-haiku", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ messages: messages }),
            });

            console.log(response);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              const text = decoder.decode(value);
              console.log(text);
              modelAnswer.innerText += text;
            }

            // push model answer to converstion turn
            messages.push({
              role: "assistant",
              content: [{ type: "text", text: modelAnswer.innerText }],
            });
          } catch (error) {
            console.log(error);
          }
        } else {
          console.log("Please enter question ...");
        }
      };

      document
        .getElementById("submit")
        .addEventListener("click", async (event) => {
          event.preventDefault();
          await callBedrockStream();
        });

      document
        .getElementById("text-input")
        .addEventListener("keydown", async (event) => {
          if (event.code === "Enter") {
            await callBedrockStream();
          }
        });
    </script>
  </body>
</html>

```

</details>

Another simple book page for testing

<details>
<summary>book.html</summary>

```html
<!DOCTYPE html>
<!-- entest 29 april 2023 basic tailwind -->
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link
      href="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/review-book.css"
      rel="stylesheet"
    />
  </head>
  <body class="bg-gray-100">
    <div class="bg-green-400 py-3">
      <nav class="flex mx-auto max-w-5xl justify-between">
        <a href="#" class="font-bold text-2xl"> Entest </a>
        <ul class="hidden md:flex gap-x-3">
          <li
            class="bg-white hover:bg-green-600 hover:text-white px-3 py-1 rounded-sm"
          >
            <a href="https://cdk.entest.io/" target="_blank">About Me</a>
          </li>
        </ul>
      </nav>
    </div>
    <div
      class="bg-[url('https://d2cvlmmg8c0xrp.cloudfront.net/web-css/singapore.jpg')] bg-no-repeat bg-cover"
    >
      <div class="mx-auto max-w-5xl pt-20 pb-48 pr-48 mb-10 text-right">
        <h2 class="invisible md:visible text-3xl font-bold mb-8">
          Good Books about AWS Cloud Computing
        </h2>
      </div>
    </div>
    <div class="mx-auto max-w-5xl">
      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Data Engineering with AWS</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/data_engineering_with_aws.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            This is a great book for understanding and implementing the lake
            house architecture to integrate your Data Lake with your warehouse.
            It shows you all the steps you need to orchestrate your data
            pipeline. From architecture, ingestion, and processing to running
            queries in your data warehouse, I really like the very hands-on
            approach that shows you how you can immediately implement the topics
            in your AWS account Andreas Kretz, CEO, Learn Data Engineering
          </p>
          <a
            href="https://www.amazon.com/Data-Engineering-AWS-Gareth-Eagar/dp/1800560419/ref=sr_1_1?crid=28BFB3NXGTM9G&amp;keywords=data+engineering+with+aws&amp;qid=1682772617&amp;sprefix=data+engineering+with+aws%2Caps%2C485&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Data Science on AWS</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/data_science_on_aws.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            With this practical book, AI and machine learning practitioners will
            learn how to successfully build and deploy data science projects on
            Amazon Web Services. The Amazon AI and machine learning stack
            unifies data science, data engineering, and application development
            to help level up your skills. This guide shows you how to build and
            run pipelines in the cloud, then integrate the results into
            applications in minutes instead of days. Throughout the book,
            authors Chris Fregly and Antje Barth demonstrate how to reduce cost
            and improve performance.
          </p>
          <a
            href="https://www.amazon.com/Data-Science-AWS-End-End/dp/1492079391/ref=sr_1_1?crid=17XK1VLHDZH59&amp;keywords=data+science+on+aws&amp;qid=1682772629&amp;sprefix=data+science+on+%2Caps%2C327&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">
            Serverless Analytics with Amazon Athena
          </h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/serverless_athena.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            This book begins with an overview of the serverless analytics
            experience offered by Athena and teaches you how to build and tune
            an S3 Data Lake using Athena, including how to structure your tables
            using open-source file formats like Parquet. You willl learn how to
            build, secure, and connect to a data lake with Athena and Lake
            Formation. Next, you will cover key tasks such as ad hoc data
            analysis, working with ETL pipelines, monitoring and alerting KPI
            breaches using CloudWatch Metrics, running customizable connectors
            with AWS Lambda, and more. Moving on, you will work through easy
            integrations, troubleshooting and tuning common Athena issues, and
            the most common reasons for query failure.You will also review tips
            to help diagnose and correct failing queries in your pursuit of
            operational excellence.Finally, you will explore advanced concepts
            such as Athena Query Federation and Athena ML to generate powerful
            insights without needing to touch a single server.
          </p>
          <a
            href="https://www.amazon.com/Serverless-Analytics-Amazon-Athena-semi-structured/dp/1800562349/ref=sr_1_1?crid=2KSTZBI4HUBZS&amp;keywords=serverless+athena&amp;qid=1682772648&amp;sprefix=serverless+athe%2Caps%2C323&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">
            Serverless ETL and Analytics with AWS Glue
          </h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/serverless_glue.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            Beginning with AWS Glue basics, this book teaches you how to perform
            various aspects of data analysis such as ad hoc queries, data
            visualization, and real time analysis using this service. It also
            provides a walk-through of CI/CD for AWS Glue and how to shift left
            on quality using automated regression tests. You will find out how
            data security aspects such as access control, encryption, auditing,
            and networking are implemented, as well as getting to grips with
            useful techniques such as picking the right file format,
            compression, partitioning, and bucketing.As you advance, you will
            discover AWS Glue features such as crawlers, Lake Formation,
            governed tables, lineage, DataBrew, Glue Studio, and custom
            connectors. The concluding chapters help you to understand various
            performance tuning, troubleshooting, and monitoring options.
          </p>
          <a
            href="https://www.amazon.com/Serverless-ETL-Analytics-Glue-comprehensive/dp/1800564988/ref=sr_1_1?crid=HJXN5QBY7F2P&amp;keywords=serverless+ETL+with+glue+aws&amp;qid=1682772669&amp;sprefix=serverless+etl+with+glue+a%2Caps%2C324&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">
            Simplify Big Data Analytics with Amazon EMR
          </h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/amazon_emr.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            Amazon EMR, formerly Amazon Elastic MapReduce, provides a managed
            Hadoop cluster in Amazon Web Services (AWS) that you can use to
            implement batch or streaming data pipelines. By gaining expertise in
            Amazon EMR, you can design and implement data analytics pipelines
            with persistent or transient EMR clusters in AWS.This book is a
            practical guide to Amazon EMR for building data pipelines. You will
            start by understanding the Amazon EMR architecture, cluster nodes,
            features, and deployment options, along with their pricing. Next,
            the book covers the various big data applications that EMR supports.
            You will then focus on the advanced configuration of EMR
            applications, hardware, networking, security, troubleshooting,
            logging, and the different SDKs and APIs it provides. Later chapters
            will show you how to implement common Amazon EMR use cases,
            including batch ETL with Spark, real time streaming with Spark
            Streaming, and handling UPSERT in S3 Data Lake with Apache Hudi.
            Finally, you will orchestrate your EMR jobs and strategize on
            premises Hadoop cluster migration to EMR. In addition to this, you
            will explore best practices and cost optimization techniques while
            implementing your data analytics pipeline in EMR
          </p>
          <a
            href="https://www.amazon.com/Simplify-Big-Data-Analytics-Amazon/dp/1801071071/ref=sr_1_1?crid=1BHYUKJ14LKNU&amp;keywords=%22Simplify+Big+Data+Analytics+with+Amazon+EMR&amp;qid=1682772695&amp;sprefix=simplify+big+data+analytics+with+amazon+emr%2Caps%2C322&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">
            Scalable Data Streaming with Amazon Kinesis
          </h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/amazon_kinesis.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            Amazon Kinesis is a collection of secure, serverless, durable, and
            highly available purpose built data streaming services. This data
            streaming service provides APIs and client SDKs that enable you to
            produce and consume data at scale. Scalable Data Streaming with
            Amazon Kinesis begins with a quick overview of the core concepts of
            data streams, along with the essentials of the AWS Kinesis
            landscape. You will then explore the requirements of the use case
            shown through the book to help you get started and cover the key
            pain points encountered in the data stream life cycle. As you
            advance, you will get to grips with the architectural components of
            Kinesis, understand how they are configured to build data pipelines,
            and delve into the applications that connect to them for consumption
            and processing. You will also build a Kinesis data pipeline from
            scratch and learn how to implement and apply practical solutions.
            Moving on, you will learn how to configure Kinesis on a cloud
            platform. Finally, you will learn how other AWS services can be
            integrated into Kinesis. These services include Redshift, Dynamo
            Database, AWS S3, Elastic Search, and third-party applications such
            as Splunk.
          </p>
          <a
            href="https://www.amazon.com/Scalable-Data-Streaming-Amazon-Kinesis/dp/1800565402/ref=sr_1_1?crid=1CC6W33MEW2GE&amp;keywords=Scalable+Data+Streaming+with+Amazon+Kinesis&amp;qid=1682772706&amp;sprefix=scalable+data+streaming+with+amazon+kinesis%2Caps%2C312&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">
            Actionable Insights with Amazon QuickSight
          </h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/amazon_quicksight.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            Amazon Quicksight is an exciting new visualization that rivals
            PowerBI and Tableau, bringing several exciting features to the table
            but sadly, there are not many resources out there that can help you
            learn the ropes. This book seeks to remedy that with the help of an
            AWS certified expert who will help you leverage its full
            capabilities. After learning QuickSight is fundamental concepts and
            how to configure data sources, you will be introduced to the main
            analysis-building functionality of QuickSight to develop visuals and
            dashboards, and explore how to develop and share interactive
            dashboards with parameters and on screen controls. You will dive
            into advanced filtering options with URL actions before learning how
            to set up alerts and scheduled reports.
          </p>
          <a
            href="https://www.amazon.com/Actionable-Insights-Amazon-QuickSight-learning-driven/dp/1801079293/ref=sr_1_1?crid=1F6H7KDE97RHA&amp;keywords=Actionable+Insights+with+Amazon+QuickSight&amp;qid=1682772719&amp;sprefix=actionable+insights+with+amazon+quicksight%2Caps%2C305&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Amazon Redshift Cookbook</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/redshift_cook_book.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            Amazon Redshift is a fully managed, petabyte-scale AWS cloud data
            warehousing service. It enables you to build new data warehouse
            workloads on AWS and migrate on-premises traditional data
            warehousing platforms to Redshift. This book on Amazon Redshift
            starts by focusing on Redshift architecture, showing you how to
            perform database administration tasks on Redshift.You will then
            learn how to optimize your data warehouse to quickly execute complex
            analytic queries against very large datasets. Because of the massive
            amount of data involved in data warehousing, designing your database
            for analytical processing lets you take full advantage of Redshifts
            columnar architecture and managed services.As you advance, you will
            discover how to deploy fully automated and highly scalable extract,
            transform, and load (ETL) processes, which help minimize the
            operational efforts that you have to invest in managing regular ETL
            pipelines and ensure the timely and accurate refreshing of your data
            warehouse. Finally, you will gain a clear understanding of Redshift
            use cases, data ingestion, data management, security, and scaling so
            that you can build a scalable data warehouse platform.
          </p>
          <a
            href="https://www.amazon.com/Amazon-Redshift-Cookbook-warehousing-solutions/dp/1800569688/ref=sr_1_1?crid=2P8V7A8548HBG&amp;keywords=Amazon+Redshift+Cookbook&amp;qid=1682772732&amp;sprefix=amazon+redshift+cookbook%2Caps%2C315&amp;sr=8-1&amp;ufe=app_do%3Aamzn1.fos.006c50ae-5d4c-4777-9bc0-4513d670b6bc"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Automated Machine Learning on AWS</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/automated_ml_on_aws.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            Automated Machine Learning on AWS begins with a quick overview of
            what the machine learning pipeline/process looks like and highlights
            the typical challenges that you may face when building a pipeline.
            Throughout the book, you&#39;ll become well versed with various AWS
            solutions such as Amazon SageMaker Autopilot, AutoGluon, and AWS
            Step Functions to automate an end-to-end ML process with the help of
            hands-on examples. The book will show you how to build, monitor, and
            execute a CI/CD pipeline for the ML process and how the various
            CI/CD services within AWS can be applied to a use case with the
            Cloud Development Kit (CDK). You&#39;ll understand what a
            data-centric ML process is by working with the Amazon Managed
            Services for Apache Airflow and then build a managed Airflow
            environment. You&#39;ll also cover the key success criteria for an
            MLSDLC implementation and the process of creating a self-mutating
            CI/CD pipeline using AWS CDK from the perspective of the platform
            engineering team
          </p>
          <a
            href="https://www.amazon.com/Automated-Machine-Learning-AWS-production-ready/dp/1801811822/ref=sr_1_1?crid=30X8QQER05M37&amp;keywords=Automated+Machine+Learning+on+AWS&amp;qid=1682772744&amp;sprefix=automated+machine+learning+on+aws%2Caps%2C327&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Kubernetes Up and Running</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/kubernetes_up_running.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            In just five years, Kubernetes has radically changed the way
            developers and ops personnel build, deploy, and maintain
            applications in the cloud. With this book is updated third edition,
            you will learn how this popular container orchestrator can help your
            company achieve new levels of velocity, agility, reliability, and
            efficiency whether you are new to distributed systems or have been
            deploying cloud native apps for some time.
          </p>
          <a
            href="https://www.amazon.com/Kubernetes-Running-Dive-Future-Infrastructure/dp/109811020X/ref=sr_1_1?crid=2H4E57L24G3C5&amp;keywords=Kubernetes+Up+and+Running&amp;qid=1682772756&amp;sprefix=kubernetes+up+and+running%2Caps%2C332&amp;sr=8-1&amp;ufe=app_do%3Aamzn1.fos.006c50ae-5d4c-4777-9bc0-4513d670b6bc"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Getting Started with Containerization</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/containerization.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            Kubernetes is an open source orchestration platform for managing
            containers in a cluster environment. This Learning Path introduces
            you to the world of containerization, in addition to providing you
            with an overview of Docker fundamentals. As you progress, you will
            be able to understand how Kubernetes works with containers. Starting
            with creating Kubernetes clusters and running applications with
            proper authentication and authorization, you will learn how to
            create high- availability Kubernetes clusters on Amazon Web
            Services(AWS), and also learn how to use kubeconfig to manage
            different clusters.Whether it is learning about Docker containers
            and Docker Compose, or building a continuous delivery pipeline for
            your application, this Learning Path will equip you with all the
            right tools and techniques to get started with containerization.
          </p>
          <a
            href="https://www.amazon.com/Getting-Started-Containerization-operational-automating-ebook/dp/B07Q4952SH/ref=sr_1_1?crid=3PUMFFKQW7EG6&amp;keywords=getting+started+with+containerization&amp;qid=1682772768&amp;sprefix=getting+started+with+containerizatio%2Caps%2C318&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Production Kubernetes</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/singapore.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            Kubernetes has become the dominant container orchestrator, but many
            organizations that have recently adopted this system are still
            struggling to run actual production workloads. In this practical
            book, four software engineers from VMware bring their shared
            experiences running Kubernetes in production and provide insight on
            key challenges and best practices. The brilliance of Kubernetes is
            how configurable and extensible the system is, from pluggable
            runtimes to storage integrations. For platform engineers, software
            developers, infosec, network engineers, storage engineers, and
            others, this book examines how the path to success with Kubernetes
            involves a variety of technology, pattern, and abstraction
            considerations.
          </p>
          <a
            href="https://www.amazon.com/Production-Kubernetes-Successful-Application-Platforms/dp/B0C2JG8HN4/ref=sr_1_1?crid=2VL6HBN63YSKR&amp;keywords=Production+Kubernetes&amp;qid=1682772779&amp;sprefix=production+kubernetes%2Caps%2C320&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Practical Vim</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/practical_vim.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            Vim is a fast and efficient text editor that will make you a faster
            and more efficient developer. It&#39;s available on almost every OS,
            and if you master the techniques in this book, you will never need
            another text editor. In more than 120 Vim tips, you will quickly
            learn the editor&#39;s core functionality and tackle your trickiest
            editing and writing tasks. This beloved bestseller has been revised
            and updated to Vim 8 and includes three brand-new tips and five
            fully revised tips.
          </p>
          <a
            href="https://www.amazon.com/Practical-Vim-Edit-Speed-Thought/dp/1680501275/ref=sr_1_1?crid=37R58M1VK37ED&amp;keywords=Practical+Vim&amp;qid=1682772791&amp;s=audible&amp;sprefix=practical+vim%2Caudible%2C304&amp;sr=1-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">CSS In Depth</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/css_in_depth.jpeg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            CSS in Depth exposes you to a world of CSS techniques that range
            from clever to mind-blowing. This instantly useful book is packed
            with creative examples and powerful best practices that will sharpen
            your technical skills and inspire your sense of design.
          </p>
          <a
            href="https://www.amazon.com/CSS-Depth-Keith-J-Grant/dp/1617293458/ref=sr_1_1?crid=SRUEMD3CZ94C&amp;keywords=CSS+In+Depth&amp;qid=1682772805&amp;sprefix=css+in+depth%2Caps%2C326&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Effective Typescript</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/effective_typescript.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            TypeScript is a typed superset of JavaScript with the potential to
            solve many of the headaches for which JavaScript is famous. But
            TypeScript has a learning curve of its own, and understanding how to
            use it effectively can take time. This book guides you through 62
            specific ways to improve your use of TypeScript
          </p>
          <a
            href="https://www.amazon.com/Effective-TypeScript-Specific-Ways-Improve/dp/1492053740/ref=sr_1_1?crid=1BPGNPZ1QMNOI&amp;keywords=%22Effective+Typescript&amp;qid=1682772816&amp;sprefix=effective+typescript%2Caps%2C318&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">
            Unix and Linux System Administration Handbook
          </h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/unix_linux_admin.jpeg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            UNIX and Linux System Administration Handbook, Fifth Edition, is
            today definitive guide to installing, configuring, and maintaining
            any UNIX or Linux system, including systems that supply core
            Internet and cloud infrastructure. Updated for new distributions and
            cloud environments, this comprehensive guide covers best practices
            for every facet of system administration, including storage
            management, network design and administration, security, web
            hosting, automation, configuration management, performance analysis,
            virtualization, DNS, security, and the management of IT service
            organizations. The authors―world-class, hands-on technologists―offer
            indispensable new coverage of cloud platforms, the DevOps
            philosophy, continuous deployment, containerization, monitoring, and
            many other essential topics.Whatever your role in running systems
            and networks built on UNIX or Linux, this conversational,
            well-written ¿guide will improve your efficiency and help solve your
            knottiest problems.
          </p>
          <a
            href="https://www.amazon.com/UNIX-Linux-System-Administration-Handbook/dp/0134277554/ref=sr_1_1?crid=1HWI8UE6KJ6PT&amp;keywords=Unix+and+Linux+System+Administration+Handbook&amp;qid=1682772831&amp;sprefix=unix+and+linux+system+administration+handbook%2Caps%2C320&amp;sr=8-1"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>

      <div class="md:flex gap-x-5 flex-row mb-8">
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Computer Organization and Design</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/computer_organization.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p>
            Computer Organization and Design, Fifth Edition, is the latest
            update to the classic introduction to computer organization. The
            text now contains new examples and material highlighting the
            emergence of mobile computing and the cloud. It explores this
            generational change with updated content featuring tablet computers,
            cloud infrastructure, and the ARM (mobile computing devices) and x86
            (cloud computing) architectures. The book uses a MIPS processor core
            to present the fundamentals of hardware technologies, assembly
            language, computer arithmetic, pipelining, memory hierarchies and
            I/Because an understanding of modern hardware is essential to
            achieving good performance and energy efficiency, this edition adds
            a new concrete example, Going Faster, used throughout the text to
            demonstrate extremely effective optimization techniques. There is
            also a new discussion of the Eight Great Ideas of computer
            architecture. Parallelism is examined in depth with examples and
            content highlighting parallel hardware and software topics. The book
            features the Intel Core i7, ARM Cortex A8 and NVIDIA Fermi GPU as
            real world examples, along with a full set of updated and improved
            exercises.
          </p>
          <a
            href="https://www.amazon.com/Computer-Organization-Design-RISC-V-Architecture/dp/0128203315/ref=sr_1_1?crid=2SWQJ2EPAWKZT&amp;keywords=Computer+Organization+and+Design&amp;qid=1682772842&amp;sprefix=computer+organization+and+design%2Caps%2C329&amp;sr=8-1&amp;ufe=app_do%3Aamzn1.fos.006c50ae-5d4c-4777-9bc0-4513d670b6bc"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
        <div class="ml-4 bg-white flex-auto w-full">
          <h4 class="font-bold mb-8">Database Systems The Complete Book</h4>
          <div>
            <img
              src="https://d2cvlmmg8c0xrp.cloudfront.net/web-css/database_system.jpg"
              class="float-left h-auto w-64 mr-6"
              alt="book-image"
            />
          </div>
          <p></p>
          <p>
            Database Systems: The Complete Book is ideal for Database Systems
            and Database Design and Application courses offered at the junior,
            senior and graduate levels in Computer Science departments. A basic
            understanding of algebraic expressions and laws, logic, basic data
            structure, OOP concepts, and programming environments is implied.
            Written by well-known computer scientists, this introduction to
            database systems offers a comprehensive approach, focusing on
            database design, database use, and implementation of database
            applications and database management systems.
          </p>
          <a
            href="https://www.amazon.com/Database-Systems-Complete-Book-2nd/dp/0131873253/ref=sr_1_1?crid=3E1GPJPYRNH9Z&amp;keywords=Database+Systems+The+Complete+Book&amp;qid=1682772851&amp;sprefix=database+systems+the+complete+book%2Caps%2C336&amp;sr=8-1&amp;ufe=app_do%3Aamzn1.fos.f5122f16-c3e8-4386-bf32-63e904010ad0"
            target="_blank"
          >
            <button
              class="bg-orange-300 px-14 py-3 rounded-md shadow-md hover:bg-orange-400"
            >
              Amazon
            </button>
          </a>
        </div>
      </div>
    </div>
    <footer class="bg-gray-200 mt-12 text-gray-00 py-4">
      <div class="mx-auto max-w-5xl text-center text-base">
        Copyright &copy; 2023 entest, Inc
      </div>
    </footer>
  </body>
</html>
```

</details>
