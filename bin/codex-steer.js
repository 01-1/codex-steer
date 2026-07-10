#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const VERSION = require("../package.json").version;
const APP_NAME = "codex-steer";
const COMMAND_NAME = path.basename(process.argv[1] || "cxrun");
const IS_REVIEW = COMMAND_NAME === "cxreview";
const RPC_TIMEOUT_MS = Number(process.env.CODEX_STEER_RPC_TIMEOUT_MS || 30000);
const ENABLE_REMOTE_CONTROL = process.env.CODEX_STEER_ENABLE_REMOTE_CONTROL !== "0";
let STATE_DIR = process.env.CODEX_STEER_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), APP_NAME);

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  if (IS_REVIEW) {
    out.write(`Usage:
  cxreview [--model <model>] <id> [context...]
  cxreview review [--model <model>] <id> [--against <branch>] [context...]
  cxreview steer [--model <model>] <id> <message...>
  cxreview send [--model <model>] <id> <message...>
  cxreview status [id]
  cxreview stop <id>

Examples:
  cxreview my-review
  cxreview review my-review --against main
  cxreview steer my-review "ignore generated files"

The first form starts a Codex app-server review and streams live output to stdout.
The steer/send forms are aliases: they append input to an active review turn or
continue the saved thread when no turn is active.
If app-server reports that the active review turn is not steerable, cxreview prints
the exact JSON-RPC error.
`);
    process.exit(exitCode);
  }

  out.write(`Usage:
  cxrun [--model <model>] <id> <prompt...>
  cxrun [--model <model>] <id> -- <prompt...>
  cxrun steer [--model <model>] <id> <message...>
  cxrun send [--model <model>] <id> <message...>
  cxrun status [id]
  cxrun stop <id>

Examples:
  cxrun fix-tests "fix the failing tests"
  cxrun steer fix-tests "only change the parser"
  printf 'now add tests\\nkeep them focused\\n' | cxrun send fix-tests -

The first form starts a Codex app-server turn and streams live output to stdout.
The steer/send forms are aliases: they append input to an active turn or continue
the saved thread when no turn is active. Ids cannot be reused.
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

function controlPath(id) {
  return path.join(STATE_DIR, `${safeId(id)}.sock`);
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

function removeControlSocket(id) {
  try {
    fs.unlinkSync(controlPath(id));
  } catch {}
}

function acquireRunLock(id) {
  ensureStateDir();
  const existing = readState(id);
  if (existing) {
    if (stateIsActive(existing) && pidIsAlive(existing.ownerPid)) {
      die(`id "${id}" is already running as pid ${existing.ownerPid}`);
    }
    die(`id "${id}" already exists; use "send ${id} <message...>" to continue its thread`);
  }

  try {
    const fd = fs.openSync(lockPath(id), "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    removeControlSocket(id);
    return fd;
  } catch {
    die(`id "${id}" is already running`);
  }
}

function acquireExistingRunLock(id) {
  ensureStateDir();
  removeLock(id);
  removeControlSocket(id);

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

function parseModelOption(args, offset = 0) {
  let model = null;
  let nextOffset = offset;
  const arg = args[nextOffset];

  if (arg === "--model") {
    model = args[nextOffset + 1];
    if (!model || model.startsWith("-")) die("--model requires a model");
    nextOffset += 2;
  } else if (arg && arg.startsWith("--model=")) {
    model = arg.slice("--model=".length);
    if (!model) die("--model requires a model");
    nextOffset += 1;
  }

  return { model, nextOffset };
}

function codex(args, options = {}) {
  const result = spawnSync("codex", args, {
    stdio: options.stdio || "inherit",
    env: process.env,
  });
  if (result.error) die(`failed to run codex: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

function ensureAppServerDaemon() {
  codex(["app-server", "daemon", "start"]);
  if (ENABLE_REMOTE_CONTROL) {
    codex(["app-server", "daemon", "enable-remote-control"]);
  }
}

class JsonRpcClient {
  constructor(model = null) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.spawnServer(model);
  }

  spawnServer(model) {
    const args = ["app-server"];
    if (model) args.push("--config", `model=${JSON.stringify(model)}`);
    args.push("--stdio");
    this.proc = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.buffer = "";

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.proc.on("error", (err) => die(`failed to run codex app-server: ${err.message}`));
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
      clearTimeout(pending.timer);
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method} after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.proc.stdin.end();
    this.proc.kill();
  }

}

function formatRpcError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return JSON.stringify(error);
  return JSON.stringify(error);
}

function userInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function outputDelta(params) {
  return params.delta || params.content || params.text || params.chunk || "";
}

let stdoutEndsWithNewline = true;

function writeStdout(text) {
  if (!text) return;
  process.stdout.write(text);
  stdoutEndsWithNewline = text.endsWith("\n");
}

function ensureStdoutNewline() {
  if (!stdoutEndsWithNewline) writeStdout("\n");
}

function writeStdoutLine(text = "") {
  ensureStdoutNewline();
  writeStdout(`${text}\n`);
}

function outputBase64Delta(params) {
  if (!params.deltaBase64) return "";
  try {
    return Buffer.from(params.deltaBase64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function toolLabel(item) {
  if (!item || !item.type) return null;
  if (item.type === "commandExecution") return `$ ${item.command}`;
  if (item.type === "mcpToolCall") return `tool ${item.server}.${item.tool}`;
  if (item.type === "dynamicToolCall") return `tool ${item.namespace ? `${item.namespace}.` : ""}${item.tool}`;
  if (item.type === "collabAgentToolCall") return `tool ${item.tool}`;
  if (item.type === "webSearch") return `web search ${item.query}`;
  if (item.type === "fileChange") return "file change";
  if (item.type === "sleep") return `sleep ${Math.round((item.durationMs || 0) / 1000)}s`;
  if (item.type === "imageGeneration") return "image generation";
  return null;
}

function toolStatus(item) {
  if (!item || !item.type) return "";
  if (item.type === "commandExecution" && item.exitCode !== null && item.exitCode !== undefined) {
    return `exit ${item.exitCode}`;
  }
  if (item.status) return String(item.status);
  if (item.type === "dynamicToolCall" && item.success !== null && item.success !== undefined) {
    return item.success ? "success" : "failed";
  }
  return "done";
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

function readJsonLine(socket, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for local control response after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("local control socket closed"));
    };
    const onData = (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffer.slice(0, idx)));
      } catch (err) {
        reject(err);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}

function startControlServer(id, handleMessage) {
  removeControlSocket(id);
  const server = net.createServer((socket) => {
    readJsonLine(socket).then(async (request) => {
      try {
        const result = await handleMessage(request);
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (err) {
        socket.end(`${JSON.stringify({ ok: false, error: err.message || String(err) })}\n`);
      }
    }).catch((err) => {
      socket.end(`${JSON.stringify({ ok: false, error: err.message || String(err) })}\n`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlPath(id), () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function startRun(id, prompt, model) {
  await startTurn(id, "run", async (client, threadId) => {
    const turn = await client.request("turn/start", {
      threadId,
      input: userInput(prompt),
    });
    return { threadId, turnId: turn.turn.id };
  }, null, { model });
}

async function sendRun(id, message, model = null) {
  const state = readState(id);
  if (!state) die(`no state for id "${id}"`);
  if (state.status === "running" && pidIsAlive(state.ownerPid)) {
    await sendToActiveRun(id, message, model);
    return;
  }
  if (state.status === "running") {
    state.status = "stale";
    state.ownerPid = null;
    state.endedAt = new Date().toISOString();
    writeState(id, state);
  }
  if (stateIsActive(state) && pidIsAlive(state.ownerPid)) {
    die(`id "${id}" is already running as pid ${state.ownerPid}`);
  }
  if (!state.threadId) {
    die(`id "${id}" has no saved threadId to continue`);
  }

  const effectiveModel = model || state.model || null;
  await startTurn(id, state.kind || "run", async (client, threadId) => {
    const turn = await client.request("turn/start", {
      threadId,
      input: userInput(message),
      ...(effectiveModel ? { model: effectiveModel } : {}),
    });
    return { threadId, turnId: turn.turn.id };
  }, null, { existingState: state, resumeThreadId: state.threadId, model: effectiveModel });
}

async function startReview(id, target, context, model) {
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
  }, { model });
}

async function startTurn(id, kind, starter, afterStart = null, options = {}) {
  const lockFd = options.existingState ? acquireExistingRunLock(id) : acquireRunLock(id);
  const client = new JsonRpcClient(options.model || null);
  let threadId = null;
  let turnId = null;
  let controlServer = null;
  const streamedOutputItemIds = new Set();
  let completed = false;
  let exitCode = 0;
  let cleanedUp = false;
  let state = options.existingState ? {
    ...options.existingState,
    id,
    kind,
    status: "starting",
    ownerPid: process.pid,
    previousTurnId: options.existingState.turnId || null,
    controlSocket: controlPath(id),
    cwd: process.cwd(),
    model: options.model || null,
    startedAt: new Date().toISOString(),
    endedAt: undefined,
  } : {
    id,
    kind,
    status: "starting",
    ownerPid: process.pid,
    threadId: null,
    turnId: null,
    controlSocket: controlPath(id),
    cwd: process.cwd(),
    model: options.model || null,
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
    if (controlServer) {
      controlServer.close();
      controlServer = null;
    }
    removeControlSocket(id);
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
    const status = current && (current.status === "stopping" || current.status === "stopped") ? "stopped" : "interrupted";
    updateRunState(status, { signal: "SIGTERM", exitCode: 143 });
    cleanup();
    process.exit(143);
  });

  client.on("item/agentMessage/delta", (p) => {
    if (!threadId || p.threadId === threadId) writeStdout(p.delta || "");
  });
  client.on("item/started", (p) => {
    if (threadId && p.threadId !== threadId) return;
    const label = toolLabel(p.item);
    if (label) writeStdoutLine(`> ${label}`);
  });
  client.on("item/completed", (p) => {
    if (threadId && p.threadId !== threadId) return;
    const label = toolLabel(p.item);
    if (p.item && p.item.type === "commandExecution" && p.item.aggregatedOutput && !streamedOutputItemIds.has(p.item.id)) {
      ensureStdoutNewline();
      writeStdout(p.item.aggregatedOutput);
      ensureStdoutNewline();
    }
    if (label) writeStdoutLine(`< ${label} (${toolStatus(p.item)})`);
  });
  client.on("item/commandExecution/outputDelta", (p) => {
    if (!threadId || p.threadId === threadId) {
      if (p.itemId) streamedOutputItemIds.add(p.itemId);
      writeStdout(outputDelta(p));
    }
  });
  client.on("item/fileChange/outputDelta", (p) => {
    if (!threadId || p.threadId === threadId) writeStdout(outputDelta(p));
  });
  client.on("command/exec/outputDelta", (p) => {
    writeStdout(outputBase64Delta(p));
  });
  client.on("process/outputDelta", (p) => {
    writeStdout(outputBase64Delta(p));
  });
  client.on("item/mcpToolCall/progress", (p) => {
    if (!threadId || p.threadId === threadId) writeStdoutLine(`> ${p.message}`);
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
      ensureStdoutNewline();
      updateRunState("completed", { exitCode });
      cleanup();
      process.exit(exitCode);
    }
  });

  try {
    await initialize(client);
    const thread = options.resumeThreadId ?
      await client.request("thread/resume", {
        threadId: options.resumeThreadId,
        cwd: process.cwd(),
      }) :
      await client.request("thread/start", {
        cwd: process.cwd(),
        threadSource: "codex_app_server",
      });
    threadId = thread.thread.id;

    const started = await starter(client, threadId);
    threadId = started.threadId;
    turnId = started.turnId;
    controlServer = await startControlServer(id, async (request) => {
      if (!request || (request.method !== "turn/steer" && request.method !== "turn/send")) {
        throw new Error("unsupported local control request");
      }
      if (request.model) {
        await client.request("thread/settings/update", {
          threadId,
          model: request.model,
        });
        updateRunState("running", { model: request.model });
      }
      await client.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: userInput(request.message || ""),
      });
      return {};
    });
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

async function sendToActiveRun(id, message, model = null) {
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

  const socketPath = state.controlSocket || controlPath(id);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to local control socket after ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);
    socket.once("connect", async () => {
      clearTimeout(timer);
      socket.write(`${JSON.stringify({ method: "turn/steer", message, model })}\n`);
      try {
        const response = await readJsonLine(socket);
        socket.end();
        if (!response.ok) reject(new Error(response.error || "local control request failed"));
        else resolve();
      } catch (err) {
        reject(err);
      }
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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
    ensureAppServerDaemon();
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
  if (args[0] === "steer") {
    const parsed = parseModelOption(args, 1);
    await sendRun(
      safeId(args[parsed.nextOffset]),
      getPrompt(args, parsed.nextOffset + 1),
      parsed.model,
    );
    return;
  }
  if (args[0] === "send") {
    const parsed = parseModelOption(args, 1);
    await sendRun(
      safeId(args[parsed.nextOffset]),
      getPrompt(args, parsed.nextOffset + 1),
      parsed.model,
    );
    return;
  }

  if (IS_REVIEW) {
    const optionOffset = args[0] === "review" ? 1 : 0;
    const parsed = parseModelOption(args, optionOffset);
    const id = safeId(args[parsed.nextOffset]);
    const review = parseReviewArgs(args, parsed.nextOffset + 1);
    await startReview(id, review.target, review.context, parsed.model);
    return;
  }

  const parsed = parseModelOption(args);
  await startRun(safeId(args[parsed.nextOffset]), getPrompt(args, parsed.nextOffset + 1), parsed.model);
}

main().catch((err) => die(err.message || String(err)));
