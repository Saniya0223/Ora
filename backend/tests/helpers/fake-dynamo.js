// In-memory DynamoDB DocumentClient stand-in for tests. It evaluates the real
// expression strings the application sends (conditions, updates, key
// conditions, projections) so a wrong expression fails the test instead of
// passing silently. It supports only the grammar this codebase uses.

import { isDeepStrictEqual } from "node:util";

class AwsError extends Error {
  constructor(name, message = name) { super(message); this.name = name; }
}

function tokenize(text) {
  const tokens = [];
  const pattern = /\s*(<>|<=|>=|[=<>(),+-]|[#:]?[A-Za-z_][A-Za-z0-9_.]*|\d+)\s*/gy;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) tokens.push(match[1]);
  if (pattern.lastIndex < text.length && text.slice(pattern.lastIndex).trim()) throw new Error(`Cannot tokenize: ${text}`);
  return tokens;
}

function evaluator(names = {}, values = {}) {
  const attr = (token) => (token.startsWith("#") ? names[token] : token);
  const read = (item, token) => item?.[attr(token)];
  const valueOf = (item, tokens, i) => {
    const token = tokens[i];
    if (token === "size") {
      const target = read(item, tokens[i + 2]);
      return [Array.isArray(target) || typeof target === "string" ? target.length : 0, i + 4];
    }
    if (token === "if_not_exists") {
      const current = read(item, tokens[i + 2]);
      const [fallback, next] = valueOf(item, tokens, i + 4);
      return [current === undefined ? fallback : current, next + 1];
    }
    if (token === "list_append") {
      const [a, afterA] = valueOf(item, tokens, i + 2);
      const [b, afterB] = valueOf(item, tokens, afterA + 1);
      return [[...(a ?? []), ...(b ?? [])], afterB + 1];
    }
    if (token.startsWith(":")) return [structuredClone(values[token]), i + 1];
    return [read(item, token), i + 1];
  };
  const arithmetic = (item, tokens, i) => {
    let [value, next] = valueOf(item, tokens, i);
    while (tokens[next] === "+" || tokens[next] === "-") {
      const [right, after] = valueOf(item, tokens, next + 1);
      value = tokens[next] === "+" ? value + right : value - right;
      next = after;
    }
    return [value, next];
  };
  function condition(item, tokens, i = 0) {
    let [left, next] = conjunction(item, tokens, i);
    while (tokens[next] === "OR") { const [right, after] = conjunction(item, tokens, next + 1); left = left || right; next = after; }
    return [left, next];
  }
  function conjunction(item, tokens, i) {
    let [left, next] = factor(item, tokens, i);
    while (tokens[next] === "AND") { const [right, after] = factor(item, tokens, next + 1); left = left && right; next = after; }
    return [left, next];
  }
  function factor(item, tokens, i) {
    const token = tokens[i];
    if (token === "NOT") { const [value, next] = factor(item, tokens, i + 1); return [!value, next]; }
    if (token === "(") { const [value, next] = condition(item, tokens, i + 1); return [value, next + 1]; }
    if (token === "attribute_exists") return [read(item, tokens[i + 2]) !== undefined, i + 4];
    if (token === "attribute_not_exists") return [read(item, tokens[i + 2]) === undefined, i + 4];
    if (token === "begins_with") {
      const target = read(item, tokens[i + 2]);
      const [prefix] = valueOf(item, tokens, i + 4);
      return [typeof target === "string" && target.startsWith(prefix), i + 6];
    }
    const [left, afterLeft] = valueOf(item, tokens, i);
    const op = tokens[afterLeft];
    if (op === "BETWEEN") {
      const [low, afterLow] = valueOf(item, tokens, afterLeft + 1);
      const [high, afterHigh] = valueOf(item, tokens, afterLow + 1);
      return [left !== undefined && left >= low && left <= high, afterHigh];
    }
    const [right, next] = valueOf(item, tokens, afterLeft + 1);
    const result = { "=": isDeepStrictEqual(left, right), "<>": !isDeepStrictEqual(left, right), "<": left < right, "<=": left <= right, ">": left > right, ">=": left >= right }[op];
    if (result === undefined) throw new Error(`Unsupported operator ${op}`);
    return [left !== undefined && right !== undefined ? result : op === "<>", next];
  }
  return {
    test: (item, expression) => (expression ? condition(item, tokenize(expression))[0] : true),
    update(item, expression) {
      const tokens = tokenize(expression);
      const next = structuredClone(item);
      let i = 0;
      let clause;
      while (i < tokens.length) {
        if (["SET", "REMOVE", "ADD"].includes(tokens[i])) { clause = tokens[i]; i++; continue; }
        if (tokens[i] === ",") { i++; continue; }
        const name = attr(tokens[i]);
        if (clause === "SET") { const [value, after] = arithmetic(item, tokens, i + 2); next[name] = value; i = after; }
        else if (clause === "REMOVE") { delete next[name]; i++; }
        else if (clause === "ADD") { const [value, after] = valueOf(item, tokens, i + 1); next[name] = (next[name] ?? 0) + value; i = after; }
        else throw new Error(`Unsupported update: ${expression}`);
      }
      return next;
    },
  };
}

export class FakeDynamo {
  constructor(tables) {
    this.keys = tables; // { tableName: [hashKey, rangeKey?] }
    this.data = Object.fromEntries(Object.keys(tables).map((name) => [name, new Map()]));
    this.log = [];
  }

  keyOf(table, item) { return JSON.stringify(this.keys[table].map((key) => item[key])); }
  table(name) { if (!this.data[name]) throw new Error(`Unknown table ${name}`); return this.data[name]; }
  seed(table, ...items) { for (const item of items) this.table(table).set(this.keyOf(table, item), structuredClone(item)); return this; }
  all(table) { return [...this.table(table).values()].map((item) => structuredClone(item)); }
  get(table, key) { const item = this.table(table).get(this.keyOf(table, key)); return item ? structuredClone(item) : undefined; }

  project(item, projection, names = {}) {
    if (!item || !projection) return item;
    const fields = projection.split(",").map((part) => part.trim()).map((part) => (part.startsWith("#") ? names[part] : part));
    return Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, item[field]]));
  }

  apply(op, input, staged) {
    const table = this.table(input.TableName);
    const expr = evaluator(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const read = (key) => (staged.has(`${input.TableName}|${key}`) ? staged.get(`${input.TableName}|${key}`) : table.get(key));
    if (op === "Put") {
      const key = this.keyOf(input.TableName, input.Item);
      if (!expr.test(read(key), input.ConditionExpression)) throw new AwsError("ConditionalCheckFailedException");
      staged.set(`${input.TableName}|${key}`, structuredClone(input.Item));
      return {};
    }
    const key = this.keyOf(input.TableName, input.Key);
    const current = read(key);
    if (!expr.test(current, input.ConditionExpression)) throw new AwsError("ConditionalCheckFailedException");
    if (op === "Delete") { staged.set(`${input.TableName}|${key}`, undefined); return {}; }
    if (op === "ConditionCheck") return {};
    const next = expr.update({ ...(current ?? {}), ...input.Key }, input.UpdateExpression);
    staged.set(`${input.TableName}|${key}`, next);
    return input.ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(next) } : {};
  }

  commit(staged) {
    for (const [compound, item] of staged) {
      const [table, key] = [compound.slice(0, compound.indexOf("|")), compound.slice(compound.indexOf("|") + 1)];
      if (item === undefined) this.table(table).delete(key); else this.table(table).set(key, item);
    }
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.log.push({ name, table: input.TableName });
    if (this.failNext?.(name, input)) throw new AwsError("InternalServerError");
    if (name === "GetCommand") return { Item: this.project(this.get(input.TableName, input.Key), input.ProjectionExpression, input.ExpressionAttributeNames) };
    if (["PutCommand", "UpdateCommand", "DeleteCommand"].includes(name)) {
      const staged = new Map();
      const result = this.apply(name.replace("Command", ""), input, staged);
      this.commit(staged);
      return result;
    }
    if (name === "QueryCommand") {
      const expr = evaluator(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
      const [, range] = this.keys[input.TableName];
      const items = this.all(input.TableName).filter((item) => expr.test(item, input.KeyConditionExpression))
        .sort((a, b) => (range ? String(a[range]).localeCompare(String(b[range])) : 0));
      return { Items: items.map((item) => this.project(item, input.ProjectionExpression, input.ExpressionAttributeNames)) };
    }
    if (name === "BatchWriteCommand") {
      for (const [tableName, requests] of Object.entries(input.RequestItems)) {
        for (const request of requests) {
          if (request.PutRequest) this.table(tableName).set(this.keyOf(tableName, request.PutRequest.Item), structuredClone(request.PutRequest.Item));
          else this.table(tableName).delete(this.keyOf(tableName, request.DeleteRequest.Key));
        }
      }
      return { UnprocessedItems: {} };
    }
    if (name === "TransactWriteCommand") {
      const staged = new Map();
      try {
        for (const entry of input.TransactItems) {
          const [op, params] = Object.entries(entry)[0];
          this.apply(op, params, staged);
        }
      } catch (error) {
        if (error.name === "ConditionalCheckFailedException") throw new AwsError("TransactionCanceledException");
        throw error;
      }
      this.commit(staged);
      return {};
    }
    throw new Error(`FakeDynamo does not support ${name}`);
  }
}

export const standardTables = () => new FakeDynamo({
  profiles: ["userId"], events: ["userId", "eventId"], tasks: ["userId", "taskId"],
  focus: ["userId", "sessionId"], blocks: ["userId", "date"], sync: ["userId", "courseId"],
  reviews: ["userId", "reviewId"],
});

export const standardEnv = {
  STUDENT_PROFILE_TABLE: "profiles", ACADEMIC_EVENTS_TABLE: "events", TASKS_TABLE: "tasks",
  FOCUS_SESSIONS_TABLE: "focus", SCHEDULE_BLOCKS_TABLE: "blocks", CLASSROOM_SYNC_STATE_TABLE: "sync",
  DAILY_STUDY_HOURS: "4",
};
