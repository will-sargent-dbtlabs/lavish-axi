import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import chokidar from "chokidar";
import express from "express";

import {
  createArtifactSdk,
  deriveLavishQueueKey,
  isNativeInteractiveControl,
  resolveDiffLine,
} from "./artifact-sdk.js";
import { CHROME_THEMES, DEFAULT_CHROME_THEME, isValidChromeTheme, resolveChromeTheme } from "./chrome-themes.js";
import { injectLavishSdk, injectPrintScript } from "./html-transform.js";
import { bindHost, hostForUrl, linkHost } from "./paths.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

// A detached server should not live forever. When no browser chrome (SSE) and no agent poll
// are connected for this long, the server shuts itself down so it stops dangling. The next
// `lavish-axi <file>` invocation re-spawns a fresh server and adopts the session from
// state.json. Set LAVISH_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond
// budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.LAVISH_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return value;
}

export async function serve({
  port,
  stateFile,
  version = "",
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(),
  linkHost: linkHostName = linkHost(),
}) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const sseClients = new Set();
  const verbose = debug || process.env.LAVISH_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[lavish] ${line}`) : null;
  let publicPort = port;

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "lavish-axi", version });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(shutdown);
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const sessionUrl = `http://${hostForUrl(linkHostName)}:${publicPort}/session/${key}`;
      let url = shouldDisableLayoutGateOpen(req.body || {}) ? appendNoGateParam(sessionUrl) : sessionUrl;
      const annotateFlag = (req.body || {}).annotate;
      if (isTruthyFlag(annotateFlag)) url = appendAnnotateParam(url, "1");
      else if (isFalseyFlag(annotateFlag)) url = appendAnnotateParam(url, "0");
      const themeFlag = (req.body || {}).theme;
      if (typeof themeFlag === "string" && isValidChromeTheme(themeFlag)) url = appendThemeParam(url, themeFlag);
      const existing = await store.findByKey(key);
      const session = await store.upsertSession(file, sessionUrl);
      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key} file=${file}`);
      await watchSession(session, watchers, events, logEvent);
      res.json({ key, file, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/poll", async (req, res, next) => {
    try {
      const file = await canonicalFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (immediate.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
        res.json(immediate);
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      setPollActive(key, activePolls, deliveredFeedback, events, true);
      refreshIdleTimer();
      const timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, deliveredFeedback, events, false);
        refreshIdleTimer();
      };
      const respond = async () => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const result = await store.takeFeedback(key);
          if (result.status === "feedback") markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
          if (streamHeartbeat) {
            res.end(JSON.stringify(result));
          } else {
            res.json(result);
          }
        } finally {
          cleanup();
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) {
          return;
        }
        respond().catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("feedback", req.params.key);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const result = await store.recordLayoutWarnings(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.changed && result.hasWarnings) {
        events.emit("feedback", req.params.key);
      }
      res.json({ status: "recorded", layout_warnings: result.session.layout_warnings?.length || 0 });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key);
      clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      events.emit("ended", req.params.key);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      await store.endSession(key);
      clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      events.emit("ended", key);
      res.json({ status: "ended" });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      await watchSession(session, watchers, events, logEvent);
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          annotate: shouldEnableAnnotate(req.query || {}),
          theme: resolveChromeTheme(req.query || {}),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectLavishSdk(html, key));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/print/:key", (req, res) => {
    res.redirect(`/print/${req.params.key}/index.html`);
  });

  app.get(/^\/print\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectPrintScript(html));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/print\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.add(res);
      refreshIdleTimer();
      const session = await store.findByKey(req.params.key);
      const sendReload = (key) => {
        if (key === req.params.key) {
          res.write("event: reload\ndata: {}\n\n");
        }
      };
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) {
          res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
        }
      };
      const sendPresence = (key, state) => {
        if (key === req.params.key) {
          res.write(`event: agent-presence\ndata: ${JSON.stringify({ state })}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(
        `event: agent-presence\ndata: ${JSON.stringify({ state: computePresence(req.params.key, activePolls, deliveredFeedback) })}\n\n`,
      );
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-presence", sendPresence);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-presence", sendPresence);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", (req, res) => {
    res.type("application/javascript").send(createSdkJs(String(req.query.key || "")));
  });

  app.use((error, req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => {
      if (s.address()) resolve(s);
    });
    s.once("error", reject);
  });
  publicPort = httpServer.address().port;

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // Tell open browser chromes to reload before we drop their SSE connection. The new
    // server adopts the session via state.json once it binds, so the reloaded chrome
    // immediately gets the upgraded HTML/CSS/JS.
    for (const res of sseClients) {
      try {
        res.write("event: chrome-reload\ndata: {}\n\n");
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    httpServer.close(() => shutdownResolve());
    // Force-close keep-alive sockets so SSE / long-polls don't keep us alive.
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
  }

  // Idle self-shutdown: the timer only runs while nothing is connected. Any live SSE chrome or
  // active long-poll cancels it; losing the last connection (re)arms it.
  let idleTimer = null;
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0 || activePolls.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && sseClients.size === 0 && activePolls.size === 0) {
        logEvent?.(`idle for ${idleTimeoutMs}ms with no connections, shutting down`);
        shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // When the final open session ends with nothing connected, there is nothing left to serve,
  // so step down immediately rather than waiting out the idle timeout. If a browser chrome or
  // poll is still attached (e.g. the user is about to reopen), leave the server up and let the
  // idle timer reap it once those connections drop. Best-effort: never let a read failure
  // block the end response.
  async function shutdownIfNoLiveSessions() {
    if (sseClients.size > 0 || activePolls.size > 0) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        logEvent?.("last open session ended with no live connections, shutting down");
        setImmediate(shutdown);
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  // Arm the idle timer for a server that is spawned but never opens a session.
  refreshIdleTimer();

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

async function watchSession(session, watchers, events, logEvent) {
  if (watchers.has(session.key)) {
    return;
  }
  const target = await resolveWatchTarget(session);
  if (watchers.has(session.key)) {
    return;
  }
  logEvent?.(`watch session=${session.key} scope=${target.scope} path=${target.path}`);
  const watcher = chokidar.watch(target.path, target.options);
  let timer = null;
  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), 100);
  });
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logEvent?.(`watch error session=${session.key} message=${message}`);
  });
  watchers.set(session.key, watcher);
}

// Watching the artifact's parent directory recursively can stall the event loop when the
// artifact lives in a large tree (e.g. ~/Downloads). Default to watching only the artifact
// itself; an artifact opts back into directory-wide live reload via either a
// `data-lavish-live-reload-root` attribute on its root element or
// `<meta name="lavish-live-reload" content="root">`.
export async function resolveWatchTarget(session) {
  const baseOptions = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  };
  try {
    const html = await readFile(session.file, "utf8");
    if (hasLiveReloadRootOptIn(html)) {
      return {
        path: path.dirname(session.file),
        scope: "directory",
        options: {
          ...baseOptions,
          ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
        },
      };
    }
  } catch {
    // Fall through to file-only watching when the artifact can't be read.
  }
  return { path: session.file, scope: "file", options: baseOptions };
}

export function hasLiveReloadRootOptIn(html) {
  if (typeof html !== "string") return false;
  const searchableHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<html\b[^>]*\sdata-lavish-live-reload-root(?:[\s=>/]|$)[^>]*>/i.test(searchableHtml)) return true;
  return /<meta\b(?=[^>]*name=["']lavish-live-reload["'])(?=[^>]*content=["']root["'])[^>]*>/i.test(searchableHtml);
}

function setPollActive(key, activePolls, deliveredFeedback, events, active) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
    deliveredFeedback.delete(key);
  }
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", key, nextPresence);
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (activePolls.has(key)) return "listening";
  if (deliveredFeedback.has(key)) return "working";
  return "waiting";
}

function chromeIcon(paths, size = 16, strokeWidth = 1.7) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const chromeIcons = {
  more: chromeIcon(
    '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  ),
  file: chromeIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    13,
  ),
  copy: chromeIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    12,
  ),
  check: chromeIcon('<polyline points="20 6 9 17 4 12"/>', 12),
  refresh: chromeIcon(
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    15,
  ),
  camera: chromeIcon(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    15,
  ),
  printer: chromeIcon(
    '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    15,
  ),
  exit: chromeIcon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    15,
  ),
  send: chromeIcon('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>', 14),
  caret: chromeIcon('<path d="m6 9 6 6 6-6"/>', 13, 2),
};

// Display the path with the home directory shortened to "~", split so the directory part can
// ellipsize in the menu while the file name itself always stays visible.
export function displayPathParts(file, home = homedir()) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  const display =
    normalizedHome && normalizedFile.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedFile.slice(normalizedHome.length + 1)}`
      : normalizedFile;
  const tailStart = display.lastIndexOf("/") + 1;
  return { head: display.slice(0, tailStart), tail: display.slice(tailStart) };
}

export function shouldEnableLayoutGate(query = {}) {
  const noGate = query["no-gate"] ?? query.noGate ?? query.no_gate;
  if (isTruthyFlag(noGate)) return false;

  const gate = query.gate ?? query.layoutGate ?? query.layout_gate;
  if (isFalseyFlag(gate)) return false;

  return true;
}

function shouldDisableLayoutGateOpen(body = {}) {
  const noGate = body["no-gate"] ?? body.noGate ?? body.no_gate;
  if (isTruthyFlag(noGate)) return true;

  const gate = body.gate ?? body.layoutGate ?? body.layout_gate;
  return isFalseyFlag(gate);
}

function appendNoGateParam(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("no-gate", "1");
  return parsed.toString();
}

export function shouldEnableAnnotate(query = {}, env = process.env) {
  const flag = query.annotate ?? query.annotation;
  if (isTruthyFlag(flag)) return true;
  if (isFalseyFlag(flag)) return false;

  const envFlag = env?.LAVISH_AXI_ANNOTATE;
  if (isTruthyFlag(envFlag)) return true;
  if (isFalseyFlag(envFlag)) return false;

  return false;
}

function appendAnnotateParam(url, value) {
  const parsed = new URL(url);
  parsed.searchParams.set("annotate", value);
  return parsed.toString();
}

function appendThemeParam(url, value) {
  const parsed = new URL(url);
  parsed.searchParams.set("theme", value);
  return parsed.toString();
}

function isTruthyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalseyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function normalizeFlagValue(value) {
  if (Array.isArray(value)) return normalizeFlagValue(value[0]);
  return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

export function createChromeHtml(
  session,
  { layoutGateEnabled = true, annotate = false, theme = DEFAULT_CHROME_THEME } = {},
) {
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    initialChat: session.chat || [],
    layoutGateEnabled,
    annotate,
    theme,
  });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const bodyClass = layoutGateEnabled ? "lavish layout-gate-active" : "lavish";
  const layoutGateHidden = layoutGateEnabled ? "" : " hidden";
  const themeSwatchesHtml = CHROME_THEMES.map(
    (t) =>
      `<button class="theme-swatch" id="theme-${t.id}" type="button" data-theme-value="${t.id}" aria-pressed="${t.id === theme ? "true" : "false"}"><span class="swatch-dot" data-swatch="${t.id}"></span><span>${escapeHtml(t.label)}</span></button>`,
  ).join("");
  const cobrandPill = `<span class="cobrand" role="img" aria-label="Fivetran + dbt Labs"><svg class="cb-white" aria-hidden="true" focusable="false" viewBox="0 0 127 62" fill="none" xmlns="http://www.w3.org/2000/svg"> <rect x="1.24651" y="1.24651" width="123.819" height="59.3068" rx="29.6534" stroke="white" stroke-width="2.49301"/> <g clip-path="url(#clip0_930_9056)"> <path d="M106.263 41.134C105.86 41.134 105.581 40.8494 105.581 40.4459C105.581 40.0449 105.863 39.7578 106.263 39.7578C106.663 39.7578 106.945 40.0449 106.945 40.4459C106.945 40.8494 106.666 41.134 106.263 41.134ZM106.263 41.0128C106.589 41.0128 106.809 40.7727 106.809 40.4459C106.809 40.1192 106.589 39.8816 106.263 39.8816C105.937 39.8816 105.717 40.1192 105.717 40.4459C105.717 40.7727 105.937 41.0128 106.263 41.0128ZM106.036 40.785V40.0969H106.31C106.453 40.0969 106.527 40.1786 106.527 40.2999C106.527 40.4113 106.453 40.4905 106.337 40.4905H106.332L106.57 40.7826V40.785H106.406L106.167 40.4831H106.164V40.785H106.036ZM106.164 40.3989H106.293C106.359 40.3989 106.397 40.3593 106.397 40.3024C106.397 40.2479 106.357 40.2108 106.293 40.2108H106.164V40.3989Z" fill="white"/> <path d="M100.356 16.887C101.651 16.1376 103.045 16.7371 104.09 17.7862C105.185 18.8853 105.633 20.0844 104.936 21.4333C104.688 21.9329 101.75 27.0287 100.854 28.4775C100.356 29.2769 100.107 30.2761 100.107 31.2253C100.107 32.1745 100.356 33.1737 100.854 34.023C101.75 35.4219 104.688 40.5677 104.936 41.0673C105.633 42.4662 105.136 43.5153 104.14 44.6144C102.995 45.7635 101.85 46.363 100.456 45.6136C99.9581 45.3138 86.0189 37.2704 86.0189 37.2704C86.2678 38.919 87.1639 40.4178 88.3089 41.3171C88.1596 41.367 81.2659 45.3626 80.7917 45.6136C79.4849 46.3054 78.2932 45.8429 77.2571 44.8642C76.0871 43.7591 75.5147 42.4662 76.2614 41.1173C76.5104 40.6177 79.4475 35.4718 80.2939 34.073C80.7917 33.2237 81.0904 32.2744 81.0904 31.2753C81.0904 30.2761 80.7917 29.3268 80.2939 28.5275C79.4475 27.0287 76.5104 21.8329 76.2614 21.3833C75.5147 20.0344 76.1142 18.5855 77.1575 17.6363C78.3402 16.5605 79.4475 16.2375 80.7917 16.887C81.19 17.0368 95.0794 25.2801 95.0794 25.2801C94.9301 23.6814 94.1335 22.2326 92.8392 21.2334C92.9387 21.1835 99.8586 17.0868 100.356 16.887ZM91.0968 33.7233L93.0881 31.7249C93.337 31.4751 93.337 31.0754 93.0881 30.7757L91.0968 28.7773C90.7981 28.4775 90.3998 28.4775 90.1011 28.7773L88.1098 30.7757C87.8609 31.0255 87.8609 31.4751 88.1098 31.7249L90.1011 33.7233C90.35 33.9731 90.7981 33.9731 91.0968 33.7233Z" fill="white"/> </g> <g clip-path="url(#clip1_930_9056)"> <path d="M39.9744 30.917H43.2497C43.3791 30.917 43.5033 30.8657 43.5948 30.7744C43.6864 30.6831 43.7378 30.5593 43.7378 30.4302C43.7375 30.3634 43.7243 30.2972 43.6987 30.2354L38.0659 14.9448C38.0312 14.8549 37.9704 14.7773 37.8913 14.7218C37.8122 14.6663 37.7184 14.6355 37.6217 14.6333H34.3367C34.2073 14.6333 34.0831 14.6846 33.9916 14.7759C33.9001 14.8672 33.8486 14.991 33.8486 15.1201C33.8487 15.1766 33.8586 15.2326 33.8779 15.2856L39.5156 30.6152C39.5529 30.7056 39.6165 30.7828 39.6984 30.8366C39.7802 30.8904 39.8764 30.9184 39.9744 30.917Z" fill="white"/> <path d="M39.3943 47.1665H42.6695C42.799 47.1665 42.9231 47.1152 43.0146 47.0239C43.1062 46.9326 43.1576 46.8088 43.1576 46.6797C43.1575 46.6233 43.1476 46.5672 43.1283 46.5142L31.5161 14.9545C31.481 14.8638 31.4195 14.7856 31.3395 14.7301C31.2594 14.6746 31.1646 14.6442 31.0671 14.6429H27.7967C27.6673 14.6429 27.5431 14.6942 27.4516 14.7855C27.36 14.8768 27.3086 15.0006 27.3086 15.1298C27.3087 15.1862 27.3186 15.2422 27.3379 15.2953L38.9501 46.8598C38.9856 46.9489 39.0467 47.0255 39.1257 47.0801C39.2048 47.1346 39.2982 47.1647 39.3943 47.1665Z" fill="white"/> <path d="M32.9413 47.1666H36.2116C36.3346 47.167 36.4532 47.1211 36.5436 47.0381C36.6341 46.955 36.6899 46.841 36.6997 46.7188C36.6995 46.6544 36.6897 46.5904 36.6704 46.5289L31.0181 31.2237C30.9833 31.1337 30.9225 31.0561 30.8435 31.0006C30.7644 30.9451 30.6705 30.9143 30.5739 30.9121H27.284C27.1597 30.9196 27.0429 30.9741 26.9577 31.0646C26.8724 31.1551 26.825 31.2747 26.8252 31.3989C26.825 31.4522 26.835 31.5051 26.8545 31.5547L32.4824 46.8648C32.5197 46.9552 32.5833 47.0324 32.6652 47.0862C32.747 47.1401 32.8432 47.1681 32.9413 47.1666Z" fill="white"/> <path d="M40.3701 15.3001L43.0108 22.4611C43.0456 22.551 43.1064 22.6287 43.1854 22.6841C43.2645 22.7396 43.3583 22.7704 43.455 22.7726H46.7156C46.845 22.7726 46.9692 22.7213 47.0607 22.63C47.1523 22.5387 47.2037 22.4149 47.2037 22.2858C47.2036 22.2294 47.1937 22.1734 47.1744 22.1203L44.5337 14.9545C44.499 14.8645 44.4382 14.7869 44.3591 14.7314C44.28 14.676 44.1862 14.6452 44.0895 14.6429H40.8143C40.6848 14.6429 40.5607 14.6942 40.4691 14.7855C40.3776 14.8768 40.3262 15.0006 40.3262 15.1298C40.3303 15.1887 40.3452 15.2465 40.3701 15.3001Z" fill="white"/> <path d="M26.9032 47.1666H30.1736C30.303 47.1666 30.4272 47.1153 30.5187 47.024C30.6102 46.9327 30.6617 46.8089 30.6617 46.6798C30.6616 46.6234 30.6517 46.5673 30.6324 46.5143L27.9771 39.3339C27.942 39.2432 27.8805 39.165 27.8004 39.1095C27.7204 39.054 27.6255 39.0236 27.528 39.0223H24.2625C24.1331 39.0223 24.0089 39.0736 23.9174 39.1649C23.8258 39.2562 23.7744 39.38 23.7744 39.5091C23.7746 39.5672 23.7845 39.6247 23.8037 39.6795L26.4444 46.8599C26.4808 46.9513 26.5442 47.0295 26.6261 47.0842C26.708 47.139 26.8046 47.1677 26.9032 47.1666Z" fill="white"/> </g> <path d="M61.9834 30.2819H66.5967V32.0563H61.9834V36.6676H60.209V32.0563H55.7607V30.2819H60.209V25.8317H61.9834V30.2819Z" fill="white"/> <defs> <clipPath id="clip0_930_9056"> <rect width="31.6621" height="29.3932" fill="white" transform="translate(75.9287 16.5521)"/> </clipPath> <clipPath id="clip1_930_9056"> <rect width="32.6206" height="32.5333" fill="white" transform="translate(18.8809 14.6333)"/> </clipPath> </defs> </svg><svg class="cb-color" aria-hidden="true" focusable="false" viewBox="0 0 127 62" fill="none" xmlns="http://www.w3.org/2000/svg"> <rect x="1.24651" y="1.24651" width="123.819" height="59.3068" rx="29.6534" stroke="url(#paint0_linear_930_9075)" stroke-width="2.49301"/> <g clip-path="url(#clip0_930_9075)"> <path d="M106.263 41.1341C105.86 41.1341 105.581 40.8495 105.581 40.446C105.581 40.045 105.863 39.7579 106.263 39.7579C106.663 39.7579 106.945 40.045 106.945 40.446C106.945 40.8495 106.666 41.1341 106.263 41.1341ZM106.263 41.0128C106.589 41.0128 106.809 40.7727 106.809 40.446C106.809 40.1193 106.589 39.8816 106.263 39.8816C105.937 39.8816 105.717 40.1193 105.717 40.446C105.717 40.7727 105.937 41.0128 106.263 41.0128ZM106.036 40.7851V40.097H106.31C106.453 40.097 106.527 40.1787 106.527 40.2999C106.527 40.4113 106.453 40.4905 106.337 40.4905H106.332L106.57 40.7826V40.7851H106.406L106.167 40.4831H106.164V40.7851H106.036ZM106.164 40.399H106.293C106.359 40.399 106.397 40.3594 106.397 40.3024C106.397 40.248 106.357 40.2108 106.293 40.2108H106.164V40.399Z" fill="black"/> <path d="M100.356 16.887C101.651 16.1376 103.045 16.7371 104.09 17.7863C105.185 18.8854 105.633 20.0844 104.936 21.4333C104.688 21.9329 101.75 27.0288 100.854 28.4776C100.356 29.2769 100.107 30.2761 100.107 31.2254C100.107 32.1746 100.356 33.1738 100.854 34.0231C101.75 35.4219 104.688 40.5678 104.936 41.0674C105.633 42.4662 105.136 43.5154 104.14 44.6145C102.995 45.7635 101.85 46.363 100.456 45.6137C99.9581 45.3139 86.0189 37.2704 86.0189 37.2704C86.2678 38.9191 87.1639 40.4179 88.3089 41.3172C88.1596 41.3671 81.2659 45.3626 80.7917 45.6137C79.4849 46.3055 78.2932 45.8429 77.2571 44.8643C76.0871 43.7591 75.5147 42.4662 76.2614 41.1173C76.5104 40.6177 79.4475 35.4719 80.2939 34.073C80.7917 33.2237 81.0904 32.2745 81.0904 31.2753C81.0904 30.2761 80.7917 29.3269 80.2939 28.5276C79.4475 27.0288 76.5104 21.833 76.2614 21.3834C75.5147 20.0345 76.1142 18.5855 77.1575 17.6364C78.3402 16.5605 79.4475 16.2375 80.7917 16.887C81.19 17.0369 95.0794 25.2802 95.0794 25.2802C94.9301 23.6815 94.1335 22.2327 92.8392 21.2335C92.9387 21.1835 99.8586 17.0869 100.356 16.887ZM91.0968 33.7233L93.0881 31.725C93.337 31.4752 93.337 31.0755 93.0881 30.7757L91.0968 28.7773C90.7981 28.4776 90.3998 28.4776 90.1011 28.7773L88.1098 30.7757C87.8609 31.0255 87.8609 31.4752 88.1098 31.725L90.1011 33.7233C90.35 33.9731 90.7981 33.9731 91.0968 33.7233Z" fill="#FE6703"/> </g> <g clip-path="url(#clip1_930_9075)"> <path d="M39.9744 30.917H43.2497C43.3791 30.917 43.5033 30.8657 43.5948 30.7745C43.6864 30.6832 43.7378 30.5593 43.7378 30.4302C43.7375 30.3634 43.7243 30.2973 43.6987 30.2355L38.0659 14.9449C38.0312 14.8549 37.9704 14.7773 37.8913 14.7218C37.8122 14.6664 37.7184 14.6356 37.6217 14.6334H34.3367C34.2073 14.6334 34.0831 14.6846 33.9916 14.7759C33.9001 14.8672 33.8486 14.9911 33.8486 15.1202C33.8487 15.1766 33.8586 15.2326 33.8779 15.2857L39.5156 30.6152C39.5529 30.7057 39.6165 30.7828 39.6984 30.8367C39.7802 30.8905 39.8764 30.9185 39.9744 30.917Z" fill="#306BEA"/> <path d="M39.3943 47.1666H42.6695C42.799 47.1666 42.9231 47.1153 43.0146 47.0241C43.1062 46.9328 43.1576 46.8089 43.1576 46.6798C43.1575 46.6234 43.1476 46.5674 43.1283 46.5143L31.5161 14.9546C31.481 14.8639 31.4195 14.7857 31.3395 14.7302C31.2594 14.6747 31.1646 14.6443 31.0671 14.6431H27.7967C27.6673 14.6431 27.5431 14.6943 27.4516 14.7856C27.36 14.8769 27.3086 15.0008 27.3086 15.1299C27.3087 15.1863 27.3186 15.2423 27.3379 15.2954L38.9501 46.86C38.9856 46.949 39.0467 47.0256 39.1257 47.0802C39.2048 47.1347 39.2982 47.1648 39.3943 47.1666Z" fill="#306BEA"/> <path d="M32.9413 47.1667H36.2116C36.3346 47.1671 36.4532 47.1212 36.5436 47.0381C36.6341 46.9551 36.6899 46.8411 36.6997 46.7188C36.6995 46.6544 36.6897 46.5904 36.6704 46.5289L31.0181 31.2237C30.9833 31.1338 30.9225 31.0561 30.8435 31.0007C30.7644 30.9452 30.6705 30.9144 30.5739 30.9122H27.284C27.1597 30.9196 27.0429 30.9742 26.9577 31.0647C26.8724 31.1552 26.825 31.2748 26.8252 31.399C26.825 31.4523 26.835 31.5051 26.8545 31.5548L32.4824 46.8648C32.5197 46.9553 32.5833 47.0325 32.6652 47.0863C32.747 47.1401 32.8432 47.1681 32.9413 47.1667Z" fill="#306BEA"/> <path d="M40.3701 15.3003L43.0108 22.4612C43.0456 22.5511 43.1064 22.6288 43.1854 22.6843C43.2645 22.7397 43.3583 22.7705 43.455 22.7727H46.7156C46.845 22.7727 46.9692 22.7215 47.0607 22.6302C47.1523 22.5389 47.2037 22.4151 47.2037 22.2859C47.2036 22.2295 47.1937 22.1735 47.1744 22.1204L44.5337 14.9546C44.499 14.8647 44.4382 14.787 44.3591 14.7315C44.28 14.6761 44.1862 14.6453 44.0895 14.6431H40.8143C40.6848 14.6431 40.5607 14.6943 40.4691 14.7856C40.3776 14.8769 40.3262 15.0008 40.3262 15.1299C40.3303 15.1889 40.3452 15.2466 40.3701 15.3003Z" fill="#306BEA"/> <path d="M26.9032 47.1667H30.1736C30.303 47.1667 30.4272 47.1154 30.5187 47.0241C30.6102 46.9328 30.6617 46.809 30.6617 46.6799C30.6616 46.6234 30.6517 46.5674 30.6324 46.5143L27.9771 39.3339C27.942 39.2432 27.8805 39.1651 27.8004 39.1095C27.7204 39.054 27.6255 39.0237 27.528 39.0224H24.2625C24.1331 39.0224 24.0089 39.0737 23.9174 39.165C23.8258 39.2563 23.7744 39.3801 23.7744 39.5092C23.7746 39.5672 23.7845 39.6248 23.8037 39.6796L26.4444 46.86C26.4808 46.9513 26.5442 47.0295 26.6261 47.0843C26.708 47.139 26.8046 47.1677 26.9032 47.1667Z" fill="#306BEA"/> </g> <path d="M61.9834 30.2819H66.5967V32.0563H61.9834V36.6676H60.209V32.0563H55.7607V30.2819H60.209V25.8317H61.9834V30.2819Z" fill="black"/> <defs> <linearGradient id="paint0_linear_930_9075" x1="0" y1="30.8999" x2="126.312" y2="30.8999" gradientUnits="userSpaceOnUse"> <stop offset="0.1875" stop-color="#5896F3"/> <stop offset="0.5" stop-color="#7B56DA"/> <stop offset="0.865385" stop-color="#FE6703"/> </linearGradient> <clipPath id="clip0_930_9075"> <rect width="31.6621" height="29.3932" fill="white" transform="translate(75.9287 16.5522)"/> </clipPath> <clipPath id="clip1_930_9075"> <rect width="32.6206" height="32.5333" fill="white" transform="translate(18.8809 14.6334)"/> </clipPath> </defs> </svg></span>`;
  return `<!doctype html>
<html data-lavish-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loupe</title>
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="${bodyClass}">
<div class="bar"><div class="brand">${cobrandPill}<span class="brand-mark">Loupe</span></div><div class="spacer" aria-hidden="true"></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="${annotate ? "true" : "false"}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><button class="menu-item" id="printArtifact" type="button">${chromeIcons.printer}<span>Print / Save PDF</span></button><div class="menu-rule"></div><div class="menu-head"><div class="menu-label">Theme</div></div><div class="menu-themes" id="themeSwitcher" role="group" aria-label="Theme">${themeSwatchesHtml}</div><div id="contentThemeSection" hidden></div><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe><div class="layout-issue-banner" id="layoutIssueBanner" hidden>This surface may have layout issues. Your agent has been notified.</div></div><aside class="panel"><h2>Conversation</h2><div class="chat" id="chatLog"></div><div class="composer"><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Loupe.</div><div class="annotation-pills" id="annotationPills"></div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="actions" id="sendActions"><span class="send-hint" id="sendHint" hidden>Write a message or annotate an element first.</span><div class="split"><button class="button send-main" id="send">Send to Agent</button><button class="button send-caret" id="sendCaret" type="button" title="Send options" aria-haspopup="menu" aria-expanded="false">${chromeIcons.caret}</button></div><div class="menu send-menu" id="sendMenu" hidden><button class="menu-item" id="sendFromMenu" type="button">${chromeIcons.send}<span>Send to Agent</span></button><button class="menu-item danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; end session</span></button></div></div></div></aside></div>
<div class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="ended-copy" id="layoutGateCopy">Loupe is waiting for fonts and final geometry before revealing this artifact.</p><button class="button ended-action" id="layoutGateAction" type="button">Show anyway</button></div></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

export function createSdkJs(key) {
  return `(() => {
const key=${JSON.stringify(key)};
void key;
const deriveQueueKey=${deriveLavishQueueKey.toString()};
const isNativeInteractiveControl=${isNativeInteractiveControl.toString()};
const resolveDiffLine=${resolveDiffLine.toString()};
(${createArtifactSdk.toString()})(deriveQueueKey, isNativeInteractiveControl);
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
