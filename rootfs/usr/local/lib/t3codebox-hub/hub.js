// T3CodeBox hub mode (docs/hub.md): when T3CODEBOX_HUB_URL is set, the box enrols itself with a hub. It gives the
// hub a T3 Code access token, registers the hub's MCP server for the agents, renews the token before it expires
// and, once the variable is gone, takes all of that back. Started by the entrypoint; runs until hub mode is
// off. Node's standard library only. The checks and the Hub class are exported for ci/hub.test.js.
//
// Secrets here: the enrolment code, T3 Code's access token and the hub's key. None is logged, put on a command
// line or shown on the dashboard; the state file that keeps the key and an undelivered token is mode 600.
"use strict";

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROTOCOL = 1;
const HOME = process.env.HOME || os.homedir();
const STATE_FILE = path.join(HOME, ".t3codebox", "hub.json");
const REQUEST_FILE = path.join(HOME, ".t3codebox", "hub-request");
// What the hub's token may do in T3 Code: read threads and projects, and operate them (create threads, start and
// stop turns). Not the terminal, not managing T3's own access, not T3 Connect.
const SCOPES = ["orchestration:read", "orchestration:operate"];
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 7 * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const CHECK_MS = HOUR_MS;
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
const IDLE = Infinity;
const DONE = null;
const AGENTS = { claude: "claude", codex: "codex", cursor: "cursor-agent", grok: "grok", opencode: "opencode" };

// ---- Checks: settings in, hub answers in ----

// Control characters, and the ones that reorder text on screen.
const controlCharacters = /[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Text from a hub, for a log line or the dashboard: one line, no control characters, not too long.
const sanitize = (text, max = 200) => (typeof text === "string" ? text.replace(controlCharacters, " ").trim().slice(0, max) : "");

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// An http(s) address without a user, password or fragment; null otherwise.
function plainUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
  if (/[\s"\\]/.test(url.href)) return null;
  return url;
}

// Hub mode's settings. Off (url null) unless T3CODEBOX_HUB_URL is set. The code comes from T3CODEBOX_HUB_CODE or
// the file named by T3CODEBOX_HUB_CODE_FILE (a Docker secret, say), so it need not be in the environment.
function config(env = process.env, readFile = (file) => fs.readFileSync(file, "utf8")) {
  const raw = (env.T3CODEBOX_HUB_URL ?? "").trim();
  if (!raw) return { url: null };
  const url = plainUrl(raw);
  if (!url) return { url: raw, error: "T3CODEBOX_HUB_URL is not a plain http or https address." };
  // A code that cannot be read only matters while the box still has to enrol.
  let code = (env.T3CODEBOX_HUB_CODE ?? "").trim();
  let codeError = null;
  if (!code && env.T3CODEBOX_HUB_CODE_FILE) {
    try {
      code = readFile(env.T3CODEBOX_HUB_CODE_FILE).trim();
    } catch (error) {
      codeError = `T3CODEBOX_HUB_CODE_FILE could not be read (${error.code || "error"}).`;
    }
  }
  if (code && !/^[\x21-\x7e]{1,512}$/.test(code)) {
    code = "";
    codeError = "The enrolment code is not usable: one word of printable characters.";
  }
  const publicUrl = plainUrl((env.T3CODEBOX_PUBLIC_URL ?? "").trim());
  return { url: url.href, code: code || null, codeError, publicUrl: publicUrl ? publicUrl.href.replace(/\/+$/, "") : null };
}

const hashCode = (code) => (code ? crypto.createHash("sha256").update(code).digest("hex") : null);

// The hub's answer to an enrolment, checked before anything of it is used. Its addresses for renewing and
// leaving must be on the enrolment address's origin, so a hub cannot send the box's credential elsewhere. The MCP
// server may be elsewhere, over https unless the enrolment itself is plain http.
function checkEnrolment(body, enrolUrl) {
  if (!body || typeof body !== "object") return { error: "The hub's answer is not JSON." };
  if (body.protocol !== PROTOCOL) return { error: `The hub answered with protocol ${sanitize(String(body.protocol), 20)}; this box speaks ${PROTOCOL}.` };
  const origin = new URL(enrolUrl).origin;
  if (typeof body.key !== "string" || !/^[A-Za-z0-9._~+/=-]{16,512}$/.test(body.key)) return { error: "The hub's answer has no usable key." };
  const sameOrigin = (value) => {
    const url = plainUrl(value);
    return url && url.origin === origin ? url.href : null;
  };
  const renewalUrl = sameOrigin(body.renewalUrl);
  if (!renewalUrl) return { error: "The hub's renewal address is missing or not on the enrolment address's origin." };
  const leaveUrl = body.leaveUrl === undefined || body.leaveUrl === null ? null : sameOrigin(body.leaveUrl);
  if (body.leaveUrl && !leaveUrl) return { error: "The hub's leave address is not on the enrolment address's origin." };
  let mcp = null;
  if (body.mcp !== undefined && body.mcp !== null) {
    const name = body.mcp?.name;
    const url = plainUrl(body.mcp?.url);
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || name === "browser") return { error: "The hub's MCP server name is not usable." };
    if (!url || (url.protocol === "http:" && new URL(enrolUrl).protocol !== "http:")) return { error: "The hub's MCP server address is not usable." };
    mcp = { name, url: url.href };
  }
  const renewAfter = body.renewAfter === undefined || body.renewAfter === null ? null : typeof body.renewAfter === "string" ? Date.parse(body.renewAfter) : NaN;
  if (Number.isNaN(renewAfter)) return { error: "The hub's renewAfter is not a time." };
  const boxId = typeof body.boxId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.boxId) ? body.boxId : null;
  return { key: body.key, renewalUrl, leaveUrl, mcp, renewAfter, boxId, hubName: sanitize(body.hub?.name, 80) || null };
}

// When the box sends the hub a new credential: when the hub asked for it (renewAfter), and a week before the
// one the hub has expires, whichever comes first, but never sooner than an hour after the last one, whatever a
// hub asks. A box that was off past that renews as soon as it is back.
function renewAt(state) {
  const expires = state?.credential?.expiresAt ? Date.parse(state.credential.expiresAt) - RENEW_BEFORE_MS : Infinity;
  const asked = state?.renewAfter ? Date.parse(state.renewAfter) : Infinity;
  const floor = state?.renewedAt ? Date.parse(state.renewedAt) + HOUR_MS : -Infinity;
  return Math.max(Math.min(expires, asked), floor);
}

// Waits between attempts while the hub does not answer: 15 s doubling to 30 min, a fifth either way, or what the
// hub's Retry-After asks (5 s to an hour).
function backoff(attempt, retryAfter = null, random = Math.random) {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.max(seconds * 1000, 5000), 3_600_000);
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.round(base * (0.8 + 0.4 * random()));
}

// What the page shows: no code, token or key.
function publicState(state, cfg) {
  if (!cfg.url && !state) return { configured: false, status: "off" };
  const at = state ? renewAt(state) : Infinity;
  return {
    configured: Boolean(cfg.url),
    status: !cfg.url ? "leaving" : cfg.error ? "error" : state?.status ?? "enrolling",
    enrolled: Boolean(state?.key) && state?.status !== "left",
    error: cfg.error || state?.error || null,
    hub: state?.hubName ?? null,
    origin: (() => {
      try {
        return new URL(state?.url || cfg.url).origin;
      } catch {
        return null;
      }
    })(),
    mcp: state?.mcp ? { name: state.mcp.name, agents: state.mcp.agents ?? [] } : null,
    enrolledAt: state?.enrolledAt ?? null,
    renewedAt: state?.renewedAt ?? null,
    renewBy: Number.isFinite(at) ? new Date(at).toISOString() : null,
    expiresAt: state?.credential?.expiresAt ?? null,
    nextAttemptAt: state?.nextAttemptAt ?? null,
  };
}

// ---- The box's side: files, T3's CLI and HTTP ----

function readState(file = STATE_FILE) {
  const data = parseJson((() => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })());
  return data && typeof data === "object" ? data : null;
}

function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A request from the dashboard ("retry" or "leave"), taken once.
function takeRequest(file = REQUEST_FILE) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    fs.rmSync(file, { force: true });
    return ["retry", "leave"].includes(text) ? text : null;
  } catch {
    return null;
  }
}

// A CLI's stdout and exit code; secrets never go in `args`.
function runCli(command, args, { input = null, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: HOME, timeout, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin?.end(input ?? undefined);
  });
}

// The body of a response, at most 64 KB of it: a hub's answer is small, and a hostile one must not fill memory.
async function readCapped(response, cap = 65536) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// POSTs JSON. Never follows a redirect, which would carry the body to another address. Resolves with the status
// (0 when there was no answer), the parsed body and Retry-After.
async function postJson(fetchFn, url, body, { key = null, timeout = 15_000 } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": `T3CodeBox/${process.env.T3CODEBOX_VERSION || "dev"}` };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeout) });
    const text = await readCapped(response);
    return { status: response.status, body: text === null ? null : parseJson(text), retryAfter: response.headers.get("retry-after") };
  } catch (error) {
    return { status: 0, problem: error?.cause?.code || (error?.name === "TimeoutError" ? "timeout" : "no answer") };
  }
}

// The hub's own words for a refusal, or the status.
const refusal = (response) => (sanitize(response.body?.message) || sanitize(response.body?.error, 60) || `HTTP ${response.status}`).replace(/[.\s]+$/, "");

class Hub {
  // deps: env, fetch, cli(command, args, options), mcp(action, name, agents, spec), now(), log(text), random(),
  // stateFile, requestFile, t3Url, installed(command).
  constructor(deps = {}) {
    this.env = deps.env ?? process.env;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.cli = deps.cli ?? runCli;
    this.mcp = deps.mcp ?? ((action, name, agents, spec) => runCli("t3codebox-mcp", [action, name, ...agents], { input: JSON.stringify(spec) }));
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((text) => console.log(`t3codebox: hub: ${text}`));
    this.random = deps.random ?? Math.random;
    this.stateFile = deps.stateFile ?? STATE_FILE;
    this.requestFile = deps.requestFile ?? REQUEST_FILE;
    this.t3Url = deps.t3Url ?? `http://127.0.0.1:${this.env.T3CODE_PORT || 3773}`;
    this.installed = deps.installed ?? ((command) => (this.env.PATH ?? "").split(":").some((dir) => dir && fs.existsSync(path.join(dir, command))));
    this.registered = false;
    this.lastCheck = 0;
  }

  load() {
    return readState(this.stateFile);
  }

  save(state) {
    writeState(state, this.stateFile);
    return state;
  }

  forget() {
    fs.rmSync(this.stateFile, { force: true });
  }

  // ---- T3 Code ----

  async environment() {
    try {
      const response = await this.fetch(`${this.t3Url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(5000) });
      return response.ok ? parseJson(await readCapped(response)) : null;
    } catch {
      return null;
    }
  }

  // A new access token for the hub, limited to SCOPES: a single-use pairing credential from T3's CLI, exchanged
  // at T3's token endpoint for a token with fewer scopes than the credential carries. The token lasts as long as
  // T3 makes it (30 days).
  async mint() {
    const label = `Hub ${crypto.randomBytes(3).toString("hex")}`;
    const created = await this.cli("t3", ["auth", "pairing", "create", "--ttl", "5m", "--label", label, "--json"]);
    const pairing = parseJson(created.stdout);
    if (created.code !== 0 || typeof pairing?.credential !== "string") throw new Error("T3 Code did not create a credential for the hub.");
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairing.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: SCOPES.join(" "),
      client_label: label,
    });
    let answer = null;
    try {
      const response = await this.fetch(`${this.t3Url}/oauth/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(), redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      answer = { status: response.status, body: parseJson(await readCapped(response)) };
    } catch {}
    const token = answer?.body?.access_token;
    const granted = String(answer?.body?.scope ?? "").split(" ");
    const issued = answer?.status === 200 && typeof token === "string";
    // The session T3 made for the token, by the pairing's label: without it the box could not revoke the token,
    // so a token whose session is not found is never handed out.
    const sessions = issued ? parseJson((await this.cli("t3", ["auth", "session", "list", "--json"])).stdout) : null;
    const session = Array.isArray(sessions) ? sessions.filter((s) => s?.client?.label === label).pop() : null;
    const sessionId = validId(session?.sessionId) ? session.sessionId : null;
    if (!issued || !sessionId || granted.length !== SCOPES.length || !SCOPES.every((s) => granted.includes(s))) {
      if (sessionId) await this.revoke({ sessionId });
      else if (validId(pairing.id)) await this.cli("t3", ["auth", "pairing", "revoke", pairing.id]);
      const why = !answer ? "no answer" : !issued ? `HTTP ${answer.status}${answer.body?.error ? `, ${sanitize(answer.body.error, 60)}` : ""}` : !sessionId ? "its session is not listed" : "other scopes than asked for";
      throw new Error(`T3 Code did not issue the hub's token (${why}).`);
    }
    return {
      token,
      scopes: SCOPES,
      expiresAt: new Date(this.now() + (Number(answer.body.expires_in) > 0 ? Number(answer.body.expires_in) * 1000 : 30 * DAY_MS)).toISOString(),
      sessionId,
    };
  }

  // Revokes a token by its T3 session. True when it is gone (or there was none).
  async revoke(credential) {
    if (!validId(credential?.sessionId)) return true;
    return (await this.cli("t3", ["auth", "session", "revoke", credential.sessionId])).code === 0;
  }

  // Revokes a token the hub no longer has, or keeps its session in `state.stale` to try again at the next step.
  async retire(state, credential) {
    if (!(await this.revoke(credential))) state.stale = [...new Set([...(state.stale ?? []), credential.sessionId])];
    return state;
  }

  async revokeStale(state) {
    const left = [];
    for (const sessionId of state.stale ?? []) if (!(await this.revoke({ sessionId }))) left.push(sessionId);
    state.stale = left;
    return left.length === 0;
  }

  // Is the hub's token still a T3 session? Not when someone revoked it on the dashboard or with T3's CLI. Unknown
  // (T3 not answering) counts as yes.
  async sessionAlive(credential) {
    if (!validId(credential?.sessionId)) return true;
    const result = await this.cli("t3", ["auth", "session", "list", "--json"]);
    const sessions = parseJson(result.stdout);
    return !Array.isArray(sessions) || sessions.some((s) => s?.sessionId === credential.sessionId);
  }

  // The credential to send: the one minted for an earlier attempt that did not get through, while it has a day
  // left, so a hub that is down does not leave a trail of tokens behind; else a new one.
  async credential(state) {
    if (state.pending?.token && Date.parse(state.pending.expiresAt) - this.now() > DAY_MS) return state.pending;
    if (state.pending) await this.retire(state, state.pending);
    state.pending = await this.mint();
    this.save(state);
    return state.pending;
  }

  async describe() {
    const environment = await this.environment();
    if (!environment) return null;
    const cfg = config(this.env);
    return {
      name: sanitize(environment.label, 120) || null,
      environmentId: typeof environment.environmentId === "string" ? environment.environmentId : null,
      t3codebox: this.env.T3CODEBOX_VERSION || null,
      t3code: typeof environment.serverVersion === "string" ? environment.serverVersion : null,
      orchestrationProtocol: Number.isInteger(environment.orchestrationProtocolVersion) ? environment.orchestrationProtocolVersion : 1,
      agents: Object.entries(AGENTS).filter(([, command]) => this.installed(command)).map(([id]) => id),
      url: cfg.publicUrl ?? null,
    };
  }

  // ---- MCP entries ----

  spec(state) {
    return { url: state.mcp.url, headers: { Authorization: `Bearer ${state.key}` } };
  }

  // Adds the hub's MCP server where it is missing, as the browser's is added on every start.
  async register(state) {
    if (!state.mcp) return;
    const result = await this.mcp("add", state.mcp.name, [], this.spec(state));
    const added = result.stdout.split("\n").filter((agent) => Object.hasOwn(AGENTS, agent));
    if (added.length) this.log(`added the ${state.mcp.name} MCP server for: ${added.join(" ")}`);
    state.mcp.agents = [...new Set([...(state.mcp.agents ?? []), ...added])].sort();
    // Not done when t3codebox-mcp failed (another registration held its lock): tried again at the next step.
    this.registered = result.code === 0;
  }

  // Removes the entries this box added, where they are still as it added them.
  async unregister(state) {
    if (!state?.mcp?.agents?.length) return;
    const result = await this.mcp("remove", state.mcp.name, state.mcp.agents, { url: state.mcp.url });
    const removed = result.stdout.split("\n").filter(Boolean);
    if (removed.length) this.log(`removed the ${state.mcp.name} MCP server from: ${removed.join(" ")}`);
  }

  // ---- The protocol ----

  // Enrols with the configured code. `state` holds an earlier attempt's undelivered credential, if any.
  async enrol(cfg, state) {
    if (!cfg.code) {
      if (state.pending) await this.retire(state, state.pending);
      const error = cfg.codeError || "No enrolment code: set T3CODEBOX_HUB_CODE or T3CODEBOX_HUB_CODE_FILE.";
      if (state.error !== error) this.log(error);
      this.save({ url: cfg.url, status: "error", error, codeHash: null, stale: state.stale ?? [] });
      return IDLE;
    }
    state = { ...state, url: cfg.url, status: "enrolling", codeHash: hashCode(cfg.code) };
    const box = await this.describe();
    if (!box) {
      const error = "Waiting for T3 Code to answer.";
      if (state.error !== error) this.save({ ...state, error });
      return 5000;
    }
    let credential;
    try {
      credential = await this.credential(state);
    } catch (error) {
      return this.retry(state, error.message);
    }
    if (!state.attempts) {
      this.log(`enrolling with the hub at ${new URL(cfg.url).origin}`);
      if (cfg.url.startsWith("http:")) this.log("the hub's address is plain http: the code and T3 token go unencrypted, fine on a private network only");
    }
    const response = await postJson(this.fetch, cfg.url, { protocol: PROTOCOL, code: cfg.code, box, t3code: tokenBody(credential) });
    if (response.status === 0 || response.status === 408 || response.status === 429 || response.status >= 500) {
      return this.retry(state, response.status ? `The hub answered HTTP ${response.status}.` : `The hub did not answer (${response.problem}).`, response.retryAfter);
    }
    const answer = response.status >= 200 && response.status <= 299 ? checkEnrolment(response.body, cfg.url) : null;
    if (!answer || answer.error) {
      // Refused, or an answer this box cannot use: reported once, and not tried again with this code.
      const error = answer ? answer.error : `The hub refused the enrolment: ${refusal(response)}. Set a new code, or press Retry.`;
      this.log(error);
      this.save(await this.retire({ url: cfg.url, status: answer ? "error" : "rejected", codeHash: state.codeHash, error, stale: state.stale ?? [] }, credential));
      return IDLE;
    }
    const now = new Date(this.now()).toISOString();
    const next = this.save({
      stale: state.stale ?? [],
      url: cfg.url, status: "connected", error: null, codeHash: state.codeHash, hubName: answer.hubName, boxId: answer.boxId,
      key: answer.key, renewalUrl: answer.renewalUrl, leaveUrl: answer.leaveUrl, mcp: answer.mcp ? { ...answer.mcp, agents: [] } : null,
      credential: { sessionId: credential.sessionId, expiresAt: credential.expiresAt }, pending: null,
      renewAfter: answer.renewAfter ? new Date(answer.renewAfter).toISOString() : null, enrolledAt: now, renewedAt: now, attempts: 0, nextAttemptAt: null,
    });
    this.log(`enrolled with ${next.hubName ? `${next.hubName} at ` : "the hub at "}${new URL(cfg.url).origin}`);
    await this.register(next);
    return this.untilRenewal(this.save(next));
  }

  // Sends the hub a new credential, with the box's key. The old token is revoked once the hub has the new one.
  async renew(state, box) {
    let credential;
    try {
      credential = await this.credential(state);
    } catch (error) {
      return this.retry(state, error.message);
    }
    const response = await postJson(this.fetch, state.renewalUrl, { protocol: PROTOCOL, box, t3code: tokenBody(credential) }, { key: state.key });
    if ([401, 403, 404, 410].includes(response.status)) {
      const error = `The hub no longer accepts this box: ${refusal(response)}. Enrol again with a new code, or leave.`;
      this.log(error);
      this.save(await this.retire({ ...state, status: "error", error, pending: null, attempts: 0, nextAttemptAt: null }, credential));
      return IDLE;
    }
    if (response.status < 200 || response.status > 299) {
      return this.retry(state, response.status ? `Renewal: the hub answered HTTP ${response.status}.` : `Renewal: the hub did not answer (${response.problem}).`, response.retryAfter);
    }
    // The hub has the new token. Its renewAfter counts only in an answer of this protocol version.
    const renewAfter = response.body?.protocol === PROTOCOL && typeof response.body.renewAfter === "string" ? Date.parse(response.body.renewAfter) : NaN;
    if (state.credential && state.credential.sessionId !== credential.sessionId) await this.retire(state, state.credential);
    this.log("gave the hub a new T3 Code token");
    return this.untilRenewal(this.save({
      ...state, status: "connected", error: null, credential: { sessionId: credential.sessionId, expiresAt: credential.expiresAt }, pending: null,
      renewAfter: Number.isNaN(renewAfter) ? null : new Date(renewAfter).toISOString(), renewedAt: new Date(this.now()).toISOString(), attempts: 0, nextAttemptAt: null,
    }));
  }

  // Leaving: the entries this box added go, T3's tokens for the hub are revoked, and the hub is told if it gave
  // an address for that. The caller forgets the state, or keeps it as "left".
  async leave(state, reason) {
    let origin = "an unknown address";
    try {
      origin = new URL(state.url).origin;
    } catch {}
    if (!state.leaving) this.log(`leaving the hub at ${origin}: ${reason}`);
    if (state.mcp) {
      await this.unregister(state);
      state.mcp = null;
    }
    if (state.leaveUrl && state.key) await postJson(this.fetch, state.leaveUrl, { protocol: PROTOCOL }, { key: state.key, timeout: 5000 });
    state.leaveUrl = null;
    state.key = null;
    // T3 still starting, say: the tokens are revoked on a later step, and the state is kept until then.
    for (const which of ["credential", "pending"]) if (await this.revoke(state[which])) state[which] = null;
    await this.revokeStale(state);
    state.leaving = Boolean(state.credential || state.pending || state.stale.length);
    if (state.leaving) this.log("could not revoke the hub's T3 token yet; trying again in 30 s");
    return !state.leaving;
  }

  retry(state, error, retryAfter = null) {
    const attempts = (state.attempts ?? 0) + 1;
    const wait = backoff(attempts - 1, retryAfter, this.random);
    if (attempts === 1 || error !== state.error) this.log(`${error} Trying again in ${Math.round(wait / 1000)} s, and on until it answers.`);
    this.save({ ...state, error, attempts, nextAttemptAt: new Date(this.now() + wait).toISOString() });
    return wait;
  }

  untilRenewal(state) {
    return Math.max(1000, Math.min(renewAt(state) - this.now(), CHECK_MS));
  }

  // One decision; returns how long to wait before the next one (IDLE: until the dashboard asks), or DONE.
  async step(request = takeRequest(this.requestFile)) {
    const cfg = config(this.env);
    let state = this.load();
    const enrolled = () => Boolean(state?.key) && state.status !== "left";
    if (!cfg.url) {
      if (state) {
        if (!(await this.leave(state, "T3CODEBOX_HUB_URL is not set"))) {
          this.save(state);
          return 30_000;
        }
        this.forget();
        this.log("hub mode is off; the enrolment is forgotten");
      }
      return DONE;
    }
    if (cfg.error) {
      // Nothing is changed: once the setting is fixed, the box carries on where it was.
      if (this.lastError !== cfg.error) this.log(cfg.error);
      this.lastError = cfg.error;
      return IDLE;
    }
    if (state && state.url !== cfg.url) {
      if (!(await this.leave(state, "T3CODEBOX_HUB_URL changed"))) {
        this.save(state);
        return 30_000;
      }
      this.forget();
      state = null;
    }
    if (state?.stale?.length) {
      await this.revokeStale(state);
      this.save(state);
    }
    if (state?.leaving || request === "leave") {
      if (state && !(await this.leave(state, "asked on the dashboard"))) {
        this.save({ ...state, status: "left" });
        return 30_000;
      }
      this.save({ url: cfg.url, status: "left", codeHash: state?.codeHash ?? hashCode(cfg.code), error: null, leftAt: state?.leftAt ?? new Date(this.now()).toISOString() });
      return IDLE;
    }
    const newCode = Boolean(cfg.code) && hashCode(cfg.code) !== (state?.codeHash ?? null);
    if (enrolled() && newCode) {
      // A new code enrols the box again, from the start.
      if (!(await this.leave(state, "a new enrolment code is set"))) {
        this.save(state);
        return 30_000;
      }
      this.forget();
      state = null;
    }
    if (!enrolled()) {
      if (!state || newCode || request === "retry" || state.status === "enrolling") {
        return this.enrol(cfg, { pending: state?.pending ?? null, stale: state?.stale ?? [], attempts: request === "retry" ? 0 : state?.attempts ?? 0, error: state?.error ?? null });
      }
      return IDLE;
    }
    if (state.status === "error" && request !== "retry") return IDLE;
    if (!this.registered) {
      await this.register(state);
      this.save(state);
    }
    const due = request === "retry" || this.now() >= renewAt(state) || Boolean(state.nextAttemptAt && this.now() >= Date.parse(state.nextAttemptAt));
    if (!due) {
      // Once an hour, and at start: is the hub's token still there?
      let alive = true;
      if (this.now() - this.lastCheck >= CHECK_MS) {
        this.lastCheck = this.now();
        alive = await this.sessionAlive(state.credential);
      }
      if (alive) return state.nextAttemptAt ? Math.max(1000, Date.parse(state.nextAttemptAt) - this.now()) : this.untilRenewal(state);
      // Revoked on this box, on purpose: the hub gets no new token until its owner says so.
      const error = "The hub's T3 access was revoked on this box. Renew now gives the hub a new token; Leave disconnects it.";
      this.log(error);
      this.save({ ...state, status: "error", error, credential: null });
      return IDLE;
    }
    const box = await this.describe();
    if (!box) return 5000;
    return this.renew(request === "retry" ? { ...state, attempts: 0 } : state, box);
  }
}

const validId = (id) => typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id);

const tokenBody = (credential) => ({ tokenType: "Bearer", token: credential.token, scopes: credential.scopes ?? SCOPES, expiresAt: credential.expiresAt });

// Runs until hub mode is off. Between decisions it looks for a request from the dashboard every 2 s.
async function main() {
  const hub = new Hub();
  for (;;) {
    let wait;
    try {
      wait = await hub.step();
    } catch (error) {
      hub.log(`unexpected error: ${sanitize(String(error?.message || error))}`);
      wait = 60_000;
    }
    if (wait === DONE) return;
    const until = Date.now() + wait;
    while (Date.now() < until && !fs.existsSync(hub.requestFile)) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, until - Date.now())));
  }
}

module.exports = { PROTOCOL, SCOPES, config, checkEnrolment, renewAt, backoff, publicState, sanitize, hashCode, postJson, readState, Hub, IDLE, DONE, STATE_FILE, REQUEST_FILE };

if (require.main === module) main();
