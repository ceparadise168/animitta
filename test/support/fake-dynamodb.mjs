// An in-memory stand-in for the DynamoDB client that memory.mjs uses. It
// evaluates condition expressions and transactions for real, because the
// retention and 清除記憶 guarantees live in those conditions, and it rejects
// the requests real DynamoDB rejects (unused expression values, unaliased
// reserved words, oversized or duplicate batches and transactions). Only the
// syntax memory.mjs and the backfill script use is supported; anything else
// throws.

const failed = (name, message = name) => Object.assign(new Error(message), { name })
const invalid = (message) => failed('ValidationException', message)

// DynamoDB reserved words among this table's attribute names, checked against
// the service's reserved-word list. They must go through ExpressionAttributeNames.
const RESERVED = new Set(['ttl', 'role'])

function evaluator(expression, names = {}, values = {}) {
  const tokens = expression.match(/\(|\)|=|>|<|[#:]?[A-Za-z_][A-Za-z0-9_]*/g)
  let at = 0
  const next = () => tokens[at++]
  const peek = () => tokens[at]
  const expect = (t) => {
    if (next() !== t) throw new Error(`fake DynamoDB cannot parse: ${expression}`)
  }
  const attr = (token) => {
    if (token.startsWith('#')) {
      if (!(token in names)) throw invalid(`An expression attribute name used in the document path is not defined: ${token}`)
      return names[token]
    }
    if (RESERVED.has(token.toLowerCase())) throw invalid(`Attribute name is a reserved keyword; reserved keyword: ${token}`)
    return token
  }
  const value = (token) => {
    if (!(token in values)) throw invalid(`An expression attribute value used in expression is not defined: ${token}`)
    return values[token]
  }
  const scalar = (v) => (v.N !== undefined ? Number(v.N) : v.S)

  function unary() {
    const t = next()
    if (t === '(') {
      const inner = or()
      expect(')')
      return inner
    }
    if (t === 'attribute_exists' || t === 'attribute_not_exists') {
      expect('(')
      const name = attr(next())
      expect(')')
      return t === 'attribute_exists' ? (row) => row?.[name] !== undefined : (row) => row?.[name] === undefined
    }
    const name = attr(t)
    const op = next()
    const right = scalar(value(next()))
    if (!['=', '>', '<'].includes(op)) throw new Error(`fake DynamoDB cannot parse: ${expression}`)
    return (row) => {
      const left = row?.[name]
      if (left === undefined) return false
      const l = scalar(left)
      return op === '=' ? l === right : op === '>' ? l > right : l < right
    }
  }
  function and() {
    let left = unary()
    while (peek() === 'AND') {
      next()
      const l = left, r = unary()
      left = (row) => l(row) && r(row)
    }
    return left
  }
  function or() {
    let left = and()
    while (peek() === 'OR') {
      next()
      const l = left, r = and()
      left = (row) => l(row) || r(row)
    }
    return left
  }
  const test = or()
  if (at !== tokens.length) throw new Error(`fake DynamoDB cannot parse: ${expression}`)
  return test
}

// DynamoDB rejects a request that defines a name or value its expressions do not use.
function checkUnused(input, ...expressions) {
  const used = expressions.filter(Boolean).join(' ')
  for (const token of [...Object.keys(input.ExpressionAttributeNames ?? {}), ...Object.keys(input.ExpressionAttributeValues ?? {})]) {
    if (!new RegExp(`${token}(?![A-Za-z0-9_])`).test(used)) throw invalid(`Value provided in ExpressionAttributes unused in expressions: ${token}`)
  }
}

function checkCondition(input, row) {
  checkUnused(input, input.ConditionExpression, input.UpdateExpression)
  return !input.ConditionExpression || evaluator(input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)(row)
}

function checkUniqueKeys(keys, what) {
  if (new Set(keys).size !== keys.length) throw invalid(`${what} cannot include multiple operations on one item`)
}

export function createFakeDynamoDb() {
  const rows = new Map()
  const keyOf = (key) => `${key.pk.S}|${key.sk.S}`
  // Knobs a test can set: run something just before a transaction commits,
  // split queries into pages, or have batch writes hand back unprocessed deletes.
  const hooks = { beforeTransaction: async () => {}, queryPageSize: Infinity, unprocessedBatches: 0 }

  function applyUpdate(input, row) {
    const match = input.UpdateExpression.match(/^SET ([#\w]+) = (:\w+)$/)
    if (!match) throw new Error(`fake DynamoDB cannot apply: ${input.UpdateExpression}`)
    const name = input.ExpressionAttributeNames?.[match[1]] ?? match[1]
    if (RESERVED.has(name) && !match[1].startsWith('#')) throw invalid(`Attribute name is a reserved keyword: ${name}`)
    return { ...(row ?? input.Key), [name]: input.ExpressionAttributeValues[match[2]] }
  }

  const handlers = {
    Put: (input) => {
      if (!checkCondition(input, rows.get(keyOf(input.Item)))) throw failed('ConditionalCheckFailedException')
      rows.set(keyOf(input.Item), input.Item)
      return {}
    },
    Get: (input) => ({ Item: rows.get(keyOf(input.Key)) }),
    Update: (input) => {
      const row = rows.get(keyOf(input.Key))
      if (!checkCondition(input, row)) throw failed('ConditionalCheckFailedException')
      rows.set(keyOf(input.Key), applyUpdate(input, row))
      return {}
    },
    Delete: (input) => {
      if (!checkCondition(input, rows.get(keyOf(input.Key)))) throw failed('ConditionalCheckFailedException')
      rows.delete(keyOf(input.Key))
      return {}
    },
    Query: (input) => {
      checkUnused(input, input.KeyConditionExpression)
      const values = input.ExpressionAttributeValues
      const prefix = values[':prefix']?.S ?? ''
      let items = [...rows.values()]
        .filter((r) => r.pk.S === values[':pk'].S && r.sk.S.startsWith(prefix))
        .sort((a, b) => (a.sk.S < b.sk.S ? -1 : 1))
      if (input.ScanIndexForward === false) items.reverse()
      if (input.ExclusiveStartKey) items = items.slice(items.findIndex((r) => keyOf(r) === keyOf(input.ExclusiveStartKey)) + 1)
      const size = Math.min(input.Limit ?? Infinity, hooks.queryPageSize)
      const page = items.slice(0, size)
      const more = items.length > page.length
      return { Items: page, ...(more && { LastEvaluatedKey: { pk: page.at(-1).pk, sk: page.at(-1).sk } }) }
    },
    Scan: (input) => {
      checkUnused(input, input.FilterExpression, input.ProjectionExpression)
      const test = evaluator(input.FilterExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)
      return { Items: [...rows.values()].filter(test) }
    },
    BatchWrite: (input) => {
      const [table, requests] = Object.entries(input.RequestItems)[0]
      if (requests.length > 25) throw invalid('Too many items requested for the BatchWriteItem call')
      checkUniqueKeys(requests.map((r) => keyOf(r.DeleteRequest.Key)), 'BatchWriteItem')
      if (hooks.unprocessedBatches > 0) {
        hooks.unprocessedBatches--
        return { UnprocessedItems: { [table]: requests } }
      }
      for (const request of requests) rows.delete(keyOf(request.DeleteRequest.Key))
      return { UnprocessedItems: {} }
    },
    Transact: async (input) => {
      if (input.TransactItems.length > 100) throw invalid('Member must have length less than or equal to 100')
      await hooks.beforeTransaction()
      const actions = input.TransactItems.map((item) => {
        const [kind, body] = Object.entries(item)[0]
        const key = keyOf(body.Item ?? body.Key)
        return { kind, body, key, ok: checkCondition(body, rows.get(key)) }
      })
      checkUniqueKeys(actions.map((a) => a.key), 'TransactWriteItems')
      if (actions.some((a) => !a.ok)) throw failed('TransactionCanceledException')
      for (const { kind, body, key } of actions) {
        if (kind === 'Put') rows.set(key, body.Item)
        else if (kind === 'Delete') rows.delete(key)
        else if (kind === 'Update') rows.set(key, applyUpdate(body, rows.get(key)))
      }
      return {}
    },
  }

  const command = (type) =>
    class {
      constructor(input) {
        this.type = type
        this.input = input
      }
    }
  const module = {
    DynamoDBClient: class {
      async send({ type, input }) {
        return handlers[type](input)
      }
    },
    QueryCommand: command('Query'),
    GetItemCommand: command('Get'),
    PutItemCommand: command('Put'),
    UpdateItemCommand: command('Update'),
    DeleteItemCommand: command('Delete'),
    ScanCommand: command('Scan'),
    BatchWriteItemCommand: command('BatchWrite'),
    TransactWriteItemsCommand: command('Transact'),
  }
  return { module, rows, hooks }
}
