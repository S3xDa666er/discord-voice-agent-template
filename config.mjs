// Config for the realtime ElevenLabs-agent bridge (agent.mjs).
// Reads the `.env` sitting next to this file. The bot's personality / voice /
// knowledge live in the ElevenLabs agent, so the bridge needs only connection
// + access credentials.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(HERE, '.env') });

function need(key) {
  const v = (process.env[key] || '').trim();
  if (!v) {
    console.error(`Missing ${key} in ${path.join(HERE, '.env')} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const cfg = {
  discordToken: need('DISCORD_BOT_TOKEN'),
  elevenKey: need('ELEVENLABS_API_KEY'),
  agentId: need('ELEVENLABS_AGENT_ID'),
  // Empty = everyone in the server may use the commands + be heard.
  allowedUserIds: new Set(
    (process.env.DISCORD_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ),
};
