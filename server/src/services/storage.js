// Private file storage. Uses the Supabase Storage private bucket when
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set; otherwise a private local
// folder (development only). Files are never publicly readable: the API checks
// access and then returns a short-lived signed URL or streams the file.
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../middleware/error.js';

const unavailable = () => new HttpError(503, 'File storage is not reachable right now. Please try again in a moment.');
const isNetworkError = (e) => /fetch failed|network|ECONNRESET|ETIMEDOUT|socket/i.test(String(e?.message || e));

/** Runs a Supabase storage call, retrying once on network errors. */
async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data, error } = await fn();
      if (error && isNetworkError(error) && attempt === 0) continue;
      return { data, error };
    } catch (e) {
      if (isNetworkError(e) && attempt === 0) { await new Promise((r) => setTimeout(r, 300)); continue; }
      if (isNetworkError(e)) throw unavailable();
      throw e;
    }
  }
}

const { supabaseUrl, serviceRoleKey, bucket, localDir } = config.storage;
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : null;

export const storageMode = supabase ? 'supabase' : 'local';

function safeLocalPath(objectPath) {
  const full = path.resolve(localDir, objectPath);
  if (!full.startsWith(path.resolve(localDir) + path.sep)) throw new Error('Invalid storage path.');
  return full;
}

export async function ensureBucket() {
  if (!supabase) return mkdir(localDir, { recursive: true });
  const { data } = await supabase.storage.getBucket(bucket);
  if (!data) {
    const { error } = await supabase.storage.createBucket(bucket, { public: false });
    if (error && !/already exists/i.test(error.message)) throw error;
  }
}

export async function uploadFile(objectPath, buffer, contentType) {
  if (supabase) {
    const { error } = await withRetry(() => supabase.storage.from(bucket).upload(objectPath, buffer, { contentType, upsert: false }));
    // A retried upload may find the first attempt already stored the file.
    if (error && !/already exists|duplicate/i.test(error.message)) {
      if (isNetworkError(error)) throw unavailable();
      throw new Error(`Storage upload failed: ${error.message}`);
    }
    return objectPath;
  }
  const full = safeLocalPath(objectPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buffer, { flag: 'wx' });
  await writeFile(`${full}.meta`, JSON.stringify({ contentType }));
  return objectPath;
}

export async function removeFile(objectPath) {
  try {
    if (supabase) await supabase.storage.from(bucket).remove([objectPath]);
    else { await unlink(safeLocalPath(objectPath)); await unlink(`${safeLocalPath(objectPath)}.meta`); }
  } catch { /* best effort */ }
}

/** Returns { url } for Supabase (signed, 5 min) or { buffer, contentType } locally. */
export async function getFile(objectPath) {
  if (supabase) {
    const { data, error } = await withRetry(() => supabase.storage.from(bucket).createSignedUrl(objectPath, 300));
    if (error) {
      if (isNetworkError(error)) throw unavailable();
      throw new Error(`Storage error: ${error.message}`);
    }
    return { url: data.signedUrl };
  }
  const full = safeLocalPath(objectPath);
  const buffer = await readFile(full);
  let contentType = 'application/octet-stream';
  try { contentType = JSON.parse(await readFile(`${full}.meta`, 'utf8')).contentType; } catch { /* default */ }
  return { buffer, contentType };
}
