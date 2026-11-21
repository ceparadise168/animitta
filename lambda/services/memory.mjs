import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  BatchWriteItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'

const client = new DynamoDBClient()
const TABLE = process.env.MEMORY_TABLE_NAME
const MAX_TURNS = parseInt(process.env.MAX_RECENT_TURNS || '5', 10)
const SESSION_IDLE_HOURS = parseFloat(process.env.SESSION_IDLE_HOURS || '2')

// How long the bot keeps what it remembers. A turn expires this many days
// after it was said; the summary this many days after the user's last message.
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
const keyOf = (item) => ({ pk: item.pk, sk: item.sk })

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
      ConsistentRead: true,
      ...(limit && { Limit: limit }),
    })
  )
  return inConversationOrder((res.Items || []).filter(isLive))
}

async function readSummaryItem(pk) {
  const res = await client.send(
    new GetItemCommand({ TableName: TABLE, Key: summaryKey(pk), ConsistentRead: true })
  )
  return res.Item ?? null
}
const liveContent = (summaryItem) => (summaryItem && isLive(summaryItem) ? summaryItem.content.S : null)

export async function getContext(userId) {
  const pk = `USER#${userId}`
  const [items, summaryItem] = await Promise.all([
    liveTurns(pk, { newestFirst: true, limit: MAX_TURNS * 2 }),
    readSummaryItem(pk),
  ])
  const turns = items.map(toMessage)
  const summary = liveContent(summaryItem)

  // After SESSION_IDLE_HOURS of silence a new session starts. The turns from
  // before the gap are not folded into the summary until after this reply, so
  // they travel along as the previous session instead of being dropped.
  const lastAt = items.length ? Date.parse(turnTime(items.at(-1))) : null
  const idleMs = lastAt === null ? 0 : Date.now() - lastAt
  if (idleMs > SESSION_IDLE_HOURS * 3600 * 1000) {
    return { summary, recentTurns: [], previousSession: { turns, idleMs, keys: items.map(keyOf) } }
  }
  return { summary, recentTurns: turns, previousSession: null }
}

// The timestamp is the turn's identity in its sort key, so two exchanges saved
// in the same millisecond (two canned replies in one webhook) must not share it.
let lastSavedAt = 0
function nextTurnTime() {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1)
  return new Date(lastSavedAt).toISOString()
}

export async function saveTurn(userId, userText, assistantText) {
  const pk = `USER#${userId}`
  const ts = nextTurnTime()
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
        ConditionExpression: 'attribute_exists(pk) AND #ttl > :now',
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

// TransactWriteItems takes at most 100 actions, and one of them is the summary.
const MAX_FOLDED_ITEMS = 98

// Folds exactly the turns that were read into the summary, in one transaction:
// the new summary is written and those turns deleted only if all of them still
// exist and nobody rewrote or cleared the summary while the model was writing
// it. Otherwise a 清除記憶 that landed mid-fold would be undone.
async function foldIntoSummary(pk, { turns, keys }, provider) {
  const before = await readSummaryItem(pk)
  const summary = await provider.summarize(liveContent(before), turns)
  try {
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                ...summaryKey(pk),
                content: { S: summary },
                updatedAt: { S: new Date().toISOString() },
                ttl: expiresAfter(RETENTION_DAYS.summary),
              },
              ...(before
                ? { ConditionExpression: 'updatedAt = :seen', ExpressionAttributeValues: { ':seen': before.updatedAt } }
                : { ConditionExpression: 'attribute_not_exists(pk)' }),
            },
          },
          ...keys.map((Key) => ({
            Delete: { TableName: TABLE, Key, ConditionExpression: 'attribute_exists(sk)' },
          })),
        ],
      })
    )
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err
    console.warn('Memory fold skipped: the memory changed while it was being summarized')
  }
}

/**
 * Fold the oldest turns beyond MAX_RECENT_TURNS into the rolling summary.
 */
export async function compressOldTurns(userId, provider) {
  const pk = `USER#${userId}`
  const items = await liveTurns(pk)
  const overflowCount = Math.min(Math.max(items.length - MAX_TURNS * 2, 0), MAX_FOLDED_ITEMS)
  const overflow = items.slice(0, overflowCount)
  if (overflow.length > 0) {
    await foldIntoSummary(pk, { turns: overflow.map(toMessage), keys: overflow.map(keyOf) }, provider)
  }
}

/**
 * Fold the previous session, exactly as getContext read it, into the rolling
 * summary, so the next session starts fresh while keeping long-term context.
 */
export async function archiveSession(userId, previousSession, provider) {
  await foldIntoSummary(`USER#${userId}`, previousSession, provider)
}

/**
 * Delete all turns and summary for a user. The summary key is always included,
 * so a fold that commits between the query and the delete is removed too.
 */
export async function clearMemory(userId) {
  const pk = `USER#${userId}`
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: pk } },
      ConsistentRead: true,
    })
  )
  const turns = (res.Items || []).filter((item) => item.sk.S !== 'SUMMARY')
  await deleteKeys([...turns.map(keyOf), summaryKey(pk)])
}

async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
        },
      })
    )
  }
}
