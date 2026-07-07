# codex-steer

Tiny wrapper around `codex app-server` for the workflow `codex exec` does not cover:

1. Start a long-running Codex turn from one command.
2. Stream live agent output to stdout.
3. Send follow-up steering messages from another command using a friendly id.
4. Start a Codex review through `review/start` and try steering it by id.

It uses Codex's app-server stdio transport and the real `turn/steer` and `review/start` APIs.

## Install

```sh
npm install -g codex-steer
```

Or from a checkout:

```sh
npm link
```

Or directly from GitHub:

```sh
npm install -g github:01-1/codex-steer
```

For an SSH-only setup, use the full Git URL:

```sh
npm install -g git+ssh://git@github.com/01-1/codex-steer.git
```

## Usage

Start a run:

```sh
cxrun fix-tests "fix the failing tests"
```

Steer the active turn while it is still running:

```sh
cxrun steer fix-tests "only change the parser"
```

Send a new message to the saved thread after the active turn has completed:

```sh
cxrun send fix-tests "now add the regression test"
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

Ids cannot be reused. Use `cxrun send <id> <message...>` to continue a saved thread instead of starting a new run with the same id.
Completed, interrupted, stopped, failed, and stale runs leave a small state file with the last known `threadId` and `turnId`, so `cxrun send <id> <message...>` can continue the thread after the process is gone.

## Reviews

Start a review of uncommitted changes:

```sh
cxreview my-review
```

Review against a base branch:

```sh
cxreview review my-review --against main
```

Send steering while the review is still running:

```sh
cxreview steer my-review "ignore generated files"
```

Optional context after the id is sent as an immediate steering message after `review/start`:

```sh
cxreview my-review "focus on security and tests"
```

Some Codex review turns may reject steering with `activeTurnNotSteerable`. When that happens, `cxreview` prints the exact JSON-RPC error returned by app-server.

## Publishing

Validate the package:

```sh
npm test
npm pack --dry-run
```

Publish the current version:

```sh
npm login
npm publish
```

For later releases, bump the version first:

```sh
npm version patch
npm publish
```

## Notes

- Requires `codex` on `PATH`.
- Uses `codex app-server --stdio` for runs and reviews. While a run is active, `cxrun steer`/`cxrun send` talk to that wrapper process through a local socket in the state directory. After a run exits, `cxrun send` resumes the saved thread and starts a new turn.
- `cxrun daemon-start` runs `codex app-server daemon start` and enables app-server remote control for users who want the Codex-managed daemon separately.
- Requires Node.js 18 or newer.
- `cxrun <id> <prompt...>` streams assistant message deltas and selected command/file output deltas to stdout.
- `cxrun steer <id> <message...>` exits after the steering message has been accepted by an active app-server turn.
- `cxreview <id>` streams review output from Codex's `review/start` app-server method.
- State and run history pointers are stored in `${XDG_STATE_HOME:-~/.local/state}/codex-steer`. Set `CODEX_STEER_STATE_DIR` to override it.
- Set `CODEX_STEER_ENABLE_REMOTE_CONTROL=0` to skip `codex app-server daemon enable-remote-control` when using `cxrun daemon-start`.
