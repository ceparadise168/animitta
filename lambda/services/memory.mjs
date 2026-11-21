import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb'

const client = new DynamoDBClient()
const TABLE = process.env.MEMORY_TABLE_NAME
const MAX_TURNS = parseInt(process.env.MAX_RECENT_TURNS || '5', 10)
const SESSION_IDLE_HOURS = parseFloat(process.env.SESSION_IDLE_HOURS || '2')

// How long the bot keeps what it remembers, counted from the last message.
// The 關於 message quotes these numbers to users.
export const RETENTION_DAYS = {
  turns: parseInt(process.env.CONVERSATION_TTL_DAYS || '30', 10),
  summary: parseInt(process.env.SUMMARY_TTL_DAYS || '90', 10),
}

const nowSeconds = () => Math.floor(Date.now() / 1000)
const expiresAfter = (days) => ({ N: String(nowSeconds() + days * 86400) })
// DynamoDB removes expired items in the background, sometimes days late, so
// reads skip them too. Otherwise the retention promise would not hold.
const isLive = (item) => !item.ttl || Number(item.ttl.N) > nowSeconds()

const summaryKey = (pk) => ({ pk: { S: pk }, sk: { S: 'SUMMARY' } })

// Both items of a turn share one timestamp in their sort key (TURN#<iso>#user,
// TURN#<iso>#asst) and "asst" sorts before "user", so key order is not the
// order the conversation happened in.
const ROLE_ORDER = { user: 0, assistant: 1 }
const turnTime = (item) => item.sk.S.split('#')[1]
function inConversationOrder(items) {
  return items
    .slice()
    .sort((a, b) => turnTime(a).localeCompare(turnTime(b)) || ROLE_ORDER[a.role.S] - ROLE_ORDER[b.role.S])
}

const toMessage = (item) => ({ role: item.role.S, content: item.content.S })

async function liveTurns(pk, { newestFirst = false, limit } = {}) {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: pk },
        ':prefix': { S: 'TURN#' },
      },
      ScanIndexForward: !newestFirst,
      ...(limit && { Limit: limit }),
    })
  )
  return inConversationOrder((res.Items || []).filter(isLive))
}

async function liveSummary(pk) {
  const res = await client.send(new GetItemCommand({ TableName: TABLE, Key: summaryKey(pk) }))
  return res.Item && isLive(res.Item) ? res.Item.content.S : null
}

export async function getContext(userId) {
  const pk = `USER#${userId}`
  const [items, summary] = await Promise.all([
    liveTurns(pk, { newestFirst: true, limit: MAX_TURNS * 2 }),
    liveSummary(pk),
  ])
  const turns = items.map(toMessage)

  // After SESSION_IDLE_HOURS of silence a new session starts. The turns from
  // before the gap are not folded into the summary until after this reply, so
  // they travel along as the previous session instead of being dropped.
  const lastAt = items.length ? Date.parse(turnTime(items.at(-1))) : null
  const idleMs = lastAt === null ? 0 : Date.now() - lastAt
  if (idleMs > SESSION_IDLE_HOURS * 3600 * 1000) {
    return { summary, recentTurns: [], previousSession: { turns, idleMs } }
  }
  return { summary, recentTurns: turns, previousSession: null }
}

export async function saveTurn(userId, userText, assistantText) {
  const pk = `USER#${userId}`
  const ts = new Date().toISOString()
  const expiry = expiresAfter(RETENTION_DAYS.turns)
  const turnItem = (suffix, role, content) => ({
    pk: { S: pk },
    sk: { S: `TURN#${ts}#${suffix}` },
    role: { S: role },
    content: { S: content },
    ttl: expiry,
  })

  await Promise.all([
    client.send(new PutItemCommand({ TableName: TABLE, Item: turnItem('user', 'user', userText) })),
    client.send(new PutItemCommand({ TableName: TABLE, Item: turnItem('asst', 'assistant', assistantText) })),
    keepSummaryAlive(pk),
  ])
}

// The summary is forgotten SUMMARY_TTL_DAYS after the last message, not after
// it was last rewritten, so every exchange pushes its expiry out. An expired
// summary that DynamoDB has not removed yet must stay expired.
async function keepSummaryAlive(pk) {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: summaryKey(pk),
        UpdateExpression: 'SET #ttl = :ttl',
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(#ttl) OR #ttl > :now)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':ttl': expiresAfter(RETENTION_DAYS.summary),
          ':now': { N: String(nowSeconds()) },
        },
      })
    )
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err
  }
}

async function foldIntoSummary(pk, items, provider) {
  const summary = await provider.summarize(await liveSummary(pk), items.map(toMessage))
  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: {
        ...summaryKey(pk),
        content: { S: summary },
        updatedAt: { S: new Date().toISOString() },
        ttl: expiresAfter(RETENTION_DAYS.summary),
      },
    })
  )
  await deleteItems(items)
}

async function deleteItems(items) {
  for (let i = 0; i < items.length; i += 25) {
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE]: items.slice(i, i + 25).map((item) => ({
            DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
          })),
        },
      })
    )
  }
}

/**
 * Fold the oldest turns beyond MAX_RECENT_TURNS into the rolling summary.
 */
export async function compressOldTurns(userId, provider) {
  const pk = `USER#${userId}`
  const items = await liveTurns(pk)
  const overflow = items.length - MAX_TURNS * 2
  if (overflow > 0) await foldIntoSummary(pk, items.slice(0, overflow), provider)
}

/**
 * Fold every remaining turn into the rolling summary at a session boundary,
 * so the next session starts fresh while keeping long-term context.
 */
export async function archiveSession(userId, provider) {
  const pk = `USER#${userId}`
  const items = await liveTurns(pk)
  if (items.length > 0) await foldIntoSummary(pk, items, provider)
}

/**
 * Delete all turns and summary for a user.
 */
export async function clearMemory(userId) {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: `USER#${userId}` } },
    })
  )
  await deleteItems(res.Items || [])
}
