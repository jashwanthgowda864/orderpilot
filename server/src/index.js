import { createApp } from './app.js';
import { config } from './config.js';
import { ensureBucket, storageMode } from './services/storage.js';
import { geminiStatus } from './services/gemini.js';

await ensureBucket().catch((err) => console.warn('[storage] could not verify bucket:', err.message));
createApp().listen(config.port, () => {
  const ai = geminiStatus();
  console.log(`OrderPilot API on http://localhost:${config.port}  | storage: ${storageMode} | AI: ${ai.mock ? 'MOCK (no GEMINI_API_KEY)' : ai.model}`);
});
