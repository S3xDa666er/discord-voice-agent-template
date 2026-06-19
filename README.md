# Discord Voice-Agent Bridge — Template

A ready-to-go starter for a **Discord voice bot** powered by an **ElevenLabs Conversational AI
agent**. The agent does all the hard parts (speech recognition, turn-taking, interruption, the
LLM, and the voice). This little Node process just bridges audio between your Discord voice
channel and the agent.

> **Fill-in-the-blank:** copy `.env.example` → `.env`, paste in 4 values, `npm install`, run.
> No code editing required.

---

## What you get
- `agent.mjs` — the bridge (audio both ways, barge-in, auto-reconnect, share-code → text)
- `config.mjs` — loads `.env`
- `test-agent.mjs` — quick connection check **without** Discord
- `run-bot.cmd` / `launch-hidden.vbs` — keep it alive + optional auto-start (Windows)
- `.env.example` — the blanks to fill in

---

## Prerequisites
- **Node.js 18+** installed (and on your PATH) — https://nodejs.org
- An **ElevenLabs** account
- A **Discord** account with a server you can add a bot to

---

## Setup

### 1. Build your ElevenLabs agent
In the ElevenLabs dashboard → **Agents** → create an agent. Set its **personality (system
prompt)**, **voice**, **LLM**, and any **knowledge** you want it to use. Open the agent and
**copy its Agent ID** (looks like `agent_xxxx…`).
- *Public vs private:* a public agent connects with just the ID. A private agent needs an API
  key with the `convai_write` permission — the bridge handles both automatically (tries a
  signed URL, falls back to direct).

### 2. Create the Discord bot
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (this is `DISCORD_BOT_TOKEN`).
3. Still on the Bot tab → enable **Message Content Intent** (required to read `!join`).
4. **OAuth2 → URL Generator**: scope **`bot`**; bot permissions **Connect**, **Speak**,
   **Send Messages**, **Read Message History**. Open the generated URL and invite the bot to
   your server.

### 3. (Optional) Restrict who can use it
By default **everyone** in the server can use it. To limit it, get your Discord **user ID**
(enable *Settings → Advanced → Developer Mode*, then right-click your name → **Copy User ID**)
and put it in `DISCORD_ALLOWED_USERS`.

### 4. Fill in `.env` and install
```sh
copy .env.example .env       # macOS/Linux: cp .env.example .env
# edit .env and paste your 4 values
npm install
```

### 5. Test the agent connection (no Discord needed)
```sh
node test-agent.mjs
```
You should see `metadata ✓`, an `[agent]` text reply, and `done ✓ … saved to _agent_reply.pcm`.

### 6. Run it
```sh
npm start            # or:  node agent.mjs
```
In Discord: join a voice channel, then type **`!join`** in a text channel the bot can see.
Talk to it. Use **`!leave`** (or `!stop` / `!dip`) to disconnect.

> 🎧 **Wear headphones.** Interrupting the bot (barge-in) works because Discord never sends the
> bot its own audio — but your *speakers* leaking into your mic would make it interrupt itself.

---

## Keep it running / auto-start (Windows)
- **Foreground, self-restarting:** double-click `run-bot.cmd` (logs to
  `%LOCALAPPDATA%\Temp\discord-voice-bot.log`).
- **Hidden (no console):** double-click `launch-hidden.vbs`.
- **Start at logon:** press `Win+R`, type `shell:startup`, and drop a **shortcut to
  `launch-hidden.vbs`** into that folder.

To stop it: end the `node.exe` process **and** remove the Startup shortcut (otherwise the
wrapper relaunches it ~5s later).

*(On Linux/cloud, run `node agent.mjs` under `pm2` or a `systemd` service instead.)*

---

## Notes
- **One Discord token = one running instance.** Don't run the same bot in two places at once —
  they'll kick each other off.
- **Secrets live only in `.env`** (gitignored). Never commit it.
- **Commands:** `!join`, `!leave` / `!stop` / `!dip`.
- The `CODE_RE` regex in `agent.mjs` posts code-like strings (e.g. `A05-34FBS-SSSND`) to the
  text channel instead of speaking them — tweak or delete it if your bot has no such codes.
