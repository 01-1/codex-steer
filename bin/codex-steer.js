#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const VERSION = "0.1.0";
const APP_NAME = "codex-steer";
const COMMAND_NAME = path.basename(process.argv[1] || "cxrun");
const IS_REVIEW = COMMAND_NAME === "cxreview";
let STATE_DIR = process.env.CODEX_STEER_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_NAME);

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  if (IS_REVIEW) {
    out.write(`Usage:
  cxreview <id> [context...]
  cxreview review <id> [--against <branch>] [context...]
  cxreview steer <id> <message...>
  cxreview send <id> <message...>
  cxreview status [id]
  cxreview stop <id>

Examples:
  cxreview my-review
  cxreview review my-review --against main
  cxreview steer my-review "ignore generated files"

The first form starts a Codex app-server review and streams live output to stdout.
The steer/send forms append user input to the active review turn for that id.
If app-server reports that the active review turn is not steerable, cxreview prints
the exact JSON-RPC error.
`);
    process.exit(exitCode);
  }

  out.write(`Usage:
  cxrun <id> <prompt...>
  cxrun <id> -- <prompt...>
  cxrun steer <id> <message...>
  cxrun send <id> <message...>
  cxrun status [id]
  cxrun stop <id>

Examples:
  cxrun fix-tests "fix the failing tests"
  cxrun steer fix-tests "only change the parser"
  printf 'now add tests\\nkeep them focused\\n' | cxrun send fix-tests -

The first form starts a Codex app-server turn and streams live output to stdout.
The steer/send forms append user input to the active turn for that id.
Ids may repeat after a run exits, but not while another run with that id is active.
`);
  process.exit(exitCode);
}

function die(message, code = 1) {
  process.stderr.write(`${APP_NAME}: ${message}\n`);
  process.exit(code);
}

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (process.env.CODEX_STEER_STATE_DIR) throw err;
    STATE_DIR = path.join(os.tmpdir(), `${APP_NAME}-${process.getuid ? process.getuid() : "user"}`);
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

function safeId(id) {
  if (!id || id.startsWith("-")) die("id is required");
  if (!/^[A-Za-z0-9._:@-]+$/.test(id)) {
    die("id may contain only letters, numbers, dot, underscore, colon, at, and dash");
  }
  return id;
}

function statePath(id) {
  return path.join(STATE_DIR, `${safeId(id)}.json`);
}

function lockPath(id) {
  return path.join(STATE_DIR, `${safeId(id)}.lock`);
}

function pidIsAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stateIsActive(state) {
  return state && (state.status === "starting" || state.status === "running" || state.status === "stopping");
}

function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), "utf8"));
  } catch {
    return null;
  }
}

function writeState(id, state) {
  ensureStateDir();
  fs.writeFileSync(statePath(id), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function removeState(id) {
  try {
    fs.unlinkSync(statePath(id));
  } catch {}
  removeLock(id);
}

function removeLock(id) {
  try {
    fs.unlinkSync(lockPath(id));
  } catch {}
}

function acquireRunLock(id) {
  ensureStateDir();
  const existing = readState(id);
  if (stateIsActive(existing) && pidIsAlive(existing.ownerPid)) {
    die(`id "${id}" is already running as pid ${existing.ownerPid}`);
  }
  removeState(id);

  try {
    const fd = fs.openSync(lockPath(id), "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  } catch {
    die(`id "${id}" is already running`);
  }
}

function releaseRunLock(id, fd) {
  try {
    fs.closeSync(fd);
  } catch {}
  removeLock(id);
}

function getPrompt(args, offset) {
  const parts = args.slice(offset);
  if (parts[0] === "--") parts.shift();
  if (parts.length === 0) die("prompt/message is required");
  if (parts.length === 1 && parts[0] === "-") {
    return fs.readFileSync(0, "utf8");
  }
  return parts.join(" ");
}

function codex(args, options = {}) {
  const result = spawnSync("codex", args, {
    stdio: options.stdio || "inherit",
    env: process.env,
  });
  if (result.error) die(`failed to run codex: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

class JsonRpcClient {
  constructor() {
    this.proc = spawn("codex", ["app-server", "proxy"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.buffer = "";

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.proc.on("error", (err) => die(`failed to run codex app-server proxy: ${err.message}`));
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) return;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`${line}\n`);
        continue;
      }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, "id")) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(formatRpcError(msg.error)));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method) {
      const handler = this.handlers.get(msg.method);
      if (handler) handler(msg.params || {});
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  close() {
    this.proc.stdin.end();
  }
}

function formatRpcError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return JSON.stringify(error);
  return JSON.stringify(error);
}

function userInput(text) {
  return [{ type: "text", text }];
}

function outputDelta(params) {
  return params.delta || params.content || params.text || params.chunk || "";
}

function parseReviewArgs(args, offset) {
  const parts = args.slice(offset);
  const target = { type: "uncommittedChanges" };
  const context = [];

  for (let i = 0; i < parts.length; i += 1) {
    const arg = parts[i];
    if (arg === "--") {
      context.push(...parts.slice(i + 1));
      break;
    }
    if (arg === "--against") {
      const branch = parts[i + 1];
      if (!branch || branch.startsWith("-")) die("--against requires a branch");
      target.type = "baseBranch";
      target.branch = branch;
      i += 1;
      continue;
    }
    if (arg.startsWith("--against=")) {
      const branch = arg.slice("--against=".length);
      if (!branch) die("--against requires a branch");
      target.type = "baseBranch";
      target.branch = branch;
      continue;
    }
    context.push(arg);
  }

  if (context.length === 1 && context[0] === "-") {
    return { target, context: fs.readFileSync(0, "utf8") };
  }
  return { target, context: context.join(" ") };
}

async function initialize(client) {
  await client.request("initialize", {
    clientInfo: { name: APP_NAME, title: APP_NAME, version: VERSION },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
}

async function startRun(id, prompt) {
  await startTurn(id, "run", async (client, threadId) => {
    const turn = await client.request("turn/start", {
      threadId,
      input: userInput(prompt),
    });
    return { threadId, turnId: turn.turn.id };
  });
}

async function startReview(id, target, context) {
  await startTurn(id, "review", async (client, threadId) => {
    const review = await client.request("review/start", {
      threadId,
      target,
      delivery: "inline",
    });
    return { threadId: review.reviewThreadId, turnId: review.turn.id };
  }, async (client, started) => {
    if (!context) return;
    try {
      await client.request("turn/steer", {
        threadId: started.threadId,
        expectedTurnId: started.turnId,
        input: userInput(context),
      });
    } catch (err) {
      process.stderr.write(`${APP_NAME}: ${err.message || String(err)}\n`);
    }
  });
}

async function startTurn(id, kind, starter, afterStart = null) {
  const lockFd = acquireRunLock(id);
  const client = new JsonRpcClient();
  let threadId = null;
  let turnId = null;
  let completed = false;
  let exitCode = 0;
  let cleanedUp = false;
  let state = {
    id,
    kind,
    status: "starting",
    ownerPid: process.pid,
    threadId: null,
    turnId: null,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };

  writeState(id, state);

  const updateRunState = (status, extra = {}) => {
    state = {
      ...state,
      status,
      ownerPid: status === "running" || status === "starting" ? process.pid : null,
      threadId,
      turnId,
      endedAt: status === "running" || status === "starting" ? undefined : new Date().toISOString(),
      ...extra,
    };
    writeState(id, state);
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    releaseRunLock(id, lockFd);
    client.close();
  };
  process.on("SIGINT", () => {
    updateRunState("interrupted", { signal: "SIGINT", exitCode: 130 });
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    const current = readState(id);
    const status = current && current.status === "stopping" ? "stopped" : "interrupted";
    updateRunState(status, { signal: "SIGTERM", exitCode: 143 });
    cleanup();
    process.exit(143);
  });

  client.on("item/agentMessage/delta", (p) => {
    if (!threadId || p.threadId === threadId) process.stdout.write(p.delta || "");
  });
  client.on("item/commandExecution/outputDelta", (p) => {
    if (!threadId || p.threadId === threadId) process.stdout.write(outputDelta(p));
  });
  client.on("item/fileChange/outputDelta", (p) => {
    if (!threadId || p.threadId === threadId) process.stdout.write(outputDelta(p));
  });
  client.on("error", (p) => {
    if (!threadId || !p.threadId || p.threadId === threadId) {
      process.stderr.write(`${APP_NAME}: ${p.message || JSON.stringify(p)}\n`);
      exitCode = 1;
    }
  });
  client.on("turn/completed", (p) => {
    if (p.threadId === threadId && (!turnId || !p.turn || p.turn.id === turnId)) {
      completed = true;
      if (!process.stdout.isTTY) process.stdout.write("\n");
      updateRunState("completed", { exitCode });
      cleanup();
      process.exit(exitCode);
    }
  });

  try {
    await initialize(client);
    const thread = await client.request("thread/start", {
      cwd: process.cwd(),
      threadSource: { type: "codex_app_server" },
    });
    threadId = thread.thread.id;

    const started = await starter(client, threadId);
    threadId = started.threadId;
    turnId = started.turnId;
    updateRunState("running");
    if (afterStart) await afterStart(client, started);

    await new Promise((resolve) => client.proc.on("exit", resolve));
  } catch (err) {
    updateRunState("failed", { error: err.message || String(err), exitCode: 1 });
    cleanup();
    throw err;
  }
  if (!completed) {
    updateRunState("exited", { exitCode: exitCode || 1 });
    cleanup();
    process.exit(exitCode || 1);
  }
}

async function steerRun(id, message) {
  const state = readState(id);
  if (!state || state.status !== "running") die(`no running thread for id "${id}"`);
  if (!pidIsAlive(state.ownerPid)) {
    writeState(id, {
      ...state,
      status: "stale",
      ownerPid: null,
      endedAt: new Date().toISOString(),
    });
    die(`stale id "${id}" was marked stale; no running thread remains`);
  }

  const client = new JsonRpcClient();
  await initialize(client);
  await client.request("turn/steer", {
    threadId: state.threadId,
    expectedTurnId: state.turnId,
    input: userInput(message),
  });
  client.close();
}

function status(id) {
  ensureStateDir();
  const ids = id ? [id] : fs.readdirSync(STATE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5));

  let shown = false;
  for (const one of ids) {
    const state = readState(one);
    if (!state) continue;
    if (stateIsActive(state) && !pidIsAlive(state.ownerPid)) {
      state.status = "stale";
      state.ownerPid = null;
      state.endedAt = new Date().toISOString();
      writeState(one, state);
    }
    shown = true;
    const pid = state.ownerPid ? `pid=${state.ownerPid}` : "pid=-";
    process.stdout.write(`${one}\t${state.status}\t${pid}\tthread=${state.threadId || "-"}\tturn=${state.turnId || "-"}\n`);
  }
  if (!shown && id) die(`no state for id "${id}"`, 2);
}

function stop(id) {
  const state = readState(id);
  if (!state) die(`no state for id "${id}"`);
  const stopped = {
    ...state,
    status: "stopped",
    ownerPid: null,
    endedAt: new Date().toISOString(),
  };
  if (pidIsAlive(state.ownerPid)) {
    writeState(id, {
      ...state,
      status: "stopping",
      endedAt: new Date().toISOString(),
    });
    process.kill(state.ownerPid, "SIGTERM");
  }
  writeState(id, stopped);
  removeLock(id);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage(0);
  if (args[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (args[0] === "daemon-start") {
    codex(["app-server", "daemon", "start"]);
    return;
  }
  if (args[0] === "status") {
    status(args[1] ? safeId(args[1]) : null);
    return;
  }
  if (args[0] === "stop") {
    stop(safeId(args[1]));
    return;
  }
  if (args[0] === "steer" || args[0] === "send") {
    await steerRun(safeId(args[1]), getPrompt(args, 2));
    return;
  }

  codex(["app-server", "daemon", "start"]);
  if (IS_REVIEW) {
    const offset = args[0] === "review" ? 2 : 1;
    const id = safeId(args[offset - 1]);
    const review = parseReviewArgs(args, offset);
    await startReview(id, review.target, review.context);
    return;
  }

  await startRun(safeId(args[0]), getPrompt(args, 1));
}

main().catch((err) => die(err.message || String(err)));
