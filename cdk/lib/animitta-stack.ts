import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as scheduler from 'aws-cdk-lib/aws-scheduler'
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets'
import * as path from 'path'
import { Construct } from 'constructs'

const KEY_REMINDER_DAYS_BEFORE = [7, 1]

export class AnimittaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: process.env.MEMORY_TABLE_NAME || 'animitta-conversations',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Voice messages and their transcripts wait here only while a job runs;
    // the code deletes them right after, and anything a failed delete leaves
    // behind is gone within a day.
    const voiceBucket = new s3.Bucket(this, 'VoiceBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
    })

    const fn = new lambda.Function(this, 'AnimittaHandler', {
      functionName: 'animitta',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../lambda')),
      memorySize: 256,
      // A voice message is transcribed and answered within LINE's one-minute
      // reply token; after the reply, the memory may still be summarized, so
      // the function gets more time than the token.
      timeout: cdk.Duration.seconds(90),
      environment: {
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'openai',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        CHAT_MODEL_OPENAI: process.env.CHAT_MODEL_OPENAI || 'gpt-4.1-mini',
        SUMMARY_MODEL_OPENAI: process.env.SUMMARY_MODEL_OPENAI || 'gpt-4.1-mini',
        CHAT_MODEL_ANTHROPIC: process.env.CHAT_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        CHAT_EFFORT_ANTHROPIC: process.env.CHAT_EFFORT_ANTHROPIC || '',
        SUMMARY_MODEL_ANTHROPIC: process.env.SUMMARY_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
        LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || '',
        MEMORY_TABLE_NAME: table.tableName,
        MAX_RECENT_TURNS: process.env.MAX_RECENT_TURNS || '5',
        CONVERSATION_TTL_DAYS: process.env.CONVERSATION_TTL_DAYS || '90',
        SESSION_IDLE_HOURS: process.env.SESSION_IDLE_HOURS || '2',
        RICH_MENU_ID: process.env.RICH_MENU_ID || '',
        VOICE_BUCKET_NAME: voiceBucket.bucketName,
        VOICE_MINUTES_PER_MONTH: process.env.VOICE_MINUTES_PER_MONTH || '30',
      },
    })

    table.grantReadWriteData(fn)
    // Transcribe reads the recording and writes the transcript with the
    // caller's own permissions, so the function needs both on the bucket.
    voiceBucket.grantReadWrite(fn)
    // IAM cannot narrow StartTranscriptionJob to a job name; the other two
    // stay limited to the jobs this function names.
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['transcribe:StartTranscriptionJob'], resources: ['*'] }))
    // Read before every recording: voice pauses unless this account is opted
    // out of AI service improvement for Transcribe.
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['organizations:DescribeEffectivePolicy'], resources: ['*'] }))
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['transcribe:GetTranscriptionJob', 'transcribe:DeleteTranscriptionJob'],
        resources: [`arn:aws:transcribe:${this.region}:${this.account}:transcription-job/animitta-*`],
      })
    )

    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: fnUrl.url,
      description: 'LINE Webhook URL — paste this into LINE Developers Console',
    })

    const alertEmail = process.env.ALERT_EMAIL
    if (!alertEmail) throw new Error('ALERT_EMAIL is required in .env')
    const alertTopic = new sns.Topic(this, 'AlertTopic', { displayName: '無相界' })
    alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail))

    this.addFailureAlarm(fn, alertTopic)
    this.addKeyExpiryReminders(alertTopic, process.env.ANTHROPIC_KEY_EXPIRES_ON)
  }

  // index.mjs catches errors and returns 200, so Lambda's own Errors metric
  // only sees timeouts and crashes. Caught failures are counted from the log line.
  private addFailureAlarm(fn: lambda.Function, topic: sns.ITopic) {
    const caughtFailures = new logs.MetricFilter(this, 'HandlerErrorFilter', {
      logGroup: logs.LogGroup.fromLogGroupName(this, 'HandlerLogs', `/aws/lambda/${fn.functionName}`),
      filterPattern: logs.FilterPattern.anyTerm('Handler error'),
      metricNamespace: 'Animitta',
      metricName: 'HandlerErrors',
      metricValue: '1',
    }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) })

    const failures = new cloudwatch.MathExpression({
      expression: 'FILL(caught, 0) + FILL(uncaught, 0)',
      usingMetrics: {
        caught: caughtFailures,
        uncaught: fn.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
      },
      label: 'Failed LINE events',
      period: cdk.Duration.minutes(5),
    })

    new cloudwatch.Alarm(this, 'HandlerFailureAlarm', {
      alarmName: 'animitta-handler-failures',
      alarmDescription:
        '無相界有訊息沒處理完：可能沒回成功，也可能回了但記憶沒存好（AI 呼叫失敗、逾時或程式錯誤），或語音因為這個 AWS 帳號沒有 AI 服務 opt-out 而暫停（log 會寫 "voice paused"）。到 CloudWatch Logs /aws/lambda/animitta 搜尋 "Handler error" 或 "Task timed out" 看原因。',
      metric: failures,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic))
  }

  private addKeyExpiryReminders(topic: sns.ITopic, expiresOn: string | undefined) {
    if (!expiresOn) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
      throw new Error(`ANTHROPIC_KEY_EXPIRES_ON must be YYYY-MM-DD, got "${expiresOn}"`)
    }
    const expiryDay = new Date(`${expiresOn}T00:00:00Z`)

    for (const daysBefore of KEY_REMINDER_DAYS_BEFORE) {
      // 02:00 UTC is 10:00 in Taipei; ScheduleExpression.at formats the date in UTC.
      const remindAt = new Date(expiryDay.getTime() - daysBefore * 86_400_000 + 2 * 3_600_000)
      if (remindAt.getTime() <= Date.now()) continue

      new scheduler.Schedule(this, `KeyExpiryReminder${daysBefore}d`, {
        description: `Anthropic API key expires ${expiresOn}; reminder ${daysBefore} day(s) before`,
        schedule: scheduler.ScheduleExpression.at(remindAt),
        target: new schedulerTargets.SnsPublish(topic, {
          input: scheduler.ScheduleTargetInput.fromText(
            `無相界的 Anthropic API key 會在 ${expiresOn} 到期，剩 ${daysBefore} 天。到期後 bot 就沒辦法回覆打字訊息。\n\n` +
              '換 key 的步驟：\n' +
              '1. 到 Anthropic Console 產生新的 key\n' +
              '2. 在 ~/workspace/vibe-coding/animitta/.env 更新 ANTHROPIC_API_KEY 和 ANTHROPIC_KEY_EXPIRES_ON\n' +
              '3. 在同一個資料夾執行 npx cdk deploy\n\n' +
              '要改 .env 再部署,不要只改 Lambda Console，不然下次部署會把舊的 key 蓋回去。',
          ),
        }),
      })
    }
  }
}
