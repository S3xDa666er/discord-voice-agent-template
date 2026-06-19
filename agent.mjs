// Discord voice-agent bridge — REALTIME bridge to an ElevenLabs Conversational AI agent.
//
// The ElevenLabs agent handles VAD, turn-taking, interruption, the LLM and TTS
// server-side. This process just bridges audio between Discord and the agent:
//
//   Discord mic (48kHz stereo) --downsample--> 16kHz mono --> WS user_audio_chunk
//   WS audio events (PCM mono) --upsample--> 48kHz stereo --> Discord playback
//
// Your bot's personality / voice / knowledge all live in the ElevenLabs agent.
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, EndBehaviorType,
  createAudioPlayer, createAudioResource, entersState, StreamType,
  VoiceConnectionStatus, NoSubscriberBehavior,
} from '@discordjs/voice';
import prism from 'prism-media';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';

import { cfg } from './config.mjs';

if (!cfg.agentId) {
  console.error('Missing ELEVENLABS_AGENT_ID in .env — set it to your ElevenLabs agent id.');
  process.exit(1);
}

// Bot/agent share-codes (e.g. "A05-34FBS-SSSND") are posted to the text channel
// instead of spoken. Tweak or remove this regex if your bot has no such codes.
const CODE_RE = /\b[A-Z0-9]{2,6}(?:-[A-Z0-9]{2,6}){2,}\b/g;
const allowed = (id) => cfg.allowedUserIds.size === 0 || cfg.allowedUserIds.has(String(id));

// ---------- audio resampling (no ffmpeg; integer/linear, fine for speech) ----------

// Discord PCM (48kHz, 16-bit, stereo) -> ElevenLabs PCM (16kHz, 16-bit, mono).
// Average L/R to mono, then box-average every 3 samples (48000/16000 = 3).
function stereo48kToMono16k(buf) {
  const inFrames = Math.floor(buf.length / 4); // 2ch * 2 bytes
  const outFrames = Math.floor(inFrames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    let acc = 0;
    for (let j = 0; j < 3; j++) {
      const idx = (i * 3 + j) * 4;
      acc += (buf.readInt16LE(idx) + buf.readInt16LE(idx + 2)) / 2;
    }
    let v = Math.round(acc / 3);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

// ElevenLabs PCM (inRate, 16-bit, mono) -> Discord PCM (48kHz, 16-bit, stereo).
// Linear interpolation upsample, then duplicate the mono sample to L/R.
function monoToStereo48k(buf, inRate) {
  const inSamples = Math.floor(buf.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);
  const ratio = 48000 / inRate;
  const outSamples = Math.floor(inSamples * ratio);
  const out = Buffer.alloc(outSamples * 4);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = srcPos - i0;
    const s0 = buf.readInt16LE(i0 * 2);
    const s1 = buf.readInt16LE(i1 * 2);
    let v = Math.round(s0 + (s1 - s0) * frac);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

function parseRate(fmt) {
  // formats look like "pcm_16000", "pcm_24000", "pcm_44100"
  const m = /(\d{4,6})/.exec(fmt || '');
  return m ? parseInt(m[1], 10) : 16000;
}

// ---------- ElevenLabs Conversational AI WebSocket ----------

const DIRECT_URL = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(cfg.agentId)}`;

// Public agents connect directly with just the agent_id. Private agents need a
// signed URL (requires an API key with the convai_write permission). We try the
// signed URL and fall back to direct so either setup works.
async function resolveUrl() {
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(cfg.agentId)}`,
      { headers: { 'xi-api-key': cfg.elevenKey } },
    );
    if (res.ok) {
      const body = await res.json();
      const signed = body.signed_url || body.signedUrl;
      if (signed) return signed;
    }
  } catch { /* fall through to direct */ }
  return DIRECT_URL; // public agent
}

async function openAgent(s) {
  const url = await resolveUrl();
  const ws = new WebSocket(url);
  s.ws = ws;
  s.outRate = 16000;

  ws.on('open', () => {
    console.log('[agent] websocket open');
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
  });

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    handleAgentEvent(s, ev);
  });

  ws.on('error', (e) => console.error('[agent] ws error:', e.message));
  ws.on('close', (code) => {
    console.log(`[agent] ws closed (${code})`);
    s.ws = null;
    // The ElevenLabs conversation times out / drops (e.g. 1006). As long as
    // we're still in the voice channel, transparently reconnect so the user
    // can keep talking without re-running !join.
    if (s.closing || session !== s) return;
    s.reconnects = (s.reconnects || 0) + 1;
    const delay = Math.min(500 * s.reconnects, 4000);
    console.log(`[agent] reconnecting in ${delay}ms…`);
    setTimeout(() => {
      if (s.closing || session !== s) return;
      openAgent(s).catch((e) => console.error('[agent] reconnect failed:', e.message));
    }, delay);
  });
}

function handleAgentEvent(s, ev) {
  switch (ev.type) {
    case 'conversation_initiation_metadata': {
      const md = ev.conversation_initiation_metadata_event || {};
      s.outRate = parseRate(md.agent_output_audio_format);
      s.reconnects = 0; // healthy connection — reset backoff
      console.log(`[agent] ready (output ${md.agent_output_audio_format || 'pcm_16000'} -> 48k stereo)`);
      break;
    }
    case 'ping': {
      const id = ev.ping_event?.event_id;
      const delay = ev.ping_event?.ping_ms || 0;
      setTimeout(() => {
        if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'pong', event_id: id }));
      }, delay);
      break;
    }
    case 'audio': {
      const b64 = ev.audio_event?.audio_base_64;
      if (!b64) break;
      const mono = Buffer.from(b64, 'base64');
      const stereo48k = monoToStereo48k(mono, s.outRate);
      if (s.outPcm) s.outPcm.write(stereo48k);
      break;
    }
    case 'interruption': {
      // User barged in — drop everything queued so the bot stops immediately.
      flushPlayback(s);
      break;
    }
    case 'user_transcript': {
      const t = ev.user_transcription_event?.user_transcript;
      if (t) console.log(`[you] ${t}`);
      break;
    }
    case 'agent_response': {
      const t = ev.agent_response_event?.agent_response || '';
      if (t) console.log(`[agent] ${t}`);
      const codes = t.match(CODE_RE) || [];
      if (codes.length && s.textChannel) {
        s.textChannel.send(codes.map((c) => '`' + c + '`').join('\n')).catch(() => {});
      }
      break;
    }
    default:
      break;
  }
}

// ---------- Discord audio I/O ----------

function ensurePlayback(s) {
  if (s.outPcm) return;
  s.outPcm = new PassThrough();
  const resource = createAudioResource(s.outPcm, { inputType: StreamType.Raw });
  s.player.play(resource);
}

function flushPlayback(s) {
  try { s.player.stop(true); } catch {}
  if (s.outPcm) { try { s.outPcm.destroy(); } catch {} s.outPcm = null; }
  ensurePlayback(s);
}

function startListening(s) {
  const receiver = s.connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (!allowed(userId)) return;
    if (s.subscribed.has(userId)) return;
    s.subscribed.add(userId);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pcm = opus.pipe(decoder);
    pcm.on('data', (chunk) => {
      if (s.ws?.readyState !== WebSocket.OPEN) return;
      const mono16k = stereo48kToMono16k(chunk);
      if (mono16k.length) s.ws.send(JSON.stringify({ user_audio_chunk: mono16k.toString('base64') }));
    });
    const done = () => s.subscribed.delete(userId);
    pcm.on('end', done);
    pcm.on('error', done);
  });
}

// ---------- Discord client + commands ----------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let session = null;

function teardown() {
  if (!session) return;
  session.closing = true;
  try { session.ws?.close(); } catch {}
  try { session.player.stop(true); } catch {}
  try { session.outPcm?.destroy(); } catch {}
  try { session.connection.destroy(); } catch {}
  session = null;
}

client.once('clientReady', (c) => {
  console.log(`Logged in as ${c.user.tag} — realtime agent bridge (agent=${cfg.agentId})`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.content.startsWith('!')) return;
  const cmd = msg.content.slice(1).trim().split(/\s+/)[0].toLowerCase();

  if (cmd === 'join') {
    if (!allowed(msg.author.id)) return;
    const channel = msg.member?.voice?.channel;
    if (!channel) { msg.reply('Hop in a voice channel first, then `!join`.'); return; }
    if (session) teardown();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch { msg.reply('Could not connect to voice (timeout).'); try { connection.destroy(); } catch {} return; }

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(player);
    session = {
      connection, player, guildId: channel.guild.id, textChannel: msg.channel,
      ws: null, outPcm: null, outRate: 16000, subscribed: new Set(),
    };
    ensurePlayback(session);
    startListening(session);
    try { await openAgent(session); }
    catch (e) { console.error('[agent] connect failed:', e.message); msg.reply('Could not reach the ElevenLabs agent.'); teardown(); return; }
    msg.reply(`🎤 Joined **${channel.name}** — talk to the bot (realtime).`);
  } else if (cmd === 'leave' || cmd === 'stop' || cmd === 'dip') {
    if (!allowed(msg.author.id)) return;
    if (!session) { msg.reply("I'm not in a voice channel."); return; }
    teardown();
    msg.reply('👋 Left the channel.');
  }
});

client.login(cfg.discordToken);
