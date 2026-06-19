// Standalone check of the ElevenLabs Conversational AI connection — no Discord.
// Opens the WS, sends a text message, logs events, saves the agent's audio reply.
// Run:  node test-agent.mjs
import fs from 'node:fs';
import WebSocket from 'ws';
import { cfg } from './config.mjs';

if (!cfg.agentId) { console.error('Set ELEVENLABS_AGENT_ID in .env first.'); process.exit(1); }

// Public agents connect directly; private agents use a signed URL (needs an API
// key with convai_write). Try signed first, fall back to direct.
async function resolveUrl() {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(cfg.agentId)}`,
      { headers: { 'xi-api-key': cfg.elevenKey } },
    );
    if (res.ok) {
      const { signed_url } = await res.json();
      if (signed_url) { console.log('using signed URL (private agent) ✓'); return signed_url; }
    } else {
      console.log(`signed URL unavailable (${res.status}) — using direct (public agent)`);
    }
  } catch { /* fall through */ }
  return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(cfg.agentId)}`;
}

const ws = new WebSocket(await resolveUrl());
const audio = [];
let outFmt = 'pcm_16000';

ws.on('open', () => {
  console.log('ws open ✓');
  ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
  setTimeout(() => ws.send(JSON.stringify({
    type: 'user_message', text: 'Hello! Can you hear me? Reply in one short sentence.',
  })), 800);
});

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === 'conversation_initiation_metadata') {
    outFmt = ev.conversation_initiation_metadata_event?.agent_output_audio_format || outFmt;
    console.log('metadata ✓ output format =', outFmt);
  } else if (ev.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', event_id: ev.ping_event?.event_id }));
  } else if (ev.type === 'agent_response') {
    console.log('[agent]', ev.agent_response_event?.agent_response);
  } else if (ev.type === 'audio') {
    audio.push(Buffer.from(ev.audio_event.audio_base_64, 'base64'));
  } else if (ev.type === 'agent_response_complete') {
    const pcm = Buffer.concat(audio);
    fs.writeFileSync('_agent_reply.pcm', pcm);
    console.log(`done ✓ — ${pcm.length} bytes PCM (${outFmt}) saved to _agent_reply.pcm`);
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout — no completion in 30s'); process.exit(1); }, 30_000);
