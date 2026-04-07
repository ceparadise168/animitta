import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as path from 'path'
import { Construct } from 'constructs'

export class PrajnaGateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: process.env.MEMORY_TABLE_NAME || 'prajna-gate-conversations',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const fn = new lambda.Function(this, 'PrajnaGateHandler', {
      functionName: 'prajna-gate',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../lambda')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'openai',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        CHAT_MODEL_OPENAI: process.env.CHAT_MODEL_OPENAI || 'gpt-4.1-mini',
        SUMMARY_MODEL_OPENAI: process.env.SUMMARY_MODEL_OPENAI || 'gpt-4.1-mini',
        CHAT_MODEL_ANTHROPIC: process.env.CHAT_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        SUMMARY_MODEL_ANTHROPIC: process.env.SUMMARY_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
        LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || '',
        MEMORY_TABLE_NAME: table.tableName,
        MAX_RECENT_TURNS: process.env.MAX_RECENT_TURNS || '5',
        SUMMARY_THRESHOLD: process.env.SUMMARY_THRESHOLD || '3000',
        CONVERSATION_TTL_DAYS: process.env.CONVERSATION_TTL_DAYS || '30',
      },
    })

    table.grantReadWriteData(fn)

    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: fnUrl.url,
      description: 'LINE Webhook URL — paste this into LINE Developers Console',
    })
  }
}
