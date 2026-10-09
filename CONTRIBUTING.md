# Contributing

## Before you start

Bug reports and pull requests are welcome. Every pull request is reviewed by the maintainer, and
nothing merges into `main` without that approval. Opening one does not mean it will be merged.

Ideas and feature requests belong in [Discussions](https://github.com/derektrimm/hermes-mobile/discussions/categories/ideas).
Issues are for bugs.

## What is most likely to be merged

- Small, focused bug fixes.
- Reliability fixes for connecting, reconnecting and co-driving a chat with the desktop app or a PC window.
- Fixes for iOS Safari home-screen behaviour (keyboard, safe areas, gestures).
- Small accessibility improvements.

Large pull requests, new features nobody asked for, and rewrites are unlikely to be merged. If you
are planning something bigger than a bug fix, start a discussion first.

## Opening a pull request

- Keep it to one change. Do not mix unrelated fixes.
- Say what changed and why.
- For anything visible, include before and after screenshots from a phone-sized screen. For motion
  or interaction, include a short video.
- Run `npx tsc -b` and `npm test`. If you have a Hermes server to test against, also run
  `npm run test:e2e` (see `.env.example` for the settings the tests read).
- Do not commit `.env.local` or anything with your own addresses, logins or tokens.

Checks run automatically on pull requests from branches in this repository. For pull requests from
forks, the maintainer runs them before merging.

## Development

The app runs behind its own small server (`server/server.mjs`), next to a Hermes backend, exposed
to your devices with `tailscale serve`. `deploy/deploy.sh` builds the app and sets all of that up on
your server.

```
npm ci
cp .env.example .env.local   # your server, address, login and devices
npx tsc -b && npm test       # type check and unit tests
deploy/deploy.sh             # build and install on your server
npm run test:e2e             # the deployed app against a stand-in Hermes gateway
```

The app talks to Hermes through the gateway client vendored in `vendor/hermes-shared` (MIT, Nous
Research). `scripts/sync-hermes-shared.sh` refreshes it from the Hermes checkout the server runs.
