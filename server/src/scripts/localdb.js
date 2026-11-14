// Runs a real local Postgres (no Docker needed) for development and tests.
// Usage: npm run db:local   (leave it running in its own terminal)
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../../.localdb', import.meta.url));
const port = Number(process.env.LOCAL_DB_PORT || 54329);

const pgServer = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
});

const fresh = !existsSync(dataDir);
if (fresh) await pgServer.initialise();
await pgServer.start();
if (fresh) await pgServer.createDatabase('orderpilot');
console.log(`Local Postgres running: postgres://postgres:postgres@localhost:${port}/orderpilot  (Ctrl+C to stop)`);

const stop = async () => { await pgServer.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
