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

// Everything the bot remembers about someone is gone this many days after
// their last message: each turn expires this long after it was said, and the
// summary this long after the latest exchange. One number, so the promise the
// 關於 message quotes to users cannot drift between the two.
export const RETENTION_DAYS = parseInt(process.env.CONVERSATION_TTL_DAYS || '90', 10)

const nowSeconds = () => Math.floor(Date.now() / 1000)
const expiresAfter = (days) => ({ N: String(nowSeconds() + days * 86400) })
// DynamoDB removes expired items in the background, sometimes days late, so
// reads skip them too. Otherwise the retention promise would not hold.
const isLive = (item) => !item.ttl || Number(item.ttl.N) > nowSeconds()

const itemKey = (pk, sk) => ({ pk: { S: pk }, sk: { S: sk } })
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

async function readItem(pk, sk) {
  const res = await client.send(new GetItemCommand({ TableName: TABLE, Key: itemKey(pk, sk), ConsistentRead: true }))
  return res.Item
}
const liveContent = (summaryItem) => (summaryItem && isLive(summaryItem) ? summaryItem.content.S : null)

export async function getContext(userId) {
  const pk = `USER#${userId}`
  const [items, summaryItem] = await Promise.all([
    liveTurns(pk, { newestFirst: true, limit: MAX_TURNS * 2 }),
    readItem(pk, 'SUMMARY'),
  ])
  const turns = items.map(toMessage)
  const summary = liveContent(summaryItem)

  // After SESSION_IDLE_HOURS of silence a new session starts. The turns from
  // before the gap are not folded into the summary until after this reply, so
  // they travel along as the previous session instead of being dropped.
  const lastAt = items.length ? Date.parse(turnTime(items.at(-1))) : null
  const idleMs = lastAt === null ? 0 : Date.now() - lastAt
  if (idleMs > SESSION_IDLE_HOURS * 3600 * 1000) {
    return { summary, recentTurns: [], previousSession: { turns, idleMs, endsAt: turnTime(items.at(-1)) } }
  }
  return { summary, recentTurns: turns, previousSession: null }
}

// A turn's timestamp is its identity in the sort key, so two exchanges saved
// in the same millisecond (two canned replies in one webhook) must not share it.
let lastTick = 0
function nextTurnTime() {
  lastTick = Math.max(Date.now(), lastTick + 1)
  return new Date(lastTick).toISOString()
}

/**
 * Save one exchange. sentAt is when the user sent the message, as LINE
 * stamped it: if they confirmed 清除記憶 after that, the exchange is taken back
 * out and this returns false.
 */
export async function saveTurn(userId, userText, assistantText, sentAt) {
  const pk = `USER#${userId}`
  const ts = nextTurnTime()
  const expiry = expiresAfter(RETENTION_DAYS)
  const turnItem = (suffix, role, content) => ({
    ...itemKey(pk, `TURN#${ts}#${suffix}`),
    role: { S: role },
    content: { S: content },
    ttl: expiry,
  })
  const items = [turnItem('user', 'user', userText), turnItem('asst', 'assistant', assistantText)]

  await Promise.all([
    ...items.map((Item) => client.send(new PutItemCommand({ TableName: TABLE, Item }))),
    keepSummaryAlive(pk),
  ])

  // clearMemory writes its marker before it reads what to delete, so either
  // the clear's delete sees these items or this read sees the marker.
  const cleared = await readItem(pk, 'CLEARED')
  if (cleared && Number(cleared.clearedAt.N) > sentAt) {
    await deleteKeys(items.map(keyOf))
    return false
  }
  return true
}

// The summary is forgotten RETENTION_DAYS after the last message, not after
// it was last rewritten, so every exchange pushes its expiry out. An expired
// summary that DynamoDB has not removed yet must stay expired. A fold in flight
// conflicts with this update, and writes a fresh expiry itself.
async function keepSummaryAlive(pk) {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: itemKey(pk, 'SUMMARY'),
        UpdateExpression: 'SET #ttl = :ttl',
        ConditionExpression: 'attribute_exists(pk) AND #ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':ttl': expiresAfter(RETENTION_DAYS),
          ':now': { N: String(nowSeconds()) },
        },
      })
    )
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException' && err.name !== 'TransactionConflictException') throw err
  }
}

// TransactWriteItems takes at most 100 actions, and one of them is the summary.
const MAX_FOLDED_ITEMS = 98

// Folds the given turns into the summary in one transaction: the new summary
// is written and those turns deleted only if all of them still exist and
// nobody rewrote or cleared the summary while the model was writing it.
// Otherwise a 清除記憶 that landed mid-fold would be undone.
async function foldIntoSummary(pk, items, provider) {
  const before = await readItem(pk, 'SUMMARY')
  const summary = await provider.summarize(liveContent(before), items.map(toMessage))
  try {
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                ...itemKey(pk, 'SUMMARY'),
                content: { S: summary },
                updatedAt: { S: new Date().toISOString() },
                ttl: expiresAfter(RETENTION_DAYS),
              },
              ...(before
                ? { ConditionExpression: 'updatedAt = :seen', ExpressionAttributeValues: { ':seen': before.updatedAt } }
                : { ConditionExpression: 'attribute_not_exists(pk)' }),
            },
          },
          ...items.map((item) => ({
            Delete: { TableName: TABLE, Key: keyOf(item), ConditionExpression: 'attribute_exists(sk)' },
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
  const overflowCount = Math.min(items.length - MAX_TURNS * 2, MAX_FOLDED_ITEMS)
  if (overflowCount > 0) await foldIntoSummary(pk, items.slice(0, overflowCount), provider)
}

/**
 * Fold every turn of the previous session into the rolling summary, so the
 * next session starts fresh while keeping long-term context. getContext only
 * showed its newest turns; a backlog left by a failed fold goes along too.
 */
export async function archiveSession(userId, previousSession, provider) {
  const pk = `USER#${userId}`
  const items = (await liveTurns(pk)).filter((item) => turnTime(item) <= previousSession.endsAt)
  if (items.length > 0) await foldIntoSummary(pk, items.slice(0, MAX_FOLDED_ITEMS), provider)
}

// Long enough to outlast any exchange that was in flight when the user cleared.
const CLEARED_MARKER_DAYS = 1

/**
 * Delete all turns and the summary for a user. clearedAt is when the user
 * confirmed, as LINE stamped it, so "said before the clear" follows the order
 * the user acted in, on one clock, even when LINE redelivers a message late.
 * The marker goes first, so an exchange still being answered is taken back out
 * by saveTurn. The summary key is always deleted, so a fold that commits
 * during the clear is removed too.
 */
export async function clearMemory(userId, clearedAt) {
  const pk = `USER#${userId}`
  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: { ...itemKey(pk, 'CLEARED'), clearedAt: { N: String(clearedAt) }, ttl: expiresAfter(CLEARED_MARKER_DAYS) },
    })
  )
  const turns = []
  let startKey
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: 'TURN#' } },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      })
    )
    turns.push(...(page.Items || []))
    startKey = page.LastEvaluatedKey
  } while (startKey)
  await deleteKeys([...turns.map(keyOf), itemKey(pk, 'SUMMARY')])
}

// BatchWriteItem may hand back deletes it did not do (throttling, internal
// errors). They are retried, and if they never go through this throws, so the
// user is not told their memory was cleared when it was not.
async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }))
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt === 4) throw new Error(`DynamoDB left ${requests.length} delete(s) unprocessed`)
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
      const res = await client.send(new BatchWriteItemCommand({ RequestItems: { [TABLE]: requests } }))
      requests = res.UnprocessedItems?.[TABLE] ?? []
    }
  }
}
