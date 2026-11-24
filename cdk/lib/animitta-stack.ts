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
// Everyone's voice minutes together each month, so a crowd cannot run up the
// Transcribe bill (about US$0.006 a minute). voice.mjs enforces it.
const VOICE_MINUTES_ALL_USERS = process.env.VOICE_MINUTES_ALL_USERS_PER_MONTH || '1500'
// The same Claude model on Amazon Bedrock, run only in Japan's regions (Tokyo,
// Osaka), answers when the Anthropic account cannot. Empty turns the backup off.
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'jp.anthropic.claude-haiku-4-5-20251001-v1:0'
const BEDROCK_MODEL_REGIONS = ['ap-northeast-1', 'ap-northeast-3']
const CHAT_MODEL_ANTHROPIC = process.env.CHAT_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001'
// 關於 tells people the backup runs the same model, so it has to be true.
if (BEDROCK_MODEL_ID && !BEDROCK_MODEL_ID.includes(CHAT_MODEL_ANTHROPIC)) {
  throw new Error(`BEDROCK_MODEL_ID ${BEDROCK_MODEL_ID} is not the chat model ${CHAT_MODEL_ANTHROPIC}`)
}
// It also says Japan, and the permission below covers only Japan's regions.
if (BEDROCK_MODEL_ID && !BEDROCK_MODEL_ID.startsWith('jp.')) {
  throw new Error(`BEDROCK_MODEL_ID ${BEDROCK_MODEL_ID} is not a jp. profile`)
}
const CONVERSATION_TTL_DAYS = Number(process.env.CONVERSATION_TTL_DAYS || '30')
if (!Number.isInteger(CONVERSATION_TTL_DAYS) || CONVERSATION_TTL_DAYS < 1) {
  throw new Error(`CONVERSATION_TTL_DAYS must be a whole number of days, got ${process.env.CONVERSATION_TTL_DAYS}`)
}

// CloudWatch keeps logs only for a fixed set of day counts: the longest that
// still ends within the given days.
function logRetentionWithin(days: number): logs.RetentionDays {
  const offered = Object.values(logs.RetentionDays).filter(
    (d): d is logs.RetentionDays => typeof d === 'number' && d !== logs.RetentionDays.INFINITE
  )
  const within = offered.filter((d) => d <= days)
  if (within.length === 0) throw new Error(`No CloudWatch log retention ends within ${days} days`)
  return Math.max(...within)
}

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
        CHAT_MODEL_ANTHROPIC,
        BEDROCK_MODEL_ID,
        CHAT_EFFORT_ANTHROPIC: process.env.CHAT_EFFORT_ANTHROPIC || '',
        SUMMARY_MODEL_ANTHROPIC: process.env.SUMMARY_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001',
        LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
        LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || '',
        MEMORY_TABLE_NAME: table.tableName,
        MAX_RECENT_TURNS: process.env.MAX_RECENT_TURNS || '5',
        CONVERSATION_TTL_DAYS: String(CONVERSATION_TTL_DAYS),
        SESSION_IDLE_HOURS: process.env.SESSION_IDLE_HOURS || '2',
        RICH_MENU_ID: process.env.RICH_MENU_ID || '',
        VOICE_BUCKET_NAME: voiceBucket.bucketName,
        VOICE_MINUTES_PER_MONTH: process.env.VOICE_MINUTES_PER_MONTH || '30',
        VOICE_MINUTES_ALL_USERS_PER_MONTH: VOICE_MINUTES_ALL_USERS,
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

    if (BEDROCK_MODEL_ID) {
      const profileArn = `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`
      const model = BEDROCK_MODEL_ID.replace(/^[a-z]+\./, '')
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [profileArn] }))
      // The model itself only through that profile, which keeps it in Japan.
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: BEDROCK_MODEL_REGIONS.map((region) => `arn:aws:bedrock:${region}::foundation-model/${model}`),
          conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArn } },
        })
      )
    }

    new logs.LogRetention(this, 'HandlerLogRetention', {
      logGroupName: `/aws/lambda/${fn.functionName}`,
      retention: logRetentionWithin(CONVERSATION_TTL_DAYS),
    })

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
    this.addVoiceLimitAlarm(fn, alertTopic)
    if (BEDROCK_MODEL_ID) this.addBackupAlarm(fn, alertTopic)
    this.addKeyExpiryReminders(alertTopic, process.env.ANTHROPIC_KEY_EXPIRES_ON)
    this.addAlertTriage(fn, table, alertTopic, alertEmail)
    this.addDeployRole(fn, alertTopic)
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

  // voice.mjs logs "Voice limit for all users reached" each time it turns a
  // voice message away because everyone's minutes for the month are used up.
  // Hourly, so a busy month sends a few emails rather than one per message.
  private addVoiceLimitAlarm(fn: lambda.Function, topic: sns.ITopic) {
    const turnedAway = new logs.MetricFilter(this, 'VoiceLimitFilter', {
      logGroup: logs.LogGroup.fromLogGroupName(this, 'VoiceLimitLogs', `/aws/lambda/${fn.functionName}`),
      filterPattern: logs.FilterPattern.anyTerm('Voice limit for all users reached'),
      metricNamespace: 'Animitta',
      metricName: 'VoiceLimitForAllUsersReached',
      metricValue: '1',
    }).metric({ statistic: 'Sum', period: cdk.Duration.hours(1) })

    new cloudwatch.Alarm(this, 'VoiceLimitAlarm', {
      alarmName: 'animitta-voice-limit-reached',
      alarmDescription:
        `無相界這個月全體使用者的語音分鐘數（${VOICE_MINUTES_ALL_USERS} 分鐘）用完了：語音會暫停到下個月 1 號（台北時間），打字聊天照常。` +
        '要提高上限，改 VOICE_MINUTES_ALL_USERS_PER_MONTH 再部署。',
      metric: turnedAway,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic))
  }

  // The backup answering hides Anthropic being down from the failure alarm, so
  // a key or billing problem could last for weeks unseen. This one says so.
  private addBackupAlarm(fn: lambda.Function, topic: sns.ITopic) {
    const answeredByBackup = new logs.MetricFilter(this, 'BackupFilter', {
      logGroup: logs.LogGroup.fromLogGroupName(this, 'BackupLogs', `/aws/lambda/${fn.functionName}`),
      filterPattern: logs.FilterPattern.anyTerm('Provider fallback'),
      metricNamespace: 'Animitta',
      metricName: 'AnsweredByBackup',
      metricValue: '1',
    }).metric({ statistic: 'Sum', period: cdk.Duration.hours(1) })

    new cloudwatch.Alarm(this, 'BackupAlarm', {
      alarmName: 'animitta-answered-by-backup',
      alarmDescription:
        '不急：Anthropic 出了問題，這一小時內有訊息改由 Amazon Bedrock 上的同一個 Claude 回覆，使用者照常收到回覆。' +
        '到 CloudWatch Logs /aws/lambda/animitta 搜尋 "Provider fallback"，那一行寫著 Anthropic 回的狀態碼：401 是金鑰失效，400 多半是儲值用完，529 或 5xx 是 Anthropic 塞車。',
      metric: answeredByBackup,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic))
  }

  // On each alarm: name the cause in an email, and wake the Claude routine when
  // the cause may need a code change. The email has a topic of its own, since
  // this function listens to the alert topic.
  private addAlertTriage(bot: lambda.Function, table: dynamodb.ITable, alertTopic: sns.ITopic, email: string) {
    const triageTopic = new sns.Topic(this, 'TriageTopic', { displayName: '無相界警報說明' })
    triageTopic.addSubscription(new subscriptions.EmailSubscription(email))
    const param = (name: string) => `arn:aws:ssm:${this.region}:${this.account}:parameter/animitta/${name}`

    const triage = new lambda.Function(this, 'AlertTriage', {
      functionName: 'animitta-alert-triage',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../ops/alert-triage')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      retryAttempts: 0,
      environment: {
        TABLE: table.tableName,
        BOT_LOG_GROUP: `/aws/lambda/${bot.functionName}`,
        TRIAGE_TOPIC_ARN: triageTopic.topicArn,
        ROUTINE_URL_PARAM: '/animitta/alert-routine/url',
        ROUTINE_TOKEN_PARAM: '/animitta/alert-routine/token',
        DEPLOYED_PARAM: '/animitta/deployed',
      },
    })
    new logs.LogRetention(this, 'AlertTriageLogRetention', {
      logGroupName: `/aws/lambda/${triage.functionName}`,
      retention: logRetentionWithin(CONVERSATION_TTL_DAYS),
    })
    alertTopic.addSubscription(new subscriptions.LambdaSubscription(triage))
    triageTopic.grantPublish(triage)
    triage.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${bot.functionName}:*`],
      })
    )
    triage.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [param('alert-routine/url'), param('alert-routine/token'), param('deployed')],
      })
    )
    triage.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      })
    )
    // Only its own rows: the same table holds everyone's conversations.
    triage.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['OPS#ALERT'] } },
      })
    )
  }

  // GitHub Actions deploys lambda/ once Eric approves the production
  // environment. The role trusts only jobs in that environment, so changing the
  // workflow cannot skip his approval. Replacing the code means running as the
  // bot, with its data and keys, which is why that approval is the gate.
  private addDeployRole(bot: lambda.Function, alertTopic: sns.ITopic) {
    const github = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidc',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`
    )
    const role = new iam.Role(this, 'GitHubDeployRole', {
      roleName: 'animitta-github-deploy',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(github.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': 'repo:ceparadise168/animitta:environment:production',
        },
      }),
    })
    // GetFunctionConfiguration is for the wait after an update; its answer, like
    // UpdateFunctionCode's, carries the bot's keys, so the workflow prints neither.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunctionConfiguration', 'lambda:InvokeFunction'],
        resources: [bot.functionArn],
      })
    )
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/animitta/deployed`],
      })
    )
    alertTopic.grantPublish(role)
    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', { value: role.roleArn })
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: alertTopic.topicArn })
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
              '3. 在同一個資料夾執行 npm run deploy\n\n' +
              '要改 .env 再部署,不要只改 Lambda Console，不然下次部署會把舊的 key 蓋回去。',
          ),
        }),
      })
    }
  }
}
