// T3CodeBox dashboard: a status board for the container on port 3772, where settings can also be changed,
// behind a password. Node's standard library only. The parsers (plain functions from text to data), request
// checks, provider cards, jobs and the session store are exported for ci/dashboard.test.js; the server
// starts only when run directly.
"use strict";

const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PORT = 3772;
const HOME = process.env.HOME || os.homedir();
const WORKSPACE = "/workspace";
const PASSWORD_FILE = path.join(HOME, ".t3codebox", "dashboard-password");
const SESSIONS_FILE = path.join(HOME, ".t3codebox", "dashboard-sessions.json");
const COOKIE = "t3codebox_dashboard";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const PROVIDERS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Build", opencode: "OpenCode" };

// ---- Parsers: text in, data out ----

const stripAnsi = (text) => String(text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const str = (value) => (typeof value === "string" && value !== "" ? value : null);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The version in a CLI's --version output: "codex-cli 0.156.1" → "0.156.1", "t3 v0.0.42" → "0.0.42".
function parseVersion(text) {
  const match = stripAnsi(text).match(/\d+\.\d+[0-9A-Za-z.+-]*/);
  return match ? match[0] : null;
}

// /proc/self/mountinfo: "id parent major:minor root mountpoint options [optional…] - fstype source superoptions".
function parseMountinfo(text) {
  const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = [];
  for (const line of String(text).split("\n")) {
    const fields = line.trim().split(" ");
    const dash = fields.indexOf("-", 6);
    if (dash < 0 || fields.length < dash + 3) continue;
    mounts.push({
      root: unescape(fields[3]),
      mountPoint: unescape(fields[4]),
      readOnly: fields[5].split(",").includes("ro"),
      fsType: fields[dash + 1],
      source: unescape(fields[dash + 2]),
    });
  }
  return mounts;
}

// What holds a folder: a named volume, a bind mount (root is the path inside the source file system,
// e.g. /t3codebox/home on the ZFS dataset Main/docker), tmpfs, or nothing. Without a mount the folder lives
// in the container's own layer and is lost when the container is recreated.
function describeMount(mounts, mountPoint) {
  const mount = mounts.filter((m) => m.mountPoint === mountPoint).pop();
  if (!mount) return { kind: "none" };
  const volume = mount.root.match(/\/volumes\/([^/]+)\/_data$/);
  const kind = volume ? "volume" : mount.fsType === "tmpfs" ? "tmpfs" : "bind";
  return { kind, ...(volume ? { volume: volume[1] } : { root: mount.root }), source: mount.source, fsType: mount.fsType };
}

// "key value" lines, as in cpu.stat and memory.stat.
function parseKeyValues(text) {
  const values = {};
  for (const line of String(text).split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && /^\d+$/.test(value ?? "")) values[key] = Number(value);
  }
  return values;
}

// Memory in use the way `docker stats` counts it: memory.current minus the inactive page cache.
// The limit is null for "max". Null when there is no cgroup v2 memory.current.
function parseMemory(current, max, stat) {
  const used = String(current ?? "").trim();
  if (!/^\d+$/.test(used)) return null;
  const limit = String(max ?? "").trim();
  const inactive = parseKeyValues(stat ?? "").inactive_file || 0;
  return { used: Math.max(0, Number(used) - inactive), limit: /^\d+$/.test(limit) ? Number(limit) : null };
}

// cpu.max "quota period": the limit in cores, or null for "max".
function parseCpuMax(text) {
  const [quota, period] = String(text ?? "").trim().split(/\s+/);
  return /^\d+$/.test(quota ?? "") && Number(period) > 0 ? Number(quota) / Number(period) : null;
}

// /proc/<pid>/stat: "pid (comm) state ppid …". comm may hold spaces and parentheses: split at the last ")".
function parseProcStat(text) {
  const s = String(text ?? "");
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = s.slice(close + 2).split(" ");
  return { pid: Number(s.slice(0, open)), comm: s.slice(open + 1, close), ppid: Number(rest[1]), startTicks: Number(rest[19]) };
}

// Seconds since the container started: PID 1's start (clock ticks after boot) against /proc/uptime.
function containerUptime(pid1Stat, procUptime, ticksPerSecond = 100) {
  const stat = parseProcStat(pid1Stat);
  const uptime = parseFloat(procUptime);
  if (!stat || !Number.isFinite(stat.startTicks) || !Number.isFinite(uptime)) return null;
  return Math.max(0, uptime - stat.startTicks / ticksPerSecond);
}

// Which agent a process is, from its executable path and name only. Command lines are never read:
// T3 passes bearer tokens on them. Cursor runs as its bundled node, so only its path tells.
function agentOf({ comm, exe }) {
  if (exe && exe.startsWith("/opt/cursor-agent/")) return "cursor";
  for (const name of [exe && path.basename(exe).replace(/ \(deleted\)$/, ""), comm]) {
    const match = name && name.match(/^(claude|codex|grok|opencode)(?:[-.]|$)/);
    if (match) return match[1];
  }
  return null;
}

// Running agents per provider. A process whose parent is the same agent (a wrapper and its native binary,
// or an agent's own helpers) counts once.
function countAgents(processes) {
  const agents = new Map(processes.map((p) => [p.pid, agentOf(p)]));
  const counts = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, 0]));
  for (const p of processes) {
    const agent = agents.get(p.pid);
    if (agent && agents.get(p.ppid) !== agent) counts[agent] += 1;
  }
  return counts;
}

// `claude auth status --json`. apiKeySource is set when an API key is in use, next to a login too.
function parseClaudeStatus(text) {
  const s = parseJson(text);
  if (!s || typeof s !== "object") return null;
  return {
    signedIn: s.loggedIn === true,
    authMethod: str(s.authMethod),
    apiKeySource: str(s.apiKeySource),
    email: str(s.email),
    subscription: str(s.subscriptionType),
  };
}

// `codex login status`: "Logged in using ChatGPT", "Logged in using an API key - sk-…" or "Not logged in".
// Only the method is kept; the masked key goes nowhere.
function parseCodexStatus(text) {
  const t = stripAnsi(text);
  if (/Not logged in/i.test(t)) return { signedIn: false, method: null };
  if (/Logged in using ChatGPT/i.test(t)) return { signedIn: true, method: "chatgpt" };
  if (/Logged in using an API key/i.test(t)) return { signedIn: true, method: "api-key" };
  if (/Logged in/i.test(t)) return { signedIn: true, method: null };
  return null;
}

// `cursor-agent status --format json`: isAuthenticated, and an email when signed in.
function parseCursorStatus(text) {
  const s = parseJson(text);
  if (!s || typeof s !== "object") return null;
  return { signedIn: s.isAuthenticated === true, email: str(s.email) || str(s.userEmail) || str(s.user?.email) };
}

// `opencode auth list`: a "Credentials" block (stored sign-ins) and, when provider variables are set, an
// "Environment" block. Entries read "●  <provider> <type or variable>", the last word dimmed with ANSI codes.
function parseOpencodeAuth(text) {
  const result = { credentials: [], environment: [] };
  let section = null;
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("┌")) {
      section = /Environment/i.test(line) ? "environment" : /Credentials/i.test(line) ? "credentials" : null;
    } else if (line.startsWith("●") && section) {
      const words = line.slice(1).trim().split(/\s+/);
      const detail = words.length > 1 ? words.pop() : null;
      const provider = words.join(" ");
      result[section].push(section === "environment" ? { provider, variable: detail } : { provider, type: detail });
    }
  }
  return result;
}

// `gh auth status --json hosts`: every account per host and where its token comes from. Holds no token.
function parseGhStatus(text) {
  const s = parseJson(text) ?? parseJson(String(text).split("\n").find((line) => line.startsWith("{")) ?? "");
  if (!s || typeof s.hosts !== "object" || s.hosts === null) return null;
  const accounts = [];
  for (const [host, entries] of Object.entries(s.hosts)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      const source = str(e.tokenSource);
      accounts.push({
        host,
        login: str(e.login),
        active: e.active === true,
        ok: e.state === "success",
        envVariable: source && /^[A-Z_]+$/.test(source) ? source : null,
        scopes: str(e.scopes) ? e.scopes.split(/,\s*/) : [],
      });
    }
  }
  return accounts;
}

// `t3 auth session list --json`: paired clients. Kept: the id (to revoke), label, device, times. Dropped:
// IP addresses, scopes, and `connected` (it read false for a connected client).
function parseT3Sessions(text) {
  const list = parseJson(text);
  if (!Array.isArray(list)) return null;
  return list.map((s) => ({
    id: str(s.sessionId),
    label: str(s.client?.label),
    deviceType: str(s.client?.deviceType),
    os: str(s.client?.os),
    browser: str(s.client?.browser),
    issuedAt: str(s.issuedAt),
    expiresAt: str(s.expiresAt),
    lastConnectedAt: str(s.lastConnectedAt),
  }));
}

// `t3 auth pairing list --json`: unused pairing links, without the links themselves.
function parseT3Pairings(text) {
  const list = parseJson(text);
  if (!Array.isArray(list)) return null;
  return list.map((p) => ({ id: str(p.id), label: str(p.label), createdAt: str(p.createdAt), expiresAt: str(p.expiresAt) }));
}

// `t3 auth pairing create --json`: the new link, shown once. The scopes are left out.
function parsePairingCreate(text) {
  const p = parseJson(text);
  if (!p || typeof p !== "object" || !str(p.pairUrl)) return null;
  return { id: str(p.id), label: str(p.label), pairUrl: p.pairUrl, credential: str(p.credential), expiresAt: str(p.expiresAt) };
}

// SKILL.md frontmatter between the leading "---" lines: name and description. Handles the value forms
// skill files use: plain (also over several lines), quoted, and block (| and >).
function parseSkillFrontmatter(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (lines[0].trim() !== "---" || end < 0) return { name: null, description: null };
  const fields = {};
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const more = [];
    while (i + 1 < end && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === "")) more.push(lines[++i]);
    let value = match[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
      const block = more.map((l) => l.slice(indent).trimEnd());
      value = value[0] === "|" ? block.join("\n").trim() : block.filter(Boolean).join(" ");
    } else {
      value = [value, ...more.map((l) => l.trim())].filter(Boolean).join(" ");
      if (/^".*"$/.test(value)) value = parseJson(value) ?? value.slice(1, -1);
      else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    }
    fields[match[1]] = value;
  }
  return { name: str(fields.name), description: str(fields.description) };
}

// `du -sk <paths>`: "<KiB>\t<path>" per line.
function parseDu(text) {
  const sizes = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (match) sizes[match[2]] = Number(match[1]) * 1024;
  }
  return sizes;
}

// "Safari on iPhone" from a user agent, for the list of dashboard devices.
function userAgentLabel(userAgent) {
  const ua = String(userAgent ?? "");
  const browser =
    /Edg(A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /CriOS\/|Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /^curl\//.test(ua) ? "curl"
    : null;
  const device =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && device) return `${browser} on ${device}`;
  return browser || (device ? `Browser on ${device}` : "Unknown browser");
}

// ---- Settings: requests checked, CLI output read ----

// A CLI's progress output as readable lines, for a job's log: the redraws of a spinner (cursor to column 1,
// clear line) become line breaks, ANSI codes go, and spinner frames and bare box borders are skipped.
function outputLines(text) {
  const lines = [];
  for (const raw of String(text)
    .replace(/\x1b\[\d*G|\x1b\[\d*[JK]|\r/g, "\n")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || /^[\s│├└┌┬┴┼─╭╮╯╰]*$/.test(line) || /^[◒◐◓◑]/.test(line)) continue;
    if (line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines;
}

// `skills add <repo> -l`: under "Available Skills", each skill's name after "│" and four spaces, its
// description after six.
function parseSkillsListing(text) {
  const skills = [];
  let listing = false;
  for (const line of outputLines(text)) {
    if (/Available Skills/.test(line)) listing = true;
    if (!listing) continue;
    const name = line.match(/^│ {4}(\S.*)$/);
    const description = line.match(/^│ {6}(\S.*)$/);
    if (name) skills.push({ name: name[1], description: null });
    else if (description && skills.length) skills[skills.length - 1].description = description[1];
  }
  return skills;
}

// `skills add … --json`: one entry per skill, with its status, agents and security assessment.
function parseSkillsAdd(text) {
  const list = parseJson(text);
  if (!Array.isArray(list)) return null;
  return list.map((s) => ({
    name: str(s.name),
    status: str(s.status),
    error: str(s.error),
    agents: Array.isArray(s.agents) ? s.agents.filter((a) => typeof a === "string") : [],
    security: s.security && typeof s.security === "object"
      ? { gen: str(s.security.gen), socket: str(s.security.socket), snyk: str(s.security.snyk) }
      : null,
  }));
}

// What `skills add` accepts from the page: a GitHub owner/repo or an https URL. Never something that
// starts with "-", which the CLI would read as an option.
function validSkillSource(source) {
  return typeof source === "string" && source.length <= 300 &&
    /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+|https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/\S*)?)$/.test(source);
}

// A skill's name or folder, as `skills add --skill` and `skills remove` take them.
function validSkillName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(name);
}

// T3's pairing and session ids are UUIDs.
function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id);
}

const controlCharacters = /[\x00-\x1f\x7f]/;

// git's user.name and user.email; an empty value unsets it. A leading "-" would read as an option.
function checkGitAuthor(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : null;
  const email = typeof body?.email === "string" ? body.email.trim() : null;
  if (name === null || email === null) return { error: "Expected a name and an email." };
  if (name.length > 100 || controlCharacters.test(name) || name.startsWith("-")) return { error: "That name is not usable." };
  if (email && (email.length > 254 || !/^[^\s@<>-][^\s@<>]*@[^\s@<>]+$/.test(email))) return { error: "That email is not usable." };
  return { name, email };
}

const PAIRING_TTLS = ["15m", "1h", "1d", "7d", "30d"];

// A new pairing link: the public base URL of T3 (http or https, no query or fragment), a validity from
// the page's list and an optional label.
function checkPairingRequest(body) {
  let url;
  try {
    url = new URL(body?.baseUrl);
  } catch {
    return { error: "The base URL is not a URL." };
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return { error: "The base URL must be a plain http or https address." };
  }
  if (!PAIRING_TTLS.includes(body.ttl)) return { error: "Unknown validity." };
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label.length > 60 || controlCharacters.test(label) || label.startsWith("-")) return { error: "That label is not usable." };
  return { baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, ttl: body.ttl, label: label || "Dashboard" };
}

// `t3 serve`: the T3 process tini started (the entrypoint execs into it), not a `t3 auth` call.
function findT3Server(processes) {
  return processes.find((p) => p.ppid === 1 && p.exe && /^\/opt\/t3\/t3(?: \(deleted\))?$/.test(p.exe))?.pid ?? null;
}

// Slow actions run as jobs: a POST starts one and returns at once, and the page polls it. One job of a
// kind runs at a time (starting another returns the running one); the latest job of each kind is kept so
// a page that reloads finds it again. `work(log)` gets the output so far and returns the result.
class Jobs {
  constructor({ lines = 40, now = Date.now } = {}) {
    this.lines = lines;
    this.now = now;
    this.jobs = new Map();
  }

  start(kind, title, work) {
    const running = this.latest(kind);
    if (running?.state === "running") return { job: running, started: false };
    for (const [id, job] of this.jobs) if (job.kind === kind) this.jobs.delete(id);
    const job = { id: crypto.randomBytes(6).toString("hex"), kind, title, state: "running", lines: [], result: null, error: null, startedAt: this.now(), finishedAt: null };
    this.jobs.set(job.id, job);
    const log = (output) => (job.lines = outputLines(output).slice(-this.lines));
    Promise.resolve()
      .then(() => work(log))
      .then(
        (result) => Object.assign(job, { state: "done", result: result ?? null }),
        (error) => Object.assign(job, { state: "failed", error: String(error?.message || error) }),
      )
      .finally(() => (job.finishedAt = this.now()));
    return { job, started: true };
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  latest(kind) {
    return [...this.jobs.values()].find((job) => job.kind === kind) ?? null;
  }

  all() {
    return [...this.jobs.values()];
  }
}

// ---- QR code of a new pairing link (ISO/IEC 18004: byte mode, error correction level M) ----

// Error correction codewords per block, and blocks, at level M for versions 1–40.
const QR_EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

// Modules left for data and error correction once the fixed patterns are placed.
function qrRawModules(version) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    modules -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

const qrDataCodewords = (version) => Math.floor(qrRawModules(version) / 8) - QR_EC_PER_BLOCK[version] * QR_BLOCKS[version];

// Multiplication in GF(256) with the QR polynomial 0x11D.
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// Reed–Solomon: the generator polynomial of a degree, and the error correction bytes of a block.
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => (result[i] ^= gfMultiply(coefficient, factor)));
  }
  return result;
}

// The data as codewords: mode, length, bytes, terminator and padding, split into blocks with their error
// correction, then interleaved.
function qrCodewords(bytes, version) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = qrDataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const blockCount = QR_BLOCKS[version];
  const ecLength = QR_EC_PER_BLOCK[version];
  const raw = Math.floor(qrRawModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);
  const divisor = rsDivisor(ecLength);
  const blocks = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const chunk = data.slice(k, k + shortLength - ecLength + (i < shortBlocks ? 0 : 1));
    k += chunk.length;
    const block = [...chunk, ...rsRemainder(chunk, divisor)];
    if (i < shortBlocks) block.splice(chunk.length, 0, 0); // placeholder, so every block is as long
    blocks.push(block);
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - ecLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function qrAlignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = version * 4 + 10; positions.length < count; position -= step) positions.splice(1, 0, position);
  return positions;
}

const QR_MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The standard's penalty for a finished symbol: runs of five or more, 2×2 blocks, finder-like
// 1:1:3:1:1 patterns with four light modules on one side, and an unbalanced share of dark modules.
// It only decides which of the eight masks is used; every mask gives a valid code.
function qrPenalty(modules) {
  const size = modules.length;
  let penalty = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]);
    lines.push(modules.map((row) => row[i]));
  }
  for (const line of lines) {
    for (let start = 0; start < size; ) {
      let end = start;
      while (end < size && line[end] === line[start]) end++;
      if (end - start >= 5) penalty += end - start - 2;
      start = end;
    }
    // Around the symbol is the light margin, so a pattern at the edge still counts.
    const text = `0000${line.map((dark) => (dark ? "1" : "0")).join("")}0000`;
    for (const pattern of ["10111010000", "00001011101"]) {
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) penalty += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const dark = modules[y][x];
      if (modules[y][x + 1] === dark && modules[y + 1][x] === dark && modules[y + 1][x + 1] === dark) penalty += 3;
    }
  }
  const dark = modules.flat().filter(Boolean).length;
  penalty += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return penalty;
}

// A QR code for `text`: rows of "0" (light) and "1" (dark), without the margin. The smallest version that
// fits, and the mask with the lowest penalty unless one is given.
function qrCode(text, forcedMask = null) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  let version = 1;
  while (version <= 40 && qrDataCodewords(version) * 8 < 4 + (version < 10 ? 8 : 16) + bytes.length * 8) version++;
  if (version > 40) throw new Error("Too long for a QR code.");
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const alignments = qrAlignmentPositions(version);
  alignments.forEach((cx, i) => {
    alignments.forEach((cy, j) => {
      const nearFinder = (i === 0 && j === 0) || (i === 0 && j === alignments.length - 1) || (i === alignments.length - 1 && j === 0);
      if (nearFinder) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  const drawFormat = (mask) => {
    const data = mask; // level M's format bits are 00
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  const codewords = qrCodewords(bytes, version);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
        if (fixed[y][x] || bitIndex >= codewords.length * 8) continue;
        modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex++;
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && QR_MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  };
  let mask = forcedMask;
  if (mask === null) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(candidate);
      drawFormat(candidate);
      const penalty = qrPenalty(modules);
      if (penalty < best) [best, mask] = [penalty, candidate];
      applyMask(candidate);
    }
  }
  applyMask(mask);
  drawFormat(mask);
  return modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));
}

// ---- Provider cards: parsed status plus which variables are set (never their values) ----

const docker = (command) => `docker exec -it t3codebox ${command}`;
const TWO_METHODS = "Two sign-in methods are set; one of them is ignored.";

function card(id, name, { installed = true, version = null, ...fields }) {
  const base = { id, name, installed, version, signedIn: null, method: null, account: null, details: [], warnings: [], notes: [], signIn: null };
  return installed ? { ...base, ...fields } : base;
}

function claudeCard({ installed, version, status, env, loginStored }) {
  const usesKey = env.ANTHROPIC_API_KEY || status?.apiKeySource === "ANTHROPIC_API_KEY";
  const methods = [loginStored, env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY].filter(Boolean).length;
  const plan = status?.subscription ? ` (${status.subscription[0].toUpperCase()}${status.subscription.slice(1)} plan)` : "";
  const method =
    usesKey ? "API key from .env (ANTHROPIC_API_KEY)"
    : status?.apiKeySource ? `API key (${status.apiKeySource})`
    : status?.authMethod === "oauth_token" ? "Token from .env (CLAUDE_CODE_OAUTH_TOKEN)"
    : status?.authMethod === "claude.ai" ? `Claude login${plan}`
    : status?.authMethod && status.authMethod !== "none" ? status.authMethod
    : null;
  const warnings = [];
  if (usesKey) warnings.push("ANTHROPIC_API_KEY is in use: every request is billed to the API, not to a subscription.");
  if (methods > 1) warnings.push(TWO_METHODS);
  return card("claude", "Claude Code", {
    installed, version, method, warnings,
    signedIn: status ? status.signedIn : null,
    account: status?.email ?? null,
    signIn: status?.signedIn ? null : docker("claude auth login"),
  });
}

function codexCard({ installed, version, status, env }) {
  const method = status?.method === "chatgpt" ? "ChatGPT login" : status?.method === "api-key" ? "API key, stored by codex login" : null;
  const notes = [];
  if (status && !status.signedIn && env.OPENAI_API_KEY) {
    notes.push("OPENAI_API_KEY is set, but Codex does not count it as a sign-in. Store it with: printenv OPENAI_API_KEY | codex login --with-api-key");
  }
  if (status && !status.signedIn) notes.push("Turn on device code sign-in in ChatGPT's security settings first.");
  return card("codex", "Codex", {
    installed, version, method, notes,
    signedIn: status ? status.signedIn : null,
    warnings: status?.signedIn && env.OPENAI_API_KEY ? [TWO_METHODS] : [],
    signIn: status?.signedIn ? null : docker("codex login --device-auth"),
  });
}

function cursorCard({ installed, version, status, env }) {
  return card("cursor", "Cursor", {
    installed, version,
    signedIn: status ? status.signedIn : null,
    method: env.CURSOR_API_KEY ? "API key from .env (CURSOR_API_KEY)" : status?.signedIn ? "Cursor login" : null,
    account: status?.email ?? null,
    notes: status?.signedIn ? [] : ["No headless sign-in: set CURSOR_API_KEY in .env."],
  });
}

function grokCard({ installed, version, loginStored, env }) {
  return card("grok", "Grok Build", {
    installed, version,
    signedIn: Boolean(loginStored || env.XAI_API_KEY),
    method: env.XAI_API_KEY ? "API key from .env (XAI_API_KEY)" : loginStored ? "Grok login" : null,
    warnings: loginStored && env.XAI_API_KEY ? [TWO_METHODS] : [],
    signIn: loginStored || env.XAI_API_KEY ? null : docker("grok login --device-auth"),
  });
}

function opencodeCard({ installed, version, auth }) {
  const kinds = { oauth: "login", api: "API key" };
  const entries = auth
    ? [
        ...auth.credentials.map((c) => `${c.provider} (${kinds[c.type] || c.type || "stored"})`),
        ...auth.environment.map((e) => `${e.provider} (${e.variable})`),
      ]
    : [];
  const stored = new Set(auth?.credentials.map((c) => c.provider));
  const twice = auth ? [...new Set(auth.environment.filter((e) => stored.has(e.provider)).map((e) => e.provider))] : [];
  return card("opencode", "OpenCode", {
    installed, version,
    signedIn: auth ? entries.length > 0 : null,
    method: entries.join(", ") || null,
    warnings: twice.map((provider) => `${provider}: a stored sign-in and a variable are both set; one of them is ignored.`),
    signIn: auth && !entries.length ? docker("opencode auth login") : null,
  });
}

function githubCard({ installed, version, accounts }) {
  const active = (accounts ?? []).filter((a) => a.active);
  const ok = active.filter((a) => a.ok);
  const current = ok[0] ?? active[0];
  const hosts = new Set((accounts ?? []).map((a) => a.host));
  const twice = [...hosts].some((host) => {
    const onHost = accounts.filter((a) => a.host === host);
    return onHost.some((a) => a.envVariable) && onHost.some((a) => !a.envVariable);
  });
  const account = ok.map((a) => (a.host === "github.com" ? a.login : `${a.login} on ${a.host}`)).filter(Boolean).join(", ");
  return card("github", "GitHub", {
    installed, version,
    signedIn: accounts ? ok.length > 0 : null,
    method: current ? (current.envVariable ? `Token from .env (${current.envVariable})` : "gh login") : null,
    account: account || null,
    details: current?.scopes.length ? [`Scopes: ${current.scopes.join(", ")}`] : [],
    warnings: twice ? [TWO_METHODS] : [],
    notes: active.some((a) => !a.ok) ? ["GitHub did not accept the token."] : [],
    signIn: accounts && !ok.length ? docker("gh auth login") : null,
  });
}

// ---- Sign-in: password and per-device sessions ----

const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

function passwordMatches(input, password) {
  return typeof input === "string" && crypto.timingSafeEqual(sha256(input), sha256(password));
}

function passwordFingerprint(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString("hex") };
}

function generatePassword(length = 24) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => chars[crypto.randomInt(chars.length)]).join("");
}

// DASHBOARD_PASSWORD, or the one generated on first start and kept in the home volume (printed once).
function loadPassword(file = PASSWORD_FILE, env = process.env) {
  if (env.DASHBOARD_PASSWORD) return env.DASHBOARD_PASSWORD;
  const saved = (read(file) ?? "").trim();
  if (saved) return saved;
  const password = generatePassword();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
    console.log(`t3codebox: dashboard password: ${password}`);
    console.log(`t3codebox: printed only this once; later: docker exec t3codebox cat ${file}`);
  } catch (error) {
    console.log(`t3codebox: could not save ${file} (${error.code || error.message}); dashboard password until the next start: ${password}`);
  }
  return password;
}

// Signed-in dashboard devices, in the home volume so they survive restarts and updates. Stores a hash of
// each cookie, never the cookie. A session lasts a year from its last use. The file records a fingerprint
// of the password: a different password signs every device out.
class SessionStore {
  constructor(file, password, now = Date.now()) {
    this.file = file;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const samePassword = Boolean(data?.password?.salt) && passwordFingerprint(password, data.password.salt).hash === data.password.hash;
    this.password = samePassword ? data.password : passwordFingerprint(password);
    const saved = samePassword && Array.isArray(data.sessions) ? data.sessions : [];
    this.sessions = saved.filter((s) => now - s.lastUsedAt < YEAR_MS);
    this.savedAt = 0;
    if (!samePassword || this.sessions.length !== saved.length) this.save(now);
  }

  create(label, now = Date.now()) {
    const token = crypto.randomBytes(32).toString("base64url");
    const session = { id: crypto.randomBytes(9).toString("base64url"), hash: sha256(token).toString("hex"), label, createdAt: now, lastUsedAt: now };
    this.sessions.push(session);
    this.save(now);
    return { token, session };
  }

  // The session for a cookie, or null. Marks it used; the file is rewritten at most once a minute for that.
  lookup(token, now = Date.now()) {
    if (typeof token !== "string" || !token) return null;
    const hash = sha256(token).toString("hex");
    const session = this.sessions.find((s) => s.hash === hash);
    if (!session) return null;
    if (now - session.lastUsedAt >= YEAR_MS) {
      this.revoke(session.id, now);
      return null;
    }
    session.lastUsedAt = now;
    if (now - this.savedAt >= 60_000) this.save(now);
    return session;
  }

  revoke(id, now = Date.now()) {
    const count = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === count) return false;
    this.save(now);
    return true;
  }

  list(now = Date.now()) {
    return this.sessions
      .filter((s) => now - s.lastUsedAt < YEAR_MS)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  save(now = Date.now()) {
    this.savedAt = now;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify({ password: this.password, sessions: this.sessions }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      if (!this.warned) console.error(`t3codebox: could not save ${this.file} (${error.code || error.message}); dashboard sign-ins end at the next restart`);
      this.warned = true;
    }
  }
}

// ---- Collectors: read files, run CLIs ----

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const hasFile = (file) => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A CLI's output and exit code. Never rejects; `missing` means the command is not installed.
function run(command, args, timeout = 20_000) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd: HOME, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) =>
        resolve({
          missing: error?.code === "ENOENT",
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
    child.stdin?.end();
  });
}

// One run at a time: callers that arrive while it runs share its result.
function shared(fn) {
  let running = null;
  return () => (running ||= fn().finally(() => (running = null)));
}

function httpGet(options) {
  return new Promise((resolve) => {
    const request = http.get({ timeout: 3000, ...options }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body = (body + chunk).slice(0, 65536)));
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => resolve(null));
  });
}

// CLI versions, read once each: the image is the only way they change. An installed CLI that gave no
// version (a slow first start) is asked again on a later call, at most every 30 s, without making that
// call wait. `check(command)` returns { installed, version }.
const CLIS = { t3: "t3", claude: "claude", codex: "codex", cursor: "cursor-agent", grok: "grok", opencode: "opencode", gh: "gh", skills: "skills" };
function versionCache(check, now = () => performance.now()) {
  const versions = {};
  let running = null;
  let lastRun = -Infinity;
  return () => {
    const due = Object.keys(CLIS).filter((id) => !versions[id] || (versions[id].installed && !versions[id].version));
    if (due.length && !running && now() - lastRun >= 30_000) {
      lastRun = now();
      running = Promise.all(due.map(async (id) => (versions[id] = await check(CLIS[id])))).finally(() => (running = null));
    }
    return Object.keys(CLIS).every((id) => versions[id]) ? Promise.resolve(versions) : running.then(() => versions);
  };
}
const cliVersions = versionCache(async (command) => {
  const result = await run(command, ["--version"], 15_000);
  return { installed: !result.missing, version: parseVersion(result.stdout || result.stderr) };
});

let cpuSample = null;
function readCpu() {
  const usage = parseKeyValues(read("/sys/fs/cgroup/cpu.stat") ?? "").usage_usec;
  return usage === undefined ? null : { usage, at: performance.now() };
}

// Cores in use, averaged since the previous poll (or over half a second without a recent one).
async function cpuUsage() {
  let first = cpuSample;
  if (!first || performance.now() - first.at < 1000 || performance.now() - first.at > 60_000) {
    first = readCpu();
    if (!first) return null;
    await sleep(500);
  }
  const second = readCpu();
  if (!second) return null;
  cpuSample = second;
  return { used: (second.usage - first.usage) / ((second.at - first.at) * 1000), limit: parseCpuMax(read("/sys/fs/cgroup/cpu.max")) };
}

function processes() {
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {}
  const list = [];
  for (const pid of pids) {
    const stat = parseProcStat(read(`/proc/${pid}/stat`));
    if (!stat) continue;
    let exe = null;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {}
    list.push({ pid: stat.pid, ppid: stat.ppid, comm: stat.comm, exe });
  }
  return list;
}

function folder(mounts, dir) {
  const status = { path: dir, ...describeMount(mounts, dir), writable: false, free: null, total: null };
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    status.writable = true;
  } catch {}
  try {
    const fsStat = fs.statfsSync(dir);
    status.free = fsStat.bavail * fsStat.bsize;
    status.total = fsStat.blocks * fsStat.bsize;
  } catch {}
  return status;
}

async function t3Status() {
  const response = await httpGet({ host: "127.0.0.1", port: process.env.T3CODE_PORT || 3773, path: "/.well-known/t3/environment" });
  return { up: response?.status === 200, version: str(parseJson(response?.body)?.serverVersion) };
}

async function browserStatus() {
  const tool = process.env.BROWSER_MCP !== "off";
  const lookup = dns.lookup(process.env.BROWSER_HOST || "browser", { family: 4 }).catch(() => null);
  const found = await Promise.race([lookup, sleep(2000).then(() => null)]);
  if (!found) return { container: false, tool, devtools: false, version: null };
  const response = await httpGet({ host: found.address, port: process.env.BROWSER_DEVTOOLS_PORT || 9223, path: "/json/version", timeout: 2000 });
  return { container: true, tool, devtools: response?.status === 200, version: str(parseJson(response?.body)?.Browser) };
}

// The health section, polled every 5 s: files, Node's own view and two local HTTP checks; no CLIs.
async function health() {
  const [t3, browser, cpu, versions] = await Promise.all([t3Status(), browserStatus(), cpuUsage(), cliVersions()]);
  const mounts = parseMountinfo(read("/proc/self/mountinfo") ?? "");
  return {
    image: str(process.env.T3CODEBOX_VERSION),
    t3,
    versions: { ...Object.fromEntries(Object.entries(versions).map(([id, v]) => [id, v.version])), node: process.versions.node },
    uptime: { container: containerUptime(read("/proc/1/stat"), read("/proc/uptime")), host: os.uptime() },
    host: { cores: os.availableParallelism(), load: os.loadavg(), memory: os.totalmem() },
    cpu,
    memory: parseMemory(read("/sys/fs/cgroup/memory.current"), read("/sys/fs/cgroup/memory.max"), read("/sys/fs/cgroup/memory.stat")),
    mounts: { home: folder(mounts, HOME), workspace: folder(mounts, WORKSPACE) },
    agents: countAgents(processes()),
    browser,
  };
}

async function providers() {
  const versions = await cliVersions();
  const env = Object.fromEntries(
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY", "XAI_API_KEY"].map((name) => [name, Boolean(process.env[name])]),
  );
  const installed = (id) => versions[id].installed;
  const output = (id, command, args) => (installed(id) ? run(command, args).then((r) => r.stdout) : null);
  const [claude, codex, cursor, opencode, gh] = await Promise.all([
    output("claude", "claude", ["auth", "status", "--json"]),
    installed("codex") ? run("codex", ["login", "status"]).then((r) => r.stdout + r.stderr) : null,
    output("cursor", "cursor-agent", ["status", "--format", "json"]),
    output("opencode", "opencode", ["auth", "list"]),
    output("gh", "gh", ["auth", "status", "--json", "hosts"]),
  ]);
  return [
    claudeCard({ ...versions.claude, env, status: parseClaudeStatus(claude), loginStored: hasFile(path.join(HOME, ".claude", ".credentials.json")) }),
    codexCard({ ...versions.codex, env, status: codex === null ? null : parseCodexStatus(codex) }),
    cursorCard({ ...versions.cursor, env, status: parseCursorStatus(cursor) }),
    grokCard({ ...versions.grok, env, loginStored: hasFile(path.join(HOME, ".grok", "auth.json")) }),
    opencodeCard({ ...versions.opencode, auth: opencode === null ? null : parseOpencodeAuth(opencode) }),
    githubCard({ ...versions.gh, accounts: parseGhStatus(gh) }),
  ];
}

async function access() {
  const [sessions, pairings] = await Promise.all([
    run("t3", ["auth", "session", "list", "--json"]),
    run("t3", ["auth", "pairing", "list", "--json"]),
  ]);
  return { sessions: parseT3Sessions(sessions.stdout), pairings: parseT3Pairings(pairings.stdout) };
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function readSkill(dir) {
  const text = read(path.join(dir, "SKILL.md"));
  if (text === null) return null;
  const { name, description } = parseSkillFrontmatter(text);
  return { name: name || path.basename(dir), description };
}

// User skills per agent folder (where `npx skills add -g` installs). One skill linked into several
// folders is listed once, with every agent that has it. Project skills live in the repositories.
function skills() {
  const config = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "skills");
  const codexDir = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "skills");
  const folders = [
    ["Claude Code", claudeDir],
    ["Codex", codexDir],
    ["Cursor", path.join(HOME, ".cursor", "skills")],
    ["Grok Build", path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "skills")],
    ["OpenCode", path.join(config, "opencode", "skills")],
    ["Shared", path.join(HOME, ".agents", "skills")],
  ];
  const installed = new Map();
  for (const [agent, dir] of folders) {
    for (const entry of listDir(dir)) {
      if (dir === claudeDir && entry === "synced") continue;
      const skill = readSkill(path.join(dir, entry));
      if (!skill) continue;
      let key = path.join(dir, entry);
      try {
        key = fs.realpathSync(key);
      } catch {}
      const item = installed.get(key) ?? { ...skill, folder: entry, agents: [] };
      item.agents.push(agent);
      installed.set(key, item);
    }
  }
  const synced = listDir(path.join(claudeDir, "synced")).flatMap((org) =>
    listDir(path.join(claudeDir, "synced", org)).map((entry) => readSkill(path.join(claudeDir, "synced", org, entry))),
  );
  const builtIn = listDir(path.join(codexDir, ".system")).map((entry) => readSkill(path.join(codexDir, ".system", entry)));
  const sorted = (list) => list.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { installed: sorted([...installed.values()]), synced: sorted(synced), builtIn: sorted(builtIn) };
}

async function sizes() {
  const result = await run("du", ["-sk", HOME, WORKSPACE], 10 * 60_000);
  const parsed = parseDu(result.stdout);
  return { home: parsed[HOME] ?? null, workspace: parsed[WORKSPACE] ?? null };
}

// ---- Settings: actions ----

const lastLine = (text) => outputLines(text).pop() ?? "";

async function gitAuthor() {
  const [name, email] = await Promise.all([
    run("git", ["config", "--global", "--get", "user.name"]),
    run("git", ["config", "--global", "--get", "user.email"]),
  ]);
  const overrides = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"].filter((name) => process.env[name]);
  return { name: str(name.stdout.trim()), email: str(email.stdout.trim()), overrides };
}

async function setGitAuthor({ name, email }) {
  for (const [key, value] of [["user.name", name], ["user.email", email]]) {
    const result = await run("git", value ? ["config", "--global", key, value] : ["config", "--global", "--unset", key]);
    // --unset exits 5 when the key was not set.
    if (result.code !== 0 && !(result.code === 5 && !value)) throw new Error(lastLine(result.stderr) || `git config ${key} failed`);
  }
}

async function createPairing({ baseUrl, ttl, label }) {
  const result = await run("t3", ["auth", "pairing", "create", "--base-url", baseUrl, "--ttl", ttl, "--label", label, "--json"]);
  const pairing = parsePairingCreate(result.stdout);
  if (!pairing) throw new Error(lastLine(result.stderr) || "T3 did not create a pairing link.");
  return { ...pairing, qr: qrCode(pairing.pairUrl) };
}

// kind: "pairing" (an unused link) or "session" (a paired device).
async function revokeT3(kind, id) {
  const result = await run("t3", ["auth", kind, "revoke", id]);
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || lastLine(result.stdout) || `t3 auth ${kind} revoke failed`);
}

// Stops `t3 serve`; tini exits with it, and Docker's restart policy (unless-stopped in compose.yaml)
// starts the container again. The dashboard goes down with it and comes back.
function restartT3() {
  const pid = findT3Server(processes());
  if (!pid) return false;
  const signal = (name) => {
    try {
      process.kill(pid, name);
    } catch {}
  };
  setTimeout(() => {
    signal("SIGTERM");
    // As `docker stop` does: SIGKILL if T3 is still there after 10 s. Once T3 exits, the container
    // stops and takes this timer with it.
    setTimeout(() => signal("SIGKILL"), 10_000);
  }, 500);
  return true;
}

// Runs a CLI for a job: its output goes to the job's log as it comes. Resolves with stdout on exit 0,
// rejects with the last line of output otherwise.
function runLogged(command, args, log, { timeout = 5 * 60_000, logStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: HOME, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stdout = "";
    const add = (chunk) => {
      output = (output + chunk).slice(-200_000);
      log(output);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (logStdout) add(chunk);
    });
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error(`${command} is not installed.`) : error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(lastLine(output) || `${command} ${signal ? `was stopped (${signal})` : `exited with ${code}`}.`));
    });
  });
}

// Skills go to every installed agent: `skills` keeps one copy in ~/.agents/skills and links it where needed.
const SKILL_AGENTS = { claude: "claude-code", codex: "codex", cursor: "cursor", grok: "grok", opencode: "opencode" };

async function skillAgents() {
  const versions = await cliVersions();
  const agents = Object.entries(SKILL_AGENTS).filter(([id]) => versions[id]?.installed).map(([, agent]) => agent);
  if (!agents.length) throw new Error("No agent is installed.");
  return agents;
}

function listSkillsJob(jobs, source) {
  return jobs.start("skills", `Skills in ${source}`, async (log) => ({
    action: "list",
    source,
    skills: parseSkillsListing(await runLogged("skills", ["add", source, "-l"], log)),
  }));
}

function installSkillJob(jobs, source, skill) {
  return jobs.start("skills", `Installing ${skill} from ${source}`, async (log) => {
    const agents = await skillAgents();
    const output = await runLogged("skills", ["add", source, "--skill", skill, "-g", "-y", "--agent", ...agents, "--json"], log, { logStdout: false });
    const installed = parseSkillsAdd(output) ?? [];
    if (!installed.length) throw new Error(`${source} has no skill named ${skill}.`);
    const failed = installed.filter((s) => s.status !== "installed");
    if (failed.length) throw new Error(failed.map((s) => `${s.name}: ${s.error || s.status}`).join("; "));
    return { action: "install", source, installed };
  });
}

function removeSkillJob(jobs, folder) {
  return jobs.start("skills", `Removing ${folder}`, async (log) => {
    await runLogged("skills", ["remove", folder, "-g", "-y"], log);
    if (skills().installed.some((s) => s.folder === folder)) throw new Error(`skills did not remove ${folder}.`);
    return { action: "remove", folder };
  });
}

// ---- HTTP ----

function cookie(request, name) {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;

function send(response, status, body = "", headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

const sendJson = (response, status, data, headers = {}) =>
  send(response, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", ...headers });

// POST bodies must be JSON: a cross-site form cannot send that content type, which with the
// SameSite=Strict cookie keeps other sites from acting on the dashboard.
async function readJson(request) {
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) return null;
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) return null;
  }
  const data = parseJson(body);
  return data && typeof data === "object" ? data : null;
}

// The page's Content-Security-Policy allows exactly its own inline script and style.
function contentSecurityPolicy(page) {
  const hash = (tag) => {
    const match = page.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return match ? `'sha256-${crypto.createHash("sha256").update(match[1]).digest("base64")}'` : "'none'";
  };
  return [
    "default-src 'none'",
    `script-src ${hash("script")}`,
    `style-src ${hash("style")}`,
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function main() {
  const password = loadPassword();
  const store = new SessionStore(SESSIONS_FILE, password);
  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const icon = read(path.join(__dirname, "icon.svg"));
  const pageHeaders = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": contentSecurityPolicy(page), "X-Frame-Options": "DENY" };
  const sharedProviders = shared(providers);
  const sharedAccess = shared(access);
  const sharedSizes = shared(sizes);
  const jobs = new Jobs();

  // Wrong passwords wait a second each, one at a time.
  let signIns = Promise.resolve();
  const checkPassword = (input) => {
    const result = signIns.then(async () => passwordMatches(input, password) || (await sleep(1000), false));
    signIns = result.catch(() => {});
    return result;
  };

  async function handle(request, response) {
    const url = new URL(request.url, "http://dashboard");
    const route = `${request.method} ${url.pathname}`;
    const token = cookie(request, COOKIE);
    const session = store.lookup(token);

    if (route === "GET /") {
      // Opening the page renews the cookie, so a device in use stays signed in.
      return send(response, 200, page, session ? { ...pageHeaders, "Set-Cookie": sessionCookie(token, YEAR_MS / 1000) } : pageHeaders);
    }
    if (route === "GET /icon.svg" && icon) return send(response, 200, icon, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
    if (route === "POST /api/sign-in") {
      const body = await readJson(request);
      if (!body) return sendJson(response, 400, { error: "Expected JSON." });
      if (!(await checkPassword(body.password))) return sendJson(response, 401, { error: "Wrong password." });
      const created = store.create(userAgentLabel(request.headers["user-agent"]));
      return send(response, 204, "", { "Set-Cookie": sessionCookie(created.token, YEAR_MS / 1000) });
    }
    if (!url.pathname.startsWith("/api/")) return send(response, 404, "Not found");
    if (!session) return sendJson(response, 401, { error: "Sign in first." });

    const jobMatch = route.match(/^GET \/api\/jobs\/([0-9a-f]{12})$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "No such job." });
    }
    // Settings run a CLI; what it says when it fails goes back to the page.
    const act = async (action) => {
      try {
        return await action();
      } catch (error) {
        return sendJson(response, 502, { error: String(error?.message || error) });
      }
    };
    const startJob = ({ job, started }) => sendJson(response, started ? 202 : 200, { job, started });

    switch (route) {
      case "GET /api/status":
        return sendJson(response, 200, await health());
      case "GET /api/providers":
        return sendJson(response, 200, { providers: await sharedProviders() });
      case "GET /api/access":
        return sendJson(response, 200, await sharedAccess());
      case "GET /api/skills":
        return sendJson(response, 200, skills());
      case "GET /api/devices":
        return sendJson(response, 200, { devices: store.list().map((device) => ({ ...device, current: device.id === session.id })) });
      case "POST /api/devices/sign-out": {
        const body = await readJson(request);
        if (!body || typeof body.id !== "string") return sendJson(response, 400, { error: "Expected a device id." });
        if (!store.revoke(body.id)) return sendJson(response, 404, { error: "No such device." });
        return send(response, 204, "", body.id === session.id ? { "Set-Cookie": sessionCookie("", 0) } : {});
      }
      case "POST /api/sizes":
        if (!(await readJson(request))) return sendJson(response, 400, { error: "Expected JSON." });
        return sendJson(response, 200, await sharedSizes());
      case "GET /api/git":
        return sendJson(response, 200, await gitAuthor());
      case "POST /api/git": {
        const author = checkGitAuthor(await readJson(request));
        if (author.error) return sendJson(response, 400, author);
        return act(async () => {
          await setGitAuthor(author);
          return sendJson(response, 200, await gitAuthor());
        });
      }
      case "POST /api/pairing": {
        const pairing = checkPairingRequest(await readJson(request));
        if (pairing.error) return sendJson(response, 400, pairing);
        return act(async () => sendJson(response, 200, { pairing: await createPairing(pairing) }));
      }
      case "POST /api/pairing/revoke":
      case "POST /api/sessions/revoke": {
        const body = await readJson(request);
        if (!validId(body?.id)) return sendJson(response, 400, { error: "Expected an id." });
        return act(async () => {
          await revokeT3(route.includes("pairing") ? "pairing" : "session", body.id);
          return send(response, 204);
        });
      }
      case "POST /api/restart":
        if (!(await readJson(request))) return sendJson(response, 400, { error: "Expected JSON." });
        return restartT3() ? sendJson(response, 202, { restarting: true }) : sendJson(response, 409, { error: "T3's server process was not found." });
      case "GET /api/jobs":
        return sendJson(response, 200, { jobs: jobs.all() });
      case "POST /api/skills/list": {
        const body = await readJson(request);
        if (!validSkillSource(body?.source)) return sendJson(response, 400, { error: "Expected a GitHub owner/repo or an https URL." });
        return startJob(listSkillsJob(jobs, body.source));
      }
      case "POST /api/skills/install": {
        const body = await readJson(request);
        if (!validSkillSource(body?.source)) return sendJson(response, 400, { error: "Expected a GitHub owner/repo or an https URL." });
        if (!validSkillName(body?.skill)) return sendJson(response, 400, { error: "Expected a skill name." });
        return startJob(installSkillJob(jobs, body.source, body.skill));
      }
      case "POST /api/skills/remove": {
        const body = await readJson(request);
        if (!validSkillName(body?.folder) || !skills().installed.some((s) => s.folder === body.folder)) {
          return sendJson(response, 400, { error: "No such installed skill." });
        }
        return startJob(removeSkillJob(jobs, body.folder));
      }
      default:
        return sendJson(response, 404, { error: "Not found." });
    }
  }

  cliVersions();
  const server = http.createServer((request, response) =>
    handle(request, response).catch((error) => {
      console.error(`t3codebox: dashboard: ${request.method} ${request.url}: ${error.stack || error}`);
      if (!response.headersSent) sendJson(response, 500, { error: "Internal error." });
    }),
  );
  server.listen(PORT, () => console.log(`t3codebox: dashboard on port ${PORT}`));
}

module.exports = {
  parseVersion, parseMountinfo, describeMount, parseKeyValues, parseMemory, parseCpuMax, parseProcStat, containerUptime,
  agentOf, countAgents, parseClaudeStatus, parseCodexStatus, parseCursorStatus, parseOpencodeAuth, parseGhStatus,
  parseT3Sessions, parseT3Pairings, parsePairingCreate, parseSkillFrontmatter, parseDu, userAgentLabel, versionCache,
  outputLines, parseSkillsListing, parseSkillsAdd, validSkillSource, validSkillName, validId, checkGitAuthor,
  checkPairingRequest, findT3Server, Jobs, qrCode,
  claudeCard, codexCard, cursorCard, grokCard, opencodeCard, githubCard,
  passwordMatches, loadPassword, SessionStore,
};

if (require.main === module) main();
