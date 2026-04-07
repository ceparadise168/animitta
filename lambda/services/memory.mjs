import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb'

const client = new DynamoDBClient()
const TABLE = process.env.MEMORY_TABLE_NAME
const MAX_TURNS = parseInt(process.env.MAX_RECENT_TURNS || '5', 10)
const TTL_DAYS = parseInt(process.env.CONVERSATION_TTL_DAYS || '30', 10)

function ttl() {
  return Math.floor(Date.now() / 1000) + TTL_DAYS * 86400
}

export async function getContext(userId) {
  const pk = `USER#${userId}`

  const [turnsRes, summaryRes] = await Promise.all([
    client.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': { S: pk },
          ':prefix': { S: 'TURN#' },
        },
        ScanIndexForward: false,
        Limit: MAX_TURNS * 2,
      })
    ),
    client.send(
      new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: pk }, sk: { S: 'SUMMARY' } },
      })
    ),
  ])

  // ScanIndexForward:false returns newest first; reverse to chronological
  const recentTurns = (turnsRes.Items || [])
    .reverse()
    .map((item) => ({
      role: item.role.S,
      content: item.content.S,
    }))

  const summary = summaryRes.Item ? summaryRes.Item.content.S : null

  return { summary, recentTurns }
}

export async function saveTurn(userId, userText, assistantText) {
  const pk = `USER#${userId}`
  const ts = new Date().toISOString()
  const expiry = { N: String(ttl()) }

  await Promise.all([
    client.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: pk },
          sk: { S: `TURN#${ts}#user` },
          role: { S: 'user' },
          content: { S: userText },
          ttl: expiry,
        },
      })
    ),
    client.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: pk },
          sk: { S: `TURN#${ts}#asst` },
          role: { S: 'assistant' },
          content: { S: assistantText },
          ttl: expiry,
        },
      })
    ),
  ])
}

export async function compressOldTurns(userId, provider) {
  const pk = `USER#${userId}`

  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: pk },
        ':prefix': { S: 'TURN#' },
      },
      ScanIndexForward: true,
    })
  )

  const allItems = res.Items || []
  const keepCount = MAX_TURNS * 2
  if (allItems.length <= keepCount) return

  const oldItems = allItems.slice(0, allItems.length - keepCount)
  const oldTurns = oldItems.map((item) => ({
    role: item.role.S,
    content: item.content.S,
  }))

  const summaryRes = await client.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: pk }, sk: { S: 'SUMMARY' } },
    })
  )
  const existingSummary = summaryRes.Item ? summaryRes.Item.content.S : null

  const newSummary = await provider.summarize(existingSummary, oldTurns)

  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: pk },
        sk: { S: 'SUMMARY' },
        content: { S: newSummary },
        updatedAt: { S: new Date().toISOString() },
      },
    })
  )

  for (let i = 0; i < oldItems.length; i += 25) {
    const batch = oldItems.slice(i, i + 25)
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE]: batch.map((item) => ({
            DeleteRequest: {
              Key: { pk: { S: pk }, sk: item.sk },
            },
          })),
        },
      })
    )
  }
}

/**
 * Delete all turns and summary for a user.
 */
export async function clearMemory(userId) {
  const pk = `USER#${userId}`

  // Get all items for this user
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: pk } },
    })
  )

  const items = res.Items || []
  if (items.length === 0) return

  // Delete in batches of 25
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25)
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE]: batch.map((item) => ({
            DeleteRequest: {
              Key: { pk: item.pk, sk: item.sk },
            },
          })),
        },
      })
    )
  }
}

/**
 * Store user feedback.
 */
export async function saveFeedback(userId, rating, detail = null) {
  const item = {
    pk: { S: `FEEDBACK#${userId}` },
    sk: { S: new Date().toISOString() },
    rating: { S: rating },
    ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 86400) },
  }
  if (detail) item.detail = { S: detail }
  await client.send(new PutItemCommand({ TableName: TABLE, Item: item }))
}

/**
 * Set a short-lived flag indicating we're waiting for feedback text.
 * TTL: 5 minutes (if user doesn't reply, flag auto-expires).
 */
export async function setPendingFeedback(userId) {
  await client.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: `PENDING_FB#${userId}` },
        sk: { S: 'FLAG' },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 300) },
      },
    })
  )
}

export async function getPendingFeedback(userId) {
  const res = await client.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `PENDING_FB#${userId}` }, sk: { S: 'FLAG' } },
    })
  )
  return res.Item ? true : false
}

export async function deletePendingFeedback(userId) {
  await client.send(
    new DeleteItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `PENDING_FB#${userId}` }, sk: { S: 'FLAG' } },
    })
  )
}
