// Applies supabase/migrations/*.sql in filename order, each exactly once.
// Applied files are recorded in schema_migrations and never re-run.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../db.js';

const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

async function main() {
  await pool.query(`create table if not exists schema_migrations (
    filename text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  await pool.query('alter table schema_migrations enable row level security');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('select filename, checksum from schema_migrations');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        console.warn(`WARNING: ${file} changed after it was applied. It will NOT be re-run; add a new migration instead.`);
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [file, checksum]);
      await client.query('commit');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('rollback');
      console.error(`FAILED ${file}: ${err.message}`);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
  if (!process.exitCode) console.log('migrations up to date');
}

main().finally(() => pool.end());
