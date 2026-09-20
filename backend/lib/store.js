import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ApiError, notFound } from "./api.js";

// Every record belongs to the single demo student; handlers never accept a
// user ID from the request, so no request can reach another user's rows.
export const USER_ID = "demo-user";

export function tableNames(env) {
  return {
    tasks: env.TASKS_TABLE,
    focus: env.FOCUS_SESSIONS_TABLE,
    blocks: env.SCHEDULE_BLOCKS_TABLE,
    profile: env.STUDENT_PROFILE_TABLE,
    events: env.ACADEMIC_EVENTS_TABLE,
    syncState: env.CLASSROOM_SYNC_STATE_TABLE,
    reviews: env.SOURCE_REVIEWS_TABLE,
  };
}

export function requireTables(env, ...names) {
  const tables = tableNames(env);
  if (names.some((name) => !tables[name])) throw new ApiError(503, "NOT_CONFIGURED", "This part of CampusFlow is not connected yet.");
  return tables;
}

export async function getItem(db, TableName, Key) {
  return (await db.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item ?? null;
}

// All rows for the user, optionally narrowed to a sort-key range.
export async function queryUser(db, TableName, { sortKey, between, beginsWith } = {}) {
  const names = { "#u": "userId" };
  const values = { ":u": USER_ID };
  let condition = "#u = :u";
  if (between) {
    names["#s"] = sortKey;
    Object.assign(values, { ":a": between[0], ":b": between[1] });
    condition += " AND #s BETWEEN :a AND :b";
  } else if (beginsWith) {
    names["#s"] = sortKey;
    values[":p"] = beginsWith;
    condition += " AND begins_with(#s, :p)";
  }
  const items = [];
  let cursor;
  do {
    const page = await db.send(new QueryCommand({
      TableName, KeyConditionExpression: condition, ExpressionAttributeNames: names,
      ExpressionAttributeValues: values, ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}

// Create only if the key is new. Returns false when the row already exists.
export async function putNew(db, TableName, Item, keyAttribute) {
  try {
    await db.send(new PutCommand({ TableName, Item, ConditionExpression: "attribute_not_exists(#k)", ExpressionAttributeNames: { "#k": keyAttribute } }));
    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

// Optimistic read-modify-write. `mutate` receives a copy and returns the next
// row, or null to leave the row unchanged. The write succeeds only if nobody
// else wrote since the read; otherwise it re-reads and re-applies.
export async function updateVersioned(db, TableName, Key, mutate, { what = "item", attempts = 4 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await getItem(db, TableName, Key);
    if (!current) throw notFound(what);
    const next = await mutate(structuredClone(current));
    if (next === null) return current;
    const version = current.version ?? 0;
    next.version = version + 1;
    try {
      await db.send(new PutCommand({
        TableName, Item: next,
        ...(current.version === undefined
          ? { ConditionExpression: "attribute_not_exists(#v)", ExpressionAttributeNames: { "#v": "version" } }
          : { ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": version } }),
      }));
      return next;
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
  throw new ApiError(409, "CONFLICT", "This item changed while it was being saved. Refresh and try again.");
}

export async function deleteItem(db, TableName, Key) {
  await db.send(new DeleteCommand({ TableName, Key }));
}

// Batched writes with bounded retry of unprocessed items.
export async function batchWrite(db, TableName, requests) {
  for (let index = 0; index < requests.length; index += 25) {
    let pending = { [TableName]: requests.slice(index, index + 25) };
    for (let attempt = 0; attempt < 5 && Object.keys(pending).length; attempt++) {
      const result = await db.send(new BatchWriteCommand({ RequestItems: pending }));
      pending = Object.fromEntries(Object.entries(result.UnprocessedItems ?? {}).filter(([, values]) => values.length));
      if (Object.keys(pending).length) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
    if (Object.keys(pending).length) throw new Error("Batch write was throttled");
  }
}
