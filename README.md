# codex-steer

Tiny wrapper around `codex app-server` for the workflow `codex exec` does not cover:

1. Start a long-running Codex turn from one command.
2. Stream live agent output to stdout.
3. Send follow-up steering messages from another command using a friendly id.

It uses Codex's app-server daemon and the real `turn/steer` API.

## Install

```sh
npm install -g codex-steer
```

Or from a checkout:

```sh
npm link
```

## Usage

Start a run:

```sh
cxrun fix-tests "fix the failing tests"
```

Send a message while that turn is still running:

```sh
cxrun steer fix-tests "only change the parser"
```

Read a multiline prompt or steering message from stdin:

```sh
cat prompt.txt | cxrun refactor -
printf 'stop broad refactors\nfocus on auth only\n' | cxrun send refactor -
```

Inspect or stop active ids:

```sh
cxrun status
cxrun stop fix-tests
```

Ids may be reused after a run exits. The wrapper prevents the same id from being used by two running turns at once.

## Notes

- Requires `codex` on `PATH`.
- Uses `codex app-server daemon start`, so run it with your normal Codex home/install.
- Requires Node.js 18 or newer.
- `cxrun <id> <prompt...>` streams assistant message deltas and selected command/file output deltas to stdout.
- `cxrun steer <id> <message...>` exits after the steering message has been accepted by app-server.
- State is stored in `${XDG_STATE_HOME:-~/.local/state}/codex-steer`. Set `CODEX_STEER_STATE_DIR` to override it.
