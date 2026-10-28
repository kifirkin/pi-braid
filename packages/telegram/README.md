# pi-braid-telegram

<!-- status: current -->

Talk to your pi coding agent from Telegram: it sends you answers, reads your replies, and lets you
approve a decision with a tap. Text and voice both directions, one bot, no extra service.

## Install

```bash
pi install npm:pi-braid-telegram
```

Set `BRAID_TG_BOT_TOKEN` from @BotFather, and optionally `BRAID_TG_CHAT_ID` to pin the owner chat.
Without a token the extension loads, does nothing, and says so in the log.

## What you get

| Surface              | What it gives you                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telegram_send`      | Text or synthesized voice to the owner; long messages split to fit; optional inline decision buttons whose tap comes back as an inbound message   |
| `telegram_inbox`     | Pull pending messages mid-turn, with sender provenance and an owner flag                                                                          |
| `telegram_poller`    | Optional background long-poll delivery; one poller per process                                                                                    |
| Live update          | On an owner message: one "working" message edited in place, then a formatted report                                                               |
| Inbound media        | Owner photos, documents and voice notes are downloaded to the media directory; a voice note is transcribed when a transcription key is configured |
| Turn-complete notify | Opt-in: a distilled owner update when a turn ends with a completed answer                                                                         |
| Decision buttons     | 1 or 2 rows of up to 4 buttons on a message; a tap returns to the agent as an inbound message, and the owner can always answer in words           |

## Configuration

### Environment

| Variable                           | Purpose                                                     | Default           |
| ---------------------------------- | ----------------------------------------------------------- | ----------------- |
| `BRAID_TG_BOT_TOKEN`               | Bot token from @BotFather; its presence enables the channel | required to run   |
| `BRAID_TG_CHAT_ID`                 | Owner chat id for outbound and the allow-list               | unset             |
| `BRAID_TG_ALLOWED_USERS`           | Extra allow-listed ids or usernames, comma-separated        | unset             |
| `BRAID_TG_POLL_ENABLED`            | Opt-in: start the background poller at load                 | off               |
| `BRAID_TG_POLL_INTERVAL_MS`        | Poll cadence                                                | `1500`            |
| `BRAID_TG_COALESCE_WINDOW_MS`      | Window that gathers an owner burst into one message         | `2000`            |
| `BRAID_TG_NOTIFY_ENABLED`          | Opt-in: turn-complete notification                          | off               |
| `BRAID_TG_NOTIFY_MODEL`            | Crafting model override, as provider and model id           | the session model |
| `BRAID_TG_NOTIFY_MAX_PER_MIN`      | Notification rate cap                                       | `4`               |
| `BRAID_TG_LIVE_UPDATE_ENABLED`     | The tracked "working" message                               | on; `0` disables  |
| `BRAID_TG_LIVE_UPDATE_MAX_PER_MIN` | Progress edit rate cap                                      | `4`               |
| `BRAID_TG_VERBOSE`                 | Route debug and info lines to the notify sink               | off               |

Two families beyond the table: the `BRAID_TG_STT_*` variables configure speech to text (an API key,
base URL, model and language, plus a key pool), and `BRAID_TG_STATE_FILE` relocates the poll offset.
Every `BRAID_TG_*` name has a `TELEGRAM_*` alias; the prefixed name wins when both are set.

### Settings

`braid.telegram.*` keys in `~/.pi/agent/settings.json`:

| Key                             | Default  | Effect                                                     |
| ------------------------------- | -------- | ---------------------------------------------------------- |
| `braid.telegram.sendMaxChars`   | `4096`   | Cap for plain `telegram_send` text; re-read per send       |
| `braid.telegram.notifyMaxChars` | `1200`   | Cap for the turn-complete update; re-read per notification |
| `braid.telegram.tts`            | edge-tts | Voice source, rate and voices; read at extension load      |
| `braid.telegram.pauseStateFile` | unset    | Where the pause control keeps its state; read at load      |

## Limits

- Only whitelisted chats are read, and only owner messages can become a turn.
- The poller is off by default and only one runs per process.
- Voice replies need a TTS source. `source: "none"` refuses the send rather than silently sending
  text.
- Transcription needs a key. Without one a voice note is still delivered, as the downloaded file,
  and the message says so.

## Documentation

- [Live update](docs/live-update.md): the tracked message, its states and its rate limits.
- [Turn-complete notify](docs/turn-complete-notify.md): detection, crafting, and the cap.
- [Pause control](docs/pause-control.md): how a paused session queues and resumes.

## License

[MIT](LICENSE)
