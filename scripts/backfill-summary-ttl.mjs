// One-off: summaries written before SUMMARY_TTL_DAYS existed have no expiry.
// Give each one SUMMARY_TTL_DAYS after its last update, and delete the ones
// already past that. Summaries that already expire are left alone, so a rerun
// does nothing. Prints hashed user ids only, never summary text.
//
// Run:  node scripts/backfill-summary-ttl.mjs            (dry run)
//       node scripts/backfill-summary-ttl.mjs --apply
import 'dotenv/config'
import { createHash } from 'node:crypto'
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb'

const TABLE = process.env.MEMORY_TABLE_NAME || 'animitta-conversations'
const SUMMARY_TTL_DAYS = parseInt(process.env.SUMMARY_TTL_DAYS || '90', 10)
const apply = process.argv.includes('--apply')
const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' })

const nowSeconds = Math.floor(Date.now() / 1000)
const hashed = (pk) => createHash('sha256').update(pk).digest('hex').slice(0, 8)
// Skip a summary that was rewritten after the scan, by either code version.
const unchangedSinceScan = {
  ConditionExpression: 'attribute_not_exists(#ttl) AND updatedAt = :scanned',
  ExpressionAttributeNames: { '#ttl': 'ttl' },
}

const summaries = []
let startKey
do {
  const page = await client.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'sk = :summary AND attribute_not_exists(#ttl)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':summary': { S: 'SUMMARY' } },
      ProjectionExpression: 'pk, sk, updatedAt',
      ExclusiveStartKey: startKey,
    })
  )
  summaries.push(...(page.Items || []))
  startKey = page.LastEvaluatedKey
} while (startKey)

console.log(`${summaries.length} summary(ies) without an expiry in ${TABLE}${apply ? '' : ' (dry run)'}`)
for (const item of summaries) {
  const key = { pk: item.pk, sk: item.sk }
  const updatedAt = item.updatedAt?.S
  if (!updatedAt) {
    console.log(`  user ${hashed(item.pk.S)}: no updatedAt, left alone`)
    continue
  }
  const expiresAt = Math.floor(Date.parse(updatedAt) / 1000) + SUMMARY_TTL_DAYS * 86400
  const action = expiresAt <= nowSeconds ? 'delete' : 'set expiry'
  console.log(`  user ${hashed(item.pk.S)}: updated ${updatedAt}, ${action}${action === 'set expiry' ? ` to ${new Date(expiresAt * 1000).toISOString()}` : ''}`)
  if (!apply) continue
  try {
    if (action === 'delete') {
      await client.send(
        new DeleteItemCommand({ TableName: TABLE, Key: key, ...unchangedSinceScan, ExpressionAttributeValues: { ':scanned': item.updatedAt } })
      )
    } else {
      await client.send(
        new UpdateItemCommand({
          TableName: TABLE,
          Key: key,
          UpdateExpression: 'SET #ttl = :ttl',
          ...unchangedSinceScan,
          ExpressionAttributeValues: { ':ttl': { N: String(expiresAt) }, ':scanned': item.updatedAt },
        })
      )
    }
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err
    console.log(`    skipped: rewritten since the scan`)
  }
}
