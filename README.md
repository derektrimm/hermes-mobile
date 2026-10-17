# Hermes Mobile

A phone app for a Hermes agent running on your own server, served only to your own devices over
your tailnet. Open the address you set as `HM_PUBLIC_ORIGIN` (on an iPhone: Share, then Add to
Home Screen).

## Requirements

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) running on a Linux server you own, with
  its dashboard backend (`hermes dashboard`) on `127.0.0.1:9119`.
- [Tailscale](https://tailscale.com) on the server and on your phone, with HTTPS certificates enabled
  for the tailnet. The app is only reachable through `tailscale serve`.
- Node.js 22 on the server and on the machine you deploy from; ssh from that machine to the server.
- Optional, for co-driving PC terminal windows: Hermes's "desktop hands" setup, where windows opened on
  a PC run on the server and their commands run on the PC over ssh.

## What it does

- Chat with Hermes the way the desktop app does: streaming answers, tool steps grouped into one
  collapsible "worked" block, reasoning, a live plan, Stop, queued follow-ups, `/` commands.
- Attach photos (resized on the phone) or any other file up to 20 MB: files are staged in the chat's
  workspace with Hermes's `file.attach` and named in the prompt, as the desktop app sends them.
- While a turn runs, a message either waits for it ("After this turn", the default) or steers it
  ("Steer now"): Hermes reads it at its next step without stopping (`session.steer`; typed as
  `/steer` into a shared PC window, so the window shows it). A steer Hermes refuses runs after the
  turn instead.
- Files a reply delivers (`MEDIA:/path`, or a Markdown image of a local path) show where the reply
  puts them: pictures inline and full screen with Share, video and audio in players, text to read,
  other documents to the share sheet. `/hm/file` reads them through the chat's own backend (a PC
  chat's files come from the PC) and serves only media and document types, never from a hidden folder
  other than Hermes's own media folders (`server/files.mjs`), with a sandboxing content policy.
- Every chat from every Hermes profile in one list, with search across titles and message contents.
- **Remote control of the desktop app.** A chat open in the Hermes desktop app is joined in the
  desktop app's own backend (`session.activate` adds the phone as one more client of the same live
  session): same process, model, tools and environment. Both stream the same turn; either can send,
  stop, or answer an approval, and a question answered on one disappears from the other.
- **Remote control of PC terminal windows.** A window opened from the PC (`hermes`, via the
  PC's launcher) runs Hermes's TUI as a client of a shared backend on the server,
  `hermes-hands@<profile>--<pc>.service`, which keeps the PC's desktop hands: its commands run on the
  PC, in the directory the window was opened from. The phone joins the same live session, so window
  and phone see the same turn and either can send, stop or answer. Files: `pc-windows/hermes-hands`
  (chat launches become attached TUIs; subcommands, `-z`, `--cli` pass straight to plain hermes),
  `pc-windows/hermes-hands-new` (creates the new chat in the launch directory),
  `pc-windows/hermes-hands@.service`; installed by `deploy/deploy.sh`. The PC's `~/.local/bin/hermes`
  sets `HERMES_SESSION_COMMAND` and the server's `hermes-session` runs it.
- Windows opened before this (the classic CLI, one process each), or with a flag only a standalone
  window keeps (`-t`, `-s`, `--yolo`, `-m` on a resume...), show live on the phone. Opening one never
  touches it. The first message sent from the phone restarts that window in place as a shared TUI on
  the same chat (`/hm/share`; the window stays open, commands still run on the PC), then sends.
  The restart only happens when every check is clear, and the window takes no keys during the last
  check: no turn running (screen hint, approval/clarify footer, or a recent unfinished turn in the
  stored chat), no unsent text in its input line, no background jobs (`processes.json` of every
  profile, pids checked on the PC) and no background work on its threads (`/bg`, `/btw`, sign-in,
  async subagents, job pollers). Otherwise the phone keeps the text and says why. There is no
  button: phone and PC are simply both inputs.
- A text message sent from the phone in a chat shared with a PC window is typed into that window
  (`/hm/type`): it shows there as a normal prompt and runs as the window's own. While a turn runs it
  is typed as `/queue ...`, so it waits instead of interrupting. It is only typed when the window's
  input line is empty (no half-typed text, no approval or menu open) and the window is not scrolled
  back; otherwise, and for photos and `/` commands, it goes over the socket as before.
- Turns typed on the PC show their prompt on the phone (read from the live session). Every phone
  message sent over the socket is "run after", so it can never interrupt a turn the PC just started.
- Approvals, clarify questions and sudo/secret prompts appear as cards. A question from a chat that
  is not on screen shows as a banner that jumps to it.
- Notifications while the app is closed (the bell at the foot of the chat list): when Hermes needs
  you (an approval, a question, a sudo password), a reply is ready, a turn fails, or a background task
  finishes, each kind switchable per device. A tap opens that chat. A chat on screen on any device
  stays quiet, and so does a reply that comes within two minutes of a turn typed in a PC window or
  the desktop app that has the chat open (you were most likely watching); a question there notifies
  if it is still unanswered after those two minutes. Messaging platforms, editors (ACP) and subagents
  never notify. On an iPhone, notifications need the app opened from the Home Screen.
- Model and reasoning effort per chat (never rewrite the profile default), rename, delete. Effort
  runs Off (where the model can skip reasoning), Minimal, Low, Medium, High, Extra High, Max, Ultra;
  a model that tops out lower receives its highest level, and the sheet says so.
- One vocabulary for names (`src/lib/labels.ts`): accounts "Claude 2", providers "Claude 2
  Subscription" / "Anthropic API", models "Opus 5.5" / "GPT-6 Astra", efforts "Extra High". The
  header reads "Claude 2 · Opus 5.5 · High".

## Setup

Copy `.env.example` to `.env.local` and fill it in: the server's ssh host, the public address, the
allowed login and devices, and what the app calls the server. `.env.local` is not committed;
`deploy/deploy.sh` copies it to the server with the app, where `server/server.mjs` reads it. The
build and the tests read it too.

## How it is wired

```
iPhone --https, tailnet only--> tailscale serve :8620 --> unix socket (0700 dir)
       --> server/server.mjs --> Hermes backend on 127.0.0.1:9119 (hermes-dashboard.service)
                                 --> each desktop app backend (hermes serve --ssh-owner-nonce ...)
```

- `server/server.mjs` serves the built app, proxies the few `/api` routes the app uses (adding the
  backend's session token, which never reaches the phone), bridges `/api/ws` (the same JSON-RPC
  gateway the desktop app uses), and adds `/hm/live` (who holds each conversation, from Hermes's
  lease files) and `/hm/share`.
- Notifications: `plugin/hermes_mobile_push`, a Hermes plugin enabled in every profile by
  `deploy/deploy.sh`, reports turns, replies, waits on a person and background tasks over
  `events.sock`, a second socket in the app's 0700 directory, so only this account can send events.
  `server/push.mjs` decides what is worth a notification and sends it by Web Push, encrypted for the
  device (RFC 8291) and signed with this server's own key (RFC 8292, kept owner-only in
  `~/.local/state/hermes-mobile/vapid.json`). The push service (Apple's, for an iPhone) relays only
  ciphertext; the server posts only to known push services.
- Access: requests must come from the app's own page (Origin check: other sites cannot use your
  device's tailnet identity), the `Tailscale-User-Login` must be in `HM_ALLOWED_LOGINS`, **and** the
  device must be in `HM_ALLOWED_DEVICES` (MagicDNS names). Never list the server itself: its other
  accounts (a CI runner, say) would pass as you. With these unset the app admits nobody.
- The app uses the gateway client and wire contract vendored from Hermes (`vendor/hermes-shared`,
  revision in `HERMES_REVISION`).

## Commands

| | |
|---|---|
| `deploy/deploy.sh` | build, copy to the server, (re)start `hermes-mobile.service`, set the tailnet listener, probe |
| `scripts/sync-hermes-shared.sh` | refresh the vendored Hermes client after `hermes update`, then deploy |
| `npm test` | unit tests (transcript mapping, names) |
| `npm run test:e2e` | the app against a stand-in gateway on the live deployment: questions, queued follow-ups, interim and final answers, reclaimed runtimes, skill commands, photo rollback, sends racing a chat switch or a PC turn, reconnects, turns typed on the PC, Stop, file attachments, steering, files in replies |
| `node test/e2e/held-live.mjs "<chat>"`, `autoshare-live.mjs "<chat>"` | live checks against a real older PC window |
| `node test/e2e/attach-live.mjs` | a file attached from the phone and a steer into a running turn, against the real backend in a throwaway chat (deleted after) |
| `node test/e2e/push-live.mjs` | notifications through a real push service (Firefox and Mozilla's): subscribe in the sheet, a test, a reply, quiet while on screen, a question, off; `HM_LIVE_TURN=1` adds a real Hermes turn in a throwaway chat, deleted after |
| `journalctl --user -u hermes-mobile` (server) | server log, including refused devices and hand-offs |

Phone chats run in the Hermes backend on the server, so their tools act on the server. A chat started
on the PC that no window has open continues on that account's PC-window backend (started if needed)
while the PC answers, so its commands still run on the PC; opening it again in a window joins that same
chat. With the PC off it continues on the server, and the chat says so.

## Contributing

Bug reports and small, focused pull requests are welcome; every pull request needs the
maintainer's approval before it merges. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security
problems privately, as described in [SECURITY.md](.github/SECURITY.md).

## License

[MIT](LICENSE). `vendor/hermes-shared` is copied from Hermes Agent and keeps its own
[MIT license](vendor/hermes-shared/LICENSE) (Nous Research).
