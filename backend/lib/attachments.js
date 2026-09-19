import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { ApiError, notFound, validate } from "./api.js";
import { getTaskRecord, mutateTask, publicAttachment } from "./tasks.js";

// Same limits as PDF import: 10 MB, a short signed-upload lifetime, and objects
// confined to the demo user's prefix. Downloads use short-lived signed links;
// bucket URLs and credentials are never returned.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_PER_TASK = 20;
const LINK_SECONDS = 300;
export const ATTACHMENT_TYPES = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "text/plain": ".txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

const requestSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(Object.keys(ATTACHMENT_TYPES)),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});

const findAttachment = (task, attachmentId) => {
  const attachment = task.attachments.find((entry) => entry.id === attachmentId);
  if (!attachment) throw notFound("attachment");
  return attachment;
};

export async function requestAttachmentUpload({ db, s3, bucket, tables }, taskId, body, now, sign = createPresignedPost) {
  const input = validate(requestSchema, body, "Choose a PDF, image, text, or Word file no larger than 10 MB.");
  const task = await getTaskRecord(db, tables.tasks, taskId);
  if (task.attachments.length >= MAX_PER_TASK) throw new ApiError(409, "CONFLICT", `A task can hold at most ${MAX_PER_TASK} attachments.`);
  const id = randomUUID();
  const s3Key = `demo-user/attachments/${taskId}/${id}${ATTACHMENT_TYPES[input.contentType]}`;
  const upload = await sign(s3, {
    Bucket: bucket, Key: s3Key, Expires: LINK_SECONDS,
    Conditions: [["content-length-range", 1, MAX_ATTACHMENT_BYTES], { "Content-Type": input.contentType }],
    Fields: { "Content-Type": input.contentType },
  });
  const attachment = { id, fileName: input.fileName, contentType: input.contentType, size: input.size, s3Key, status: "PENDING", createdAt: now.toISOString() };
  await mutateTask(db, tables.tasks, taskId, now, (current) => {
    if (current.attachments.length >= MAX_PER_TASK) throw new ApiError(409, "CONFLICT", `A task can hold at most ${MAX_PER_TASK} attachments.`);
    current.attachments.push(attachment);
    return current;
  });
  return { attachment: publicAttachment(attachment), upload: { url: upload.url, fields: upload.fields }, expiresInSeconds: LINK_SECONDS };
}

// Confirms the browser's upload actually landed and matches what was declared.
export async function confirmAttachment({ db, s3, bucket, tables }, taskId, attachmentId, now) {
  const task = await getTaskRecord(db, tables.tasks, taskId);
  const attachment = findAttachment(task, attachmentId);
  if (attachment.status === "READY") return publicAttachment(attachment);
  let object;
  try { object = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: attachment.s3Key })); }
  catch (error) {
    if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) throw new ApiError(409, "UPLOAD_NOT_FOUND", "The file has not finished uploading. Upload it, then confirm again.");
    throw error;
  }
  if (!object.ContentLength || object.ContentLength > MAX_ATTACHMENT_BYTES || object.ContentType !== attachment.contentType) {
    throw new ApiError(400, "VALIDATION_ERROR", "The uploaded file does not match the declared type or size.");
  }
  const updated = await mutateTask(db, tables.tasks, taskId, now, (current) => {
    const entry = findAttachment(current, attachmentId);
    Object.assign(entry, { status: "READY", size: object.ContentLength });
    return current;
  });
  return publicAttachment(findAttachment(updated, attachmentId));
}

export async function attachmentDownload({ db, s3, bucket, tables }, taskId, attachmentId, presign = getSignedUrl) {
  const attachment = findAttachment(await getTaskRecord(db, tables.tasks, taskId), attachmentId);
  if (attachment.status !== "READY") throw new ApiError(409, "UPLOAD_NOT_FOUND", "This attachment has not finished uploading.");
  const safeName = attachment.fileName.replace(/["\\\r\n]/g, "_");
  const url = await presign(s3, new GetObjectCommand({
    Bucket: bucket, Key: attachment.s3Key,
    ResponseContentType: attachment.contentType,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  }), { expiresIn: LINK_SECONDS });
  return { url, expiresInSeconds: LINK_SECONDS, fileName: attachment.fileName, contentType: attachment.contentType };
}

export async function deleteAttachment({ db, s3, bucket, tables }, taskId, attachmentId, now) {
  const attachment = findAttachment(await getTaskRecord(db, tables.tasks, taskId), attachmentId);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: attachment.s3Key }));
  await mutateTask(db, tables.tasks, taskId, now, (current) => {
    current.attachments = current.attachments.filter((entry) => entry.id !== attachmentId);
    return current;
  });
}

// Removes a task's stored files when a manual task is deleted.
export async function deleteTaskFiles({ s3, bucket }, task) {
  for (const attachment of task.attachments) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: attachment.s3Key })); }
    catch { /* an absent object is already gone */ }
  }
}
