// An in-memory stand-in for the DynamoDB client that memory.mjs uses. It
// evaluates condition expressions and transactions for real, because the
// retention and 清除記憶 guarantees live in those conditions. Only the syntax
// memory.mjs and the backfill script use is supported; anything else throws.

const failed = (name) => Object.assign(new Error(name), { name })

function evaluator(expression, names = {}, values = {}) {
  const tokens = expression.match(/\(|\)|=|>|<|[#:]?[A-Za-z_][A-Za-z0-9_]*/g)
  let at = 0
  const next = () => tokens[at++]
  const peek = () => tokens[at]
  const expect = (t) => {
    if (next() !== t) throw new Error(`fake DynamoDB cannot parse: ${expression}`)
  }
  const attr = (token) => names[token] ?? token
  const value = (token) => {
    if (!(token in values)) throw new Error(`fake DynamoDB: missing value ${token} in ${expression}`)
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

const holds = (input, row) =>
  !input.ConditionExpression || evaluator(input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)(row)

export function createFakeDynamoDb() {
  const rows = new Map()
  const keyOf = (key) => `${key.pk.S}|${key.sk.S}`
  const hooks = { beforeTransaction: async () => {} }

  function applyUpdate(input, row) {
    const match = input.UpdateExpression.match(/^SET ([#\w]+) = (:\w+)$/)
    if (!match) throw new Error(`fake DynamoDB cannot apply: ${input.UpdateExpression}`)
    const name = input.ExpressionAttributeNames?.[match[1]] ?? match[1]
    return { ...(row ?? input.Key), [name]: input.ExpressionAttributeValues[match[2]] }
  }

  const handlers = {
    Put: (input) => {
      if (!holds(input, rows.get(keyOf(input.Item)))) throw failed('ConditionalCheckFailedException')
      rows.set(keyOf(input.Item), input.Item)
      return {}
    },
    Get: (input) => ({ Item: rows.get(keyOf(input.Key)) }),
    Update: (input) => {
      const row = rows.get(keyOf(input.Key))
      if (!holds(input, row)) throw failed('ConditionalCheckFailedException')
      rows.set(keyOf(input.Key), applyUpdate(input, row))
      return {}
    },
    Delete: (input) => {
      if (!holds(input, rows.get(keyOf(input.Key)))) throw failed('ConditionalCheckFailedException')
      rows.delete(keyOf(input.Key))
      return {}
    },
    Query: (input) => {
      const values = input.ExpressionAttributeValues
      const prefix = values[':prefix']?.S ?? ''
      let items = [...rows.values()]
        .filter((r) => r.pk.S === values[':pk'].S && r.sk.S.startsWith(prefix))
        .sort((a, b) => (a.sk.S < b.sk.S ? -1 : 1))
      if (input.ScanIndexForward === false) items.reverse()
      if (input.Limit) items = items.slice(0, input.Limit)
      return { Items: items }
    },
    Scan: (input) => {
      const test = evaluator(input.FilterExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)
      return { Items: [...rows.values()].filter(test) }
    },
    BatchWrite: (input) => {
      for (const request of Object.values(input.RequestItems)[0]) rows.delete(keyOf(request.DeleteRequest.Key))
      return {}
    },
    Transact: async (input) => {
      await hooks.beforeTransaction()
      const actions = input.TransactItems.map((item) => {
        const [kind, body] = Object.entries(item)[0]
        const key = keyOf(body.Item ?? body.Key)
        return { kind, body, key, ok: holds(body, rows.get(key)) }
      })
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
