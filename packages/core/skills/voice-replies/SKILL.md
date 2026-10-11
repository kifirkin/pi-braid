---
name: voice-replies
description: "Reply to Telegram voice messages with synthesized speech: edge-tts (RU/EN/HE voices) → ffmpeg ogg/opus → Bot API sendVoice, matching the incoming message's language. Use when a voice message arrived and the reply should be a voice note in the same language, or when asked to send a Telegram voice reply. Triggers: voice reply, voice message, sendVoice, TTS, text-to-speech, edge-tts, Telegram audio reply. Includes offline fallbacks (piper, macOS say)."
trigger: "voice replies, voice message reply, sendVoice, TTS, text-to-speech, edge-tts, piper, Telegram audio reply, responding in voice"
validated: 2026-09-09
verdict: UNVALIDATED
---

# Voice Replies

Send Telegram VOICE replies (ogg/opus) synthesized with edge-tts. The full pipeline:
edge-tts (TTS) → ffmpeg (ogg/opus convert) → Bot API `sendVoice`.

## Modality Rule

Reply in the same modality **and language** as received:
voice message in → voice reply in the same language. Text received → text reply.
RU voiced in → Dmitry (RU). EN voiced in → Guy (EN). HE voiced in → Avri (HE).

## Install

Primary: `uvx edge-tts` (ephemeral, zero install) - OR a persistent venv you
created yourself (e.g. `python -m venv .venv && .venv/bin/pip install edge-tts`),
located by setting `$EDGE_TTS_PY` to the venv's python executable. Use the venv
for repeated runs to skip the per-run uvx download.

```
uvx edge-tts --list-voices                       # uvx default (no venv needed)
$EDGE_TTS_PY -m edge_tts --list-voices           # sanity: persistent venv works
```

Version floor (2026-10-09): use the latest `edge-tts` from uvx (7.2.8 at the
time) - old pins break (6.1.12 dies with `WSServerHandshakeError 403` after an
upstream Microsoft auth change), so pin nothing. `NoAudioReceived` is
intermittent - three occurrences on 2026-10-09 alternated fail/ok, and retries
succeeded - so retry the synthesize step 2-3 times before calling it a failure.

## Synthesize

```
uvx edge-tts -v <voice> --file <text.txt> --write-media out.mp3
# or with a persistent venv set in $EDGE_TTS_PY:
$EDGE_TTS_PY -m edge_tts --voice <voice> --file <text.txt> --write-media out.mp3
```

Owner default rate: add `--rate=+20%` (2026-10-09).

Proven voices:

| Lang | Voice                | Note          |
| ---- | -------------------- | ------------- |
| RU   | `ru-RU-DmitryNeural` | male, primary |
| EN   | `en-US-GuyNeural`    | male, primary |
| HE   | `he-IL-AvriNeural`   | male, primary |

## Convert to OGG/Opus

Telegram `sendVoice` requires ogg/opus. Convert with ffmpeg:

```
ffmpeg -y -v error -i out.mp3 -c:a libopus -b:a 40k -ar 48000 -ac 1 out.ogg
```

## Send

```
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendVoice" \
  -F "chat_id=$TELEGRAM_CHAT_ID" \
  -F "voice=@out.ogg" \
  -F "duration=NN"
```

- Env names: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
- NO `parse_mode` on voice (sendVoice has none).

## In-code path (telegram_send voice:true)

`telegram_send voice:true` runs this pipeline in-process. Source config:
`braid.telegram.tts` in `~/.pi/agent/settings.json` (default `edge-tts`, rate
`+20%`, voices above; an absent block means edge-tts). `source` values:
`edge-tts` (default), `edge-tts+say` (say only after the edge attempts are
exhausted), `say`, `none` (disable - `voice:true` then refuses with a clear
error, never text). Seams: `packages/telegram/src/lib/tts.ts`
(`populateVoiceTts`) wired at `packages/telegram/src/index.ts`; send at
`packages/telegram/src/lib/tool-logic.ts`. The in-code conversion uses
`-b:a 48k`; the manual 40k recipe above is equally valid for Telegram.

## Sanity / Verify

```
file out.ogg                     # Ogg data, Opus audio
uvx edge-tts --list-voices | grep -i <lang>                      # voice exists
# or: $EDGE_TTS_PY -m edge_tts --list-voices | grep -i <lang>
```

## Offline Alternatives (lower priority)

edge-tts is the primary zero-key path for RU/EN/HE. Offline fallbacks:

**piper** (offline, RU only):

```
uv tool install piper-tts
# ru_RU-dmitri-medium voice at ~/.local/share/piper/voices/ru/ (onnx+json, 22050Hz espeak)
echo "<text>" | piper --model <ru-model.onnx> --output_file out.wav
ffmpeg -y -v error -i out.wav -c:a libopus -b:a 40k -ar 48000 -ac 1 out.ogg
```

**macOS say** (any installed voice, no extra install):

```
say -v Milena -o out.aiff "<text>"     # Milena = ru-female
ffmpeg -y -v error -i out.aiff -c:a libopus -b:a 40k -ar 48000 -ac 1 out.ogg
```

In code, `say` is emergency-only (the owner dislikes its quality) and stays
behind an explicit config choice (`source: "say"` or `"edge-tts+say"`).

## Dependency Note

edge-tts and piper live in this skill (procedure), not in code - third-party deps
live as documented install+usage skills, like the orchestration pipeline skill.
`ripgrep` (probed by session-recall/search) and `find`/`head`
(memory-agent-bridge/explore-paths) are standard POSIX/rg - no skill
needed.
