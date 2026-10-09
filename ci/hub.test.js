// Unit tests for hub mode (rootfs/usr/local/lib/t3codebox-hub/hub.js): the settings, the checks of a hub's answers,
// and enrolment, renewal and leaving against a fake hub and a fake T3 Code, both real HTTP servers on loopback.
// T3's CLI and t3codebox-mcp are stand-ins that record their calls. `events` records, in order, what the box did to
// either side, so a test can tell what came first.
// Run: node --test ci/hub.test.js (make check runs it in node:lts-slim).
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { describe, test, beforeEach, afterEach } = require("node:test");
const h = require("../rootfs/usr/local/lib/t3codebox-hub/hub.js");

const DAY = 24 * 60 * 60 * 1000;
const CODE = "enrol-code-7f3a9c";
const KEY = "hub-key-0123456789abcdef";

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });

const body = (request) =>
  new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });

const json = (response, status, data, headers = {}) => {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(data));
};

// T3 Code: its environment, its token endpoint, and its CLI's pairing and session commands, sharing one store.
function fakeT3() {
  const t3 = { pairings: new Map(), sessions: [], tokens: new Map(), calls: [], n: 0, up: true };
  t3.cli = async (command, args) => {
    t3.calls.push([command, ...args]);
    events.push(["t3", args[1], args[2], args[3]]);
    const [, kind, verb, id] = args;
    if (command !== "t3") return { code: 1, stdout: "", stderr: "" };
    if (kind === "pairing" && verb === "create") {
      const n = ++t3.n;
      const pairing = { id: `pairing-${n}`, credential: `CRED${n}XXXXXXXX`, label: args[args.indexOf("--label") + 1] };
      t3.pairings.set(pairing.credential, pairing);
      return { code: 0, stdout: JSON.stringify(pairing), stderr: "" };
    }
    if (kind === "pairing" && verb === "revoke") return { code: 0, stdout: "", stderr: "" };
    if (kind === "session" && verb === "list") return { code: 0, stdout: JSON.stringify(t3.sessions.map(({ token, ...s }) => s)), stderr: "" };
    if (kind === "session" && verb === "revoke") {
      t3.sessions = t3.sessions.filter((s) => s.sessionId !== id);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  t3.handler = async (request, response) => {
    if (!t3.up) return json(response, 503, {});
    if (request.url === "/.well-known/t3/environment") {
      return json(response, 200, { environmentId: "env-1", label: "Test box", serverVersion: "0.0.45", orchestrationProtocolVersion: 1 });
    }
    if (request.method === "POST" && request.url === "/oauth/token") {
      const form = new URLSearchParams(await body(request));
      const pairing = t3.pairings.get(form.get("subject_token"));
      if (!pairing || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange") return json(response, 400, { error: "invalid_grant" });
      t3.pairings.delete(pairing.credential);
      const token = `t3-token-${pairing.id}-secret`;
      t3.sessions.push({ sessionId: `session-${pairing.id.split("-")[1]}`, client: { label: pairing.label }, token, scope: form.get("scope") });
      return json(response, 200, { access_token: token, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 30 * 24 * 3600, scope: form.get("scope") });
    }
    json(response, 404, {});
  };
  return t3;
}

// A hub: enrolment, renewal and leave endpoints whose answers each test sets. A leave answer of null is no answer.
function fakeHub(name = "hub") {
  const hub = { enrolments: [], renewals: [], leaves: [], requests: [] };
  hub.enrol = (request, data) => [200, {
    protocol: 1, boxId: "box-1", hub: { name: "Test hub" }, key: KEY,
    mcp: { name: "hub", url: `${hub.url}/mcp` }, renewalUrl: `${hub.url}/renew`, leaveUrl: `${hub.url}/leave`,
  }];
  hub.renew = () => [200, { protocol: 1 }];
  hub.leave = () => [204];
  hub.handler = async (request, response) => {
    const data = JSON.parse((await body(request)) || "null");
    hub.requests.push({ url: request.url, headers: request.headers, data });
    events.push([name, request.url]);
    if (request.url === "/enrol") {
      hub.enrolments.push(data);
      const [status, answer, headers] = hub.enrol(request, data);
      return json(response, status, answer, headers);
    }
    if (request.url === "/renew") {
      hub.renewals.push({ data, authorization: request.headers.authorization });
      const [status, answer, headers] = hub.renew(request, data);
      return json(response, status, answer, headers);
    }
    if (request.url === "/leave") {
      hub.leaves.push(request.headers.authorization);
      const answer = hub.leave(request, data);
      return answer && json(response, answer[0], answer[1]);
    }
    json(response, 404, {});
  };
  return hub;
}

let dir, t3, t3Server, hub, hubServer, clock, logs, mcpCalls, mcpAdded, events;

beforeEach(async () => {
  events = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3codebox-hub-"));
  t3 = fakeT3();
  ({ server: t3Server, url: t3.url } = await listen((q, r) => t3.handler(q, r)));
  hub = fakeHub();
  ({ server: hubServer, url: hub.url } = await listen((q, r) => hub.handler(q, r)));
  clock = Date.parse("2026-10-05T12:00:00Z");
  logs = [];
  mcpCalls = [];
  mcpAdded = ["claude", "codex", "cursor", "grok", "opencode"];
});

afterEach(() => {
  t3Server.close();
  hubServer.close();
  hubServer.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
});

function box(env = {}) {
  return new h.Hub({
    env: { T3CODEBOX_HUB_URL: `${hub.url}/enrol`, T3CODEBOX_HUB_CODE: CODE, T3CODEBOX_VERSION: "0.0.45-1", PATH: "", ...env },
    cli: (...args) => t3.cli(...args),
    mcp: async (action, name, agents, spec) => {
      mcpCalls.push({ action, name, agents, spec });
      events.push(["mcp", action, name]);
      return { code: 0, stdout: action === "add" ? mcpAdded.join("\n") : agents.join("\n"), stderr: "" };
    },
    now: () => clock,
    log: (text) => logs.push(text),
    random: () => 0.5,
    stateFile: path.join(dir, "hub.json"),
    requestFile: path.join(dir, "hub-request"),
    t3Url: t3.url,
    installed: (command) => ["claude", "codex", "grok"].includes(command),
  });
}

const state = () => JSON.parse(fs.readFileSync(path.join(dir, "hub.json"), "utf8"));

// Every secret the run handled, and everywhere it must not appear: log lines, CLI arguments, MCP arguments.
function assertNoSecretsLeaked() {
  const tokens = t3.sessions.map((s) => s.token).concat([...t3.pairings.keys()]);
  const seen = JSON.stringify([logs, t3.calls, mcpCalls.map(({ action, name, agents }) => [action, name, agents])]);
  for (const secret of [CODE, KEY, ...tokens, "t3-token-", "CRED"]) assert.ok(!seen.includes(secret), `${secret} leaked`);
}

describe("settings", () => {
  test("off without T3CODEBOX_HUB_URL; the code from the variable or a file", () => {
    assert.deepEqual(h.config({}), { url: null });
    assert.deepEqual(h.config({ T3CODEBOX_HUB_URL: "  " }), { url: null });
    const cfg = h.config({ T3CODEBOX_HUB_URL: "https://hub.example.test/enrol", T3CODEBOX_HUB_CODE: " abc " });
    assert.equal(cfg.url, "https://hub.example.test/enrol");
    assert.equal(cfg.code, "abc");
    const file = path.join(os.tmpdir(), `t3codebox-code-${process.pid}`);
    fs.writeFileSync(file, "from-file\n");
    assert.equal(h.config({ T3CODEBOX_HUB_URL: "http://hub:8080/enrol", T3CODEBOX_HUB_CODE_FILE: file }).code, "from-file");
    fs.rmSync(file);
    assert.match(h.config({ T3CODEBOX_HUB_URL: "http://hub/enrol", T3CODEBOX_HUB_CODE_FILE: "/nonexistent" }).codeError, /could not be read \(ENOENT\)/);
  });

  test("refuses addresses with a user, a fragment or another scheme, and codes with spaces", () => {
    for (const url of ["ftp://hub/enrol", "https://user:pw@hub/enrol", "https://hub/enrol#x", "not a url"]) {
      assert.ok(h.config({ T3CODEBOX_HUB_URL: url }).error, url);
    }
    const cfg = h.config({ T3CODEBOX_HUB_URL: "https://hub/enrol", T3CODEBOX_HUB_CODE: "two words" });
    assert.equal(cfg.code, null);
    assert.match(cfg.codeError, /not usable/);
  });

  test("backoff: 15 s doubling to 30 min with jitter, or Retry-After within 5 s to an hour", () => {
    assert.equal(h.backoff(0, null, () => 0.5), 15_000);
    assert.equal(h.backoff(3, null, () => 0.5), 120_000);
    assert.equal(h.backoff(99, null, () => 0.5), 1_800_000);
    assert.equal(h.backoff(0, null, () => 0), 12_000);
    assert.equal(h.backoff(0, "120"), 120_000);
    assert.equal(h.backoff(0, "0"), 5000);
    assert.equal(h.backoff(0, "99999"), 3_600_000);
  });

  test("renewal: a week before expiry, or when the hub asked, whichever is first", () => {
    const expiresAt = "2026-11-04T12:00:00.000Z";
    assert.equal(h.renewAt({ credential: { expiresAt } }), Date.parse(expiresAt) - 7 * DAY);
    assert.equal(h.renewAt({ credential: { expiresAt }, renewAfter: "2026-10-06T00:00:00Z" }), Date.parse("2026-10-06T00:00:00Z"));
    assert.equal(h.renewAt({}), Infinity);
  });
});

describe("a hub's answer", () => {
  const enrolUrl = "https://hub.example.test/api/enrol";
  const good = { protocol: 1, key: KEY, renewalUrl: "https://hub.example.test/api/renew", mcp: { name: "hub", url: "https://mcp.example.test/mcp" } };

  test("is used when it is complete", () => {
    const answer = h.checkEnrolment({ ...good, hub: { name: "My\nhub" }, renewAfter: "2026-10-10T00:00:00Z", boxId: "b-1" }, enrolUrl);
    assert.equal(answer.error, undefined);
    assert.equal(answer.hubName, "My hub");
    assert.deepEqual(answer.mcp, { name: "hub", url: "https://mcp.example.test/mcp" });
    assert.equal(answer.renewalUrl, "https://hub.example.test/api/renew");
    assert.equal(h.checkEnrolment({ ...good, mcp: null }, enrolUrl).mcp, null);
  });

  test("is refused when it could send the credential elsewhere, overwrite the browser's entry, or break a config file", () => {
    const refused = [
      { ...good, protocol: 2 },
      { ...good, key: undefined },
      { ...good, key: 'short' },
      { ...good, key: `${KEY}"\n[mcp_servers.evil]` },
      { ...good, renewalUrl: "https://elsewhere.example.test/renew" },
      { ...good, renewalUrl: "http://hub.example.test/api/renew" },
      { ...good, leaveUrl: "https://elsewhere.example.test/leave" },
      { ...good, mcp: { name: "browser", url: "https://mcp.example.test/mcp" } },
      { ...good, mcp: { name: "../../.bashrc", url: "https://mcp.example.test/mcp" } },
      { ...good, mcp: { name: "hub]\ncommand = \"/bin/sh\"", url: "https://mcp.example.test/mcp" } },
      { ...good, mcp: { name: "hub", url: "http://mcp.example.test/mcp" } },
      { ...good, mcp: { name: "hub", url: "file:///etc/passwd" } },
      { ...good, renewAfter: "soon" },
      null,
      "text",
    ];
    for (const answer of refused) assert.ok(h.checkEnrolment(answer, enrolUrl).error, JSON.stringify(answer));
    // A quote in an address is percent-encoded, so it cannot end a TOML or JSON string.
    assert.equal(h.checkEnrolment({ ...good, mcp: { name: "hub", url: 'https://mcp.example.test/"x' } }, enrolUrl).mcp.url, "https://mcp.example.test/%22x");
  });

  test("an http MCP server is fine when the enrolment itself is plain http (a hub on the same network)", () => {
    const answer = h.checkEnrolment({ ...good, renewalUrl: "http://hub:8080/renew", mcp: { name: "hub", url: "http://hub:8080/mcp" } }, "http://hub:8080/enrol");
    assert.equal(answer.error, undefined);
  });
});

describe("enrolment", () => {
  test("sends the code, the box and a token limited to two scopes; registers the MCP server; keeps no code", async () => {
    const wait = await box().step(null);
    assert.ok(wait > 0 && wait <= 60 * 60 * 1000);
    assert.equal(hub.enrolments.length, 1);
    const sent = hub.enrolments[0];
    assert.equal(sent.protocol, 1);
    assert.equal(sent.code, CODE);
    assert.deepEqual(sent.box, { name: "Test box", environmentId: "env-1", t3codebox: "0.0.45-1", t3code: "0.0.45", orchestrationProtocol: 1, agents: ["claude", "codex", "grok"], url: null });
    assert.equal(sent.t3code.tokenType, "Bearer");
    assert.deepEqual(sent.t3code.scopes, ["orchestration:read", "orchestration:operate"]);
    assert.equal(t3.sessions.length, 1);
    assert.equal(t3.sessions[0].scope, "orchestration:read orchestration:operate");
    assert.equal(sent.t3code.token, t3.sessions[0].token);
    assert.deepEqual(mcpCalls[0], { action: "add", name: "hub", agents: [], spec: { url: `${hub.url}/mcp`, headers: { Authorization: `Bearer ${KEY}` } } });
    const saved = state();
    assert.equal(saved.status, "connected");
    assert.equal(saved.hubName, "Test hub");
    assert.deepEqual(saved.mcp.agents, ["claude", "codex", "cursor", "grok", "opencode"]);
    assert.equal(saved.credential.sessionId, t3.sessions[0].sessionId);
    assert.equal((fs.statSync(path.join(dir, "hub.json")).mode & 0o777).toString(8), "600");
    assert.ok(!JSON.stringify(saved).includes(CODE), "the code is not kept");
    assert.ok(!JSON.stringify(saved).includes(t3.sessions[0].token), "a delivered token is not kept");
    assertNoSecretsLeaked();
  });

  test("T3CODEBOX_PUBLIC_URL goes to the hub as the box's address", async () => {
    await box({ T3CODEBOX_PUBLIC_URL: "https://box.example.test/" }).step(null);
    assert.equal(hub.enrolments[0].box.url, "https://box.example.test");
  });

  test("waits for T3 Code without contacting the hub", async () => {
    t3.up = false;
    assert.equal(await box().step(null), 5000);
    assert.equal(hub.enrolments.length, 0);
    assert.equal(state().status, "enrolling");
  });

  test("a hub that is down: tries again with backoff, with the same token, until it answers", async () => {
    const b = box();
    hub.enrol = () => [503, {}];
    assert.equal(await b.step(null), 15_000);
    assert.equal(await b.step(null), 30_000);
    hub.enrol = () => [429, {}, { "Retry-After": "90" }];
    assert.equal(await b.step(null), 90_000);
    assert.equal(state().status, "enrolling");
    assert.match(state().error, /HTTP 429/);
    hubServer.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const wait = await b.step(null);
    assert.ok(wait >= 96_000 && wait <= 144_000, String(wait));
    assert.match(state().error, /did not answer/);
    ({ server: hubServer, url: hub.url } = await listen((q, r) => hub.handler(q, r)));
    b.env.T3CODEBOX_HUB_URL = `${hub.url}/enrol`;
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew`, mcp: null }];
    // A new address is a new hub: the old attempt's token goes.
    await b.step(null);
    assert.equal(state().status, "connected");
    assert.equal(t3.sessions.length, 1, "one token for the hub, not one per attempt");
    assert.equal(logs.filter((l) => /HTTP 503/.test(l)).length, 1, "the same problem is logged once");
    assertNoSecretsLeaked();
  });

  test("the same token is reused across attempts", async () => {
    const b = box();
    hub.enrol = () => [502, {}];
    await b.step(null);
    await b.step(null);
    await b.step(null);
    const tokens = new Set(hub.enrolments.map((e) => e.t3code.token));
    assert.equal(tokens.size, 1);
    assert.equal(t3.sessions.length, 1);
  });

  test("a refused code: reported once, the token revoked, not tried again until a new code or Retry", async () => {
    hub.enrol = () => [403, { error: "invalid_code", message: "This code was\nalready used." }];
    const b = box();
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(state().status, "rejected");
    assert.match(state().error, /This code was already used/);
    assert.equal(t3.sessions.length, 0, "the hub's token is revoked");
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(await box().step(null), h.IDLE, "not after a restart either");
    assert.equal(hub.enrolments.length, 1);
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew` }];
    await box().step("retry");
    assert.equal(state().status, "connected");
    assertNoSecretsLeaked();
  });

  test("an answer it cannot use: reported, the token revoked, nothing registered", async () => {
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: "https://elsewhere.example.test/renew", mcp: { name: "hub", url: "https://x.test/mcp" } }];
    assert.equal(await box().step(null), h.IDLE);
    assert.equal(state().status, "error");
    assert.match(state().error, /origin/);
    assert.equal(mcpCalls.length, 0);
    assert.equal(t3.sessions.length, 0);
  });

  test("a redirect is not followed, so the code stays with the address it was meant for", async () => {
    let elsewhere = 0;
    const { server, url } = await listen((q, r) => {
      elsewhere++;
      json(r, 200, {});
    });
    hub.enrol = () => [307, {}, { Location: `${url}/steal` }];
    await box().step(null);
    server.close();
    assert.equal(elsewhere, 0);
    assert.equal(state().status, "enrolling");
  });

  test("a huge answer is not read into memory", async () => {
    const { server, url } = await listen((q, r) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end(`{"protocol":1,"key":"${"a".repeat(200_000)}"}`);
    });
    const answer = await h.postJson(globalThis.fetch, url, {});
    server.close();
    assert.equal(answer.status, 200);
    assert.equal(answer.body, null);
  });

  test("no code: an error on the dashboard, no request to the hub", async () => {
    assert.equal(await box({ T3CODEBOX_HUB_CODE: "" }).step(null), h.IDLE);
    assert.equal(state().status, "error");
    assert.match(state().error, /No enrolment code/);
    assert.equal(hub.enrolments.length, 0);
  });
});

describe("renewal", () => {
  test("a week before expiry: a new token with the box's key; the old one revoked once the hub has it", async () => {
    const b = box();
    await b.step(null);
    const first = state().credential.sessionId;
    clock += 22 * DAY;
    assert.ok((await b.step(null)) > 0);
    assert.equal(hub.renewals.length, 0, "not due yet");
    clock += 2 * DAY;
    await b.step(null);
    assert.equal(hub.renewals.length, 1);
    assert.equal(hub.renewals[0].authorization, `Bearer ${KEY}`);
    assert.equal(hub.renewals[0].data.t3code.token, t3.sessions.find((s) => s.sessionId === state().credential.sessionId).token);
    assert.notEqual(state().credential.sessionId, first);
    assert.equal(t3.sessions.length, 1, "the old token is revoked");
    assertNoSecretsLeaked();
  });

  test("when the hub asks for it with renewAfter", async () => {
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew`, renewAfter: "2026-10-05T13:00:00Z" }];
    const b = box();
    assert.equal(await b.step(null), 60 * 60 * 1000);
    clock += 60 * 60 * 1000;
    hub.renew = () => [200, { protocol: 1, renewAfter: "2026-10-06T13:00:00Z" }];
    await b.step(null);
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().renewAfter, "2026-10-06T13:00:00.000Z");
  });

  test("a box that was off past the expiry renews on its own when it starts", async () => {
    await box().step(null);
    clock += 45 * DAY;
    await box().step(null);
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().status, "connected");
  });

  test("a hub that is down during renewal: tried again with backoff, with the same new token", async () => {
    const b = box();
    await b.step(null);
    clock += 24 * DAY;
    hub.renew = () => [500, {}];
    assert.equal(await b.step(null), 15_000);
    clock += 15_000;
    await b.step(null);
    assert.equal(new Set(hub.renewals.map((r) => r.data.t3code.token)).size, 1);
    assert.equal(state().status, "connected", "the hub's current token still works meanwhile");
    hub.renew = () => [200, { protocol: 1 }];
    clock += 60_000;
    await b.step(null);
    assert.equal(state().error, null);
    assert.equal(t3.sessions.length, 1);
  });

  test("a token revoked on the box is not replaced behind its owner's back: Renew now does that", async () => {
    const b = box();
    await b.step(null);
    t3.sessions = [];
    clock += 61 * 60 * 1000;
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(hub.renewals.length, 0);
    assert.equal(state().status, "error");
    assert.match(state().error, /revoked on this box/);
    clock += 10 * 24 * 60 * 60 * 1000;
    assert.equal(await b.step(null), h.IDLE);
    await b.step("retry");
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().status, "connected");
  });

  test("a hub cannot make the box renew more than once an hour, whatever renewAfter says", async () => {
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew`, renewAfter: "2020-01-01T00:00:00Z" }];
    hub.renew = () => [200, { protocol: 1, renewAfter: "2020-01-01T00:00:00Z" }];
    const b = box();
    for (let i = 0; i < 10; i++) {
      const wait = await b.step(null);
      clock += Math.min(wait, 60 * 60 * 1000);
    }
    assert.ok(hub.renewals.length <= 10 && hub.renewals.length >= 8, String(hub.renewals.length));
    const pairings = t3.calls.filter((c) => c[2] === "pairing" && c[3] === "create").length;
    assert.equal(pairings, hub.renewals.length + 1, "one token per hour at most");
    assert.ok(clock - Date.parse("2026-10-05T12:00:00Z") >= hub.renewals.length * 60 * 60 * 1000);
  });

  test("a hub that no longer knows the box: an error, and no more renewals until Retry or a new code", async () => {
    const b = box();
    await b.step(null);
    hub.renew = () => [401, { error: "unknown_box" }];
    await b.step("retry");
    assert.equal(state().status, "error");
    assert.match(state().error, /no longer accepts this box: unknown_box/);
    clock += 30 * DAY;
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(hub.renewals.length, 1);
  });
});

describe("tokens the box cannot take back", () => {
  test("a token whose T3 session is not listed is never handed out", async () => {
    const list = t3.cli;
    t3.cli = async (command, args) => (args[1] === "session" && args[2] === "list" ? { code: 1, stdout: "", stderr: "" } : list(command, args));
    assert.equal(await box().step(null), 15_000);
    assert.equal(hub.enrolments.length, 0);
    assert.match(state().error, /session is not listed/);
  });

  test("a token with other scopes than asked for is revoked at once", async () => {
    const handler = t3.handler;
    t3.handler = async (request, response) => {
      if (request.url !== "/oauth/token") return handler(request, response);
      const form = new URLSearchParams(await body(request));
      const pairing = t3.pairings.get(form.get("subject_token"));
      t3.sessions.push({ sessionId: "session-wide", client: { label: pairing.label }, token: "t3-token-wide" });
      json(response, 200, { access_token: "t3-token-wide", token_type: "Bearer", expires_in: 100, scope: "orchestration:read orchestration:operate terminal:operate" });
    };
    await box().step(null);
    assert.equal(hub.enrolments.length, 0);
    assert.equal(t3.sessions.length, 0);
    assert.match(state().error, /other scopes/);
  });

  test("a revocation that fails is tried again, and leaving waits for it", async () => {
    await box().step(null);
    const cli = t3.cli;
    t3.cli = async (command, args) => (args[2] === "revoke" ? { code: 1, stdout: "", stderr: "busy" } : cli(command, args));
    const off = box({ T3CODEBOX_HUB_URL: "" });
    assert.equal(await off.step(null), 30_000);
    assert.equal(state().leaving, true);
    assert.equal(hub.leaves.length, 0, "the hub is told only once its tokens are revoked");
    assert.equal(mcpCalls.filter((c) => c.action === "remove").length, 1);
    t3.cli = cli;
    assert.equal(await off.step(null), h.DONE);
    assert.equal(t3.sessions.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, "hub.json")));
    assert.deepEqual(hub.leaves, [`Bearer ${KEY}`], "the hub is told once, with the key");
    assert.equal(mcpCalls.filter((c) => c.action === "remove").length, 1);
  });

  test("an old token that could not be revoked after a renewal is revoked at a later step", async () => {
    const b = box();
    await b.step(null);
    const cli = t3.cli;
    t3.cli = async (command, args) => (args[2] === "revoke" ? { code: 1, stdout: "", stderr: "busy" } : cli(command, args));
    clock += 24 * DAY;
    await b.step(null);
    assert.equal(state().stale.length, 1);
    assert.equal(t3.sessions.length, 2);
    t3.cli = cli;
    await b.step(null);
    assert.deepEqual(state().stale, []);
    assert.equal(t3.sessions.length, 1);
  });
});

describe("settings that change", () => {
  test("a typo in the address leaves an enrolment as it is, and it carries on once fixed", async () => {
    await box().step(null);
    assert.equal(await box({ T3CODEBOX_HUB_URL: "ftp://typo" }).step(null), h.IDLE);
    assert.equal(state().status, "connected");
    clock += 24 * DAY;
    await box().step(null);
    assert.equal(hub.renewals.length, 1);
  });

  test("registration is tried again when t3codebox-mcp could not run", async () => {
    const b = box();
    const mcp = b.mcp;
    b.mcp = async () => ({ code: 1, stdout: "", stderr: "" });
    await b.step(null);
    assert.equal(b.registered, false);
    b.mcp = mcp;
    await b.step(null);
    assert.equal(b.registered, true);
    assert.deepEqual(state().mcp.agents, ["claude", "codex", "cursor", "grok", "opencode"]);
  });
});

describe("leaving", () => {
  test("hub mode off: the entries this box added go, its tokens are revoked, the hub is told, the state forgotten", async () => {
    mcpAdded = ["claude", "grok"];
    await box().step(null);
    assert.equal(t3.sessions.length, 1);
    assert.equal(await box({ T3CODEBOX_HUB_URL: "" }).step(null), h.DONE);
    const removal = mcpCalls.find((c) => c.action === "remove");
    assert.deepEqual(removal, { action: "remove", name: "hub", agents: ["claude", "grok"], spec: { url: `${hub.url}/mcp` } });
    assert.equal(t3.sessions.length, 0);
    assert.deepEqual(hub.leaves, [`Bearer ${KEY}`]);
    assert.ok(!fs.existsSync(path.join(dir, "hub.json")));
    assert.equal(await box({ T3CODEBOX_HUB_URL: "" }).step(null), h.DONE, "and nothing on later starts");
    assertNoSecretsLeaked();
  });

  test("Leave on the dashboard: everything removed, and the same code is not tried again", async () => {
    await box().step(null);
    await box().step("leave");
    assert.equal(state().status, "left");
    assert.equal(t3.sessions.length, 0);
    assert.equal(mcpCalls.filter((c) => c.action === "remove").length, 1);
    assert.equal(await box().step(null), h.IDLE);
    assert.equal(hub.enrolments.length, 1);
  });

  test("a new code enrols again from the start; a new address leaves the old hub first", async () => {
    await box().step(null);
    await box({ T3CODEBOX_HUB_CODE: "another-code" }).step(null);
    assert.equal(hub.enrolments.length, 2);
    assert.equal(hub.leaves.length, 1);
    assert.equal(t3.sessions.length, 1);
    const other = fakeHub();
    const { server, url } = await listen((q, r) => other.handler(q, r));
    other.url = url;
    await box({ T3CODEBOX_HUB_URL: `${url}/enrol`, T3CODEBOX_HUB_CODE: "another-code" }).step(null);
    server.close();
    assert.equal(hub.leaves.length, 2);
    assert.equal(other.enrolments.length, 1);
    assert.equal(t3.sessions.length, 1);
  });
});

// ---- The box's side of docs/hub.md, case by case: renewal, the 401 rule, leaving, enrolment refusals ----

const HOUR = 60 * 60 * 1000;
const view = (b) => h.publicState(state(), h.config(b.env));
const leaveRequests = (from = hub) => from.requests.filter((r) => r.url === "/leave");
// Where in `events` something happened first; -1 when it did not.
const at = (...event) => events.findIndex((e) => JSON.stringify(e.slice(0, event.length)) === JSON.stringify(event));
const failRevocations = () => {
  const cli = t3.cli;
  t3.cli = async (command, args) => (args[2] === "revoke" ? { code: 1, stdout: "", stderr: "busy" } : cli(command, args));
  return () => (t3.cli = cli);
};
async function otherHub(answer = null) {
  const other = fakeHub("other");
  const { server, url } = await listen((q, r) => other.handler(q, r));
  other.url = url;
  other.server = server;
  if (answer) other.enrol = () => [200, answer(url)];
  return other;
}

describe("renewal, as docs/hub.md schedules it", () => {
  test("a week before the hub's token expires, not a minute sooner; the 2xx replaces the token and schedules the next", async () => {
    const b = box();
    await b.step(null);
    const enrolment = hub.enrolments[0];
    let expiry = Date.parse(state().credential.expiresAt);
    assert.equal(expiry, clock + 30 * DAY);
    for (let n = 1; n <= 2; n++) {
      clock = expiry - 7 * DAY - 60_000;
      assert.equal(await b.step(null), 60_000);
      assert.equal(hub.renewals.length, n - 1, "not due yet");
      clock += 60_000;
      const before = state().credential.sessionId;
      const wait = await b.step(null);
      assert.equal(hub.renewals.length, n);
      const sent = hub.renewals[n - 1];
      assert.equal(sent.authorization, `Bearer ${KEY}`);
      assert.equal(sent.data.protocol, 1);
      assert.deepEqual(sent.data.box, enrolment.box);
      assert.equal(sent.data.code, undefined, "the code is never sent again");
      const now = state();
      assert.notEqual(now.credential.sessionId, before, "the hub's answer replaces the stored token");
      assert.equal(sent.data.t3code.token, t3.sessions.find((s) => s.sessionId === now.credential.sessionId).token);
      assert.deepEqual(sent.data.t3code.scopes, ["orchestration:read", "orchestration:operate"]);
      assert.equal(sent.data.t3code.expiresAt, now.credential.expiresAt);
      assert.equal(now.pending, null);
      assert.equal(now.renewedAt, new Date(clock).toISOString());
      assert.deepEqual(t3.sessions.map((s) => s.sessionId), [now.credential.sessionId], "the old token is revoked");
      expiry = Date.parse(now.credential.expiresAt);
      assert.equal(expiry, clock + 30 * DAY);
      assert.equal(view(b).renewBy, new Date(expiry - 7 * DAY).toISOString());
      assert.equal(wait, HOUR, "the box looks again within the hour");
    }
    assert.notEqual(hub.renewals[0].data.t3code.token, hub.renewals[1].data.t3code.token);
    assertNoSecretsLeaked();
  });

  for (const status of [201, 202, 204]) {
    test(`a ${status} is a renewal done as well, with or without a body`, async () => {
      const b = box();
      await b.step(null);
      const first = state().credential.sessionId;
      clock += 24 * DAY;
      hub.renew = () => [status, status === 204 ? undefined : { protocol: 1 }];
      await b.step(null);
      const now = state();
      assert.equal(now.status, "connected");
      assert.equal(now.error, null);
      assert.notEqual(now.credential.sessionId, first);
      assert.deepEqual(t3.sessions.map((s) => s.sessionId), [now.credential.sessionId]);
      clock += HOUR;
      await b.step(null);
      assert.equal(hub.renewals.length, 1, "and the next one is on the schedule again");
    });
  }

  test("renewAfter in the hub's answer: sooner than the schedule, the box renews then; later, the schedule wins", async () => {
    const b = box();
    await b.step(null);
    clock += 24 * DAY;
    const asked = new Date(clock + 2 * DAY).toISOString();
    hub.renew = () => [200, { protocol: 1, renewAfter: asked }];
    await b.step(null);
    assert.equal(state().renewAfter, asked);
    assert.equal(view(b).renewBy, asked);
    clock = Date.parse(asked) - 60_000;
    assert.equal(await b.step(null), 60_000);
    assert.equal(hub.renewals.length, 1);
    clock += 60_000;
    hub.renew = () => [200, { protocol: 1, renewAfter: new Date(clock + 40 * DAY).toISOString() }];
    await b.step(null);
    assert.equal(hub.renewals.length, 2, "renewed when the hub asked, 21 days ahead of the schedule");
    const expiry = Date.parse(state().credential.expiresAt);
    assert.equal(h.renewAt(state()), expiry - 7 * DAY);
    clock = expiry - 7 * DAY - 60_000;
    await b.step(null);
    assert.equal(hub.renewals.length, 2);
    clock += 60_000;
    hub.renew = () => [200, { protocol: 1 }];
    await b.step(null);
    assert.equal(hub.renewals.length, 3);
    assert.equal(state().renewAfter, null, "an answer without renewAfter clears the last one");
  });

  test("a renewAfter that is not a time, or in an answer of another protocol version, is not used", async () => {
    const b = box();
    await b.step(null);
    const soon = () => new Date(clock + 2 * DAY).toISOString();
    for (const answer of [() => ({ protocol: 1, renewAfter: "soon" }), () => ({ protocol: 1, renewAfter: Date.now() }), () => ({ protocol: 2, renewAfter: soon() })]) {
      clock += 24 * DAY;
      hub.renew = () => [200, answer()];
      const n = hub.renewals.length;
      await b.step(null);
      assert.equal(hub.renewals.length, n + 1);
      assert.equal(state().renewAfter, null, JSON.stringify(answer()));
      assert.equal(h.renewAt(state()), Date.parse(state().credential.expiresAt) - 7 * DAY);
    }
  });

  test("never sooner than an hour after the last renewal, whatever renewAfter says; Renew now is the owner's and is not held back", async () => {
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew`, renewAfter: "2020-01-01T00:00:00Z" }];
    hub.renew = () => [200, { protocol: 1, renewAfter: "2020-01-01T00:00:00Z" }];
    const b = box();
    assert.equal(await b.step(null), HOUR, "not at once after the enrolment");
    for (let n = 1; n <= 3; n++) {
      clock += HOUR - 1000;
      assert.equal(await b.step(null), 1000);
      assert.equal(hub.renewals.length, n - 1, "a second short of the hour");
      clock += 1000;
      assert.equal(await b.step(null), HOUR);
      assert.equal(hub.renewals.length, n, "on the hour");
    }
    await b.step("retry");
    assert.equal(hub.renewals.length, 4);
  });

  test("a box that was off past the expiry renews on its own, even when T3 has dropped the expired token's session", async () => {
    await box().step(null);
    clock += 45 * DAY;
    t3.sessions = [];
    await box().step(null);
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().status, "connected");
  });
});

describe("the 401 rule", () => {
  for (const status of [401, 403, 404, 410]) {
    test(`a ${status} to a renewal: the box stops renewing, says so on its dashboard, and renews again only on Renew now`, async () => {
      const b = box();
      await b.step(null);
      clock += 24 * DAY;
      hub.renew = () => [status, { error: "unknown_box", message: "This hub does not know this box." }];
      assert.equal(await b.step(null), h.IDLE);
      assert.equal(hub.renewals.length, 1);
      const refused = hub.renewals[0].data.t3code.token;
      assert.ok(!t3.sessions.some((s) => s.token === refused), "the token the hub refused is revoked");
      assert.equal(state().status, "error");
      assert.equal(state().pending, null);
      assert.equal(view(b).status, "error");
      assert.equal(view(b).enrolled, true, "the card offers Renew now and Leave");
      assert.match(view(b).error, /^The hub no longer accepts this box: This hub does not know this box\. /);
      // Not on the schedule, not past the expiry, not after a restart.
      for (const days of [1, 7, 30]) {
        clock += days * DAY;
        assert.equal(await b.step(null), h.IDLE);
        assert.equal(await box().step(null), h.IDLE);
      }
      assert.equal(hub.renewals.length, 1);
      hub.renew = () => [200, { protocol: 1 }];
      await box().step("retry");
      assert.equal(hub.renewals.length, 2);
      assert.equal(state().status, "connected");
      assert.equal(state().error, null);
      assert.deepEqual(t3.sessions.map((s) => s.sessionId), [state().credential.sessionId]);
      assertNoSecretsLeaked();
    });
  }

  for (const [status, headers, wait] of [[400, {}, 15_000], [408, {}, 15_000], [409, {}, 15_000], [422, {}, 15_000], [429, { "Retry-After": "90" }, 90_000], [502, {}, 15_000]]) {
    test(`a ${status} to a renewal is not the 401 rule: tried again with backoff, with the same new token`, async () => {
      const b = box();
      await b.step(null);
      clock += 24 * DAY;
      hub.renew = () => [status, { error: "busy" }, headers];
      assert.equal(await b.step(null), wait);
      assert.equal(state().status, "connected");
      assert.match(state().error, new RegExp(`HTTP ${status}`));
      clock += wait;
      assert.equal(await b.step(null), status === 429 ? 90_000 : 30_000);
      assert.equal(hub.renewals.length, 2);
      assert.equal(new Set(hub.renewals.map((r) => r.data.t3code.token)).size, 1);
      hub.renew = () => [200, { protocol: 1 }];
      clock += HOUR;
      await b.step(null);
      assert.equal(hub.renewals.length, 3);
      assert.equal(state().error, null);
      assert.deepEqual(t3.sessions.map((s) => s.sessionId), [state().credential.sessionId]);
    });
  }

  test("no answer to a renewal is not the 401 rule either", async () => {
    const b = box();
    await b.step(null);
    clock += 24 * DAY;
    hubServer.close();
    hubServer.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await b.step(null), 15_000);
    assert.equal(state().status, "connected");
    assert.match(state().error, /^Renewal: the hub did not answer/);
  });

  test("a token revoked by hand shortly before a renewal the hub asked for is not replaced", async () => {
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew`, renewAfter: new Date(clock + 90 * 60 * 1000).toISOString() }];
    const b = box();
    await b.step(null);
    clock += HOUR;
    assert.equal(await b.step(null), 30 * 60 * 1000, "the hourly look: the token is there");
    t3.sessions = [];
    clock += 30 * 60 * 1000;
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(hub.renewals.length, 0);
    assert.equal(state().status, "error");
    assert.match(view(b).error, /revoked on this box\. Renew now gives the hub a new token/);
    assert.equal(await box().step(null), h.IDLE, "nor after a restart");
    await b.step("retry");
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().status, "connected");
  });

  test("a token revoked by hand while the hub is down is not replaced at the next attempt", async () => {
    const b = box();
    await b.step(null);
    clock += 24 * DAY;
    hub.renew = () => [503, {}];
    assert.equal(await b.step(null), 15_000);
    const current = state().credential.sessionId;
    t3.sessions = t3.sessions.filter((s) => s.sessionId !== current);
    clock += 15_000;
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().status, "error");
    assert.equal(state().nextAttemptAt, null);
    // The token sent in the renewal that got no answer may have reached the hub: it goes too.
    assert.equal(state().pending, null);
    assert.equal(t3.sessions.length, 0);
    await b.step("retry");
    assert.equal(hub.renewals.length, 2);
    assert.notEqual(hub.renewals[1].data.t3code.token, hub.renewals[0].data.t3code.token, "Renew now sends a new token");
  });

  test("Renew now is the owner asking: it renews even a token revoked by hand that the box has not noticed yet", async () => {
    const b = box();
    await b.step(null);
    clock += HOUR;
    await b.step(null);
    t3.sessions = [];
    await b.step("retry");
    assert.equal(hub.renewals.length, 1);
    assert.equal(state().status, "connected");
  });
});

describe("leaving, as docs/hub.md has it", () => {
  test("a new address: the old hub's entries go and its tokens are revoked, then it is told with its key, then the new hub enrols", async () => {
    await box().step(null);
    const old = state().credential.sessionId;
    const other = await otherHub((url) => ({ protocol: 1, key: "other-key-0123456789abcdef", renewalUrl: `${url}/renew`, mcp: { name: "other", url: `${url}/mcp` } }));
    events = [];
    await box({ T3CODEBOX_HUB_URL: `${other.url}/enrol` }).step(null);
    other.server.close();
    const order = [at("mcp", "remove", "hub"), at("t3", "session", "revoke", old), at("hub", "/leave"), at("t3", "pairing", "create"), at("other", "/enrol"), at("mcp", "add", "other")];
    assert.ok(order.every((i) => i >= 0), JSON.stringify(events));
    assert.deepEqual([...order].sort((a, b) => a - b), order, JSON.stringify(events));
    assert.equal(leaveRequests().length, 1);
    assert.equal(leaveRequests()[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(leaveRequests()[0].data, { protocol: 1 });
    assert.equal(other.enrolments[0].code, CODE);
    assert.equal(state().status, "connected");
    assert.equal(state().key, "other-key-0123456789abcdef");
    assert.deepEqual(t3.sessions.map((s) => s.sessionId), [state().credential.sessionId]);
  });

  test("an old hub that cannot be reached: the box leaves it anyway and enrols with the new one", async () => {
    await box().step(null);
    hubServer.close();
    hubServer.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = await otherHub();
    await box({ T3CODEBOX_HUB_URL: `${other.url}/enrol` }).step(null);
    other.server.close();
    assert.equal(other.enrolments.length, 1);
    assert.equal(state().status, "connected");
    assert.equal(mcpCalls.filter((c) => c.action === "remove").length, 1);
    assert.deepEqual(t3.sessions.map((s) => s.sessionId), [state().credential.sessionId]);
  });

  test("hub mode off while the hub cannot be reached: the box leaves, revokes and forgets all the same", async () => {
    await box().step(null);
    hubServer.close();
    hubServer.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await box({ T3CODEBOX_HUB_URL: "" }).step(null), h.DONE);
    assert.equal(t3.sessions.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, "hub.json")));
  });

  test("a hub that refuses the leave gets one request and no more", async () => {
    await box().step(null);
    hub.leave = () => [500, { error: "busy" }];
    assert.equal(await box({ T3CODEBOX_HUB_URL: "" }).step(null), h.DONE);
    assert.equal(await box({ T3CODEBOX_HUB_URL: "" }).step(null), h.DONE);
    assert.equal(leaveRequests().length, 1);
    assert.equal(t3.sessions.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, "hub.json")));
  });

  test("a hub that never answers the leave holds the box up for 5 seconds at most", async () => {
    await box().step(null);
    hub.leave = () => null;
    const started = Date.now();
    assert.equal(await box({ T3CODEBOX_HUB_URL: "" }).step(null), h.DONE);
    const took = Date.now() - started;
    assert.ok(took >= 4500 && took < 10_000, String(took));
    assert.equal(leaveRequests().length, 1);
    assert.ok(!fs.existsSync(path.join(dir, "hub.json")));
  });

  test("a token from an earlier renewal that could not be revoked then: the hub is told only once it is", async () => {
    const b = box();
    await b.step(null);
    const old = state().credential.sessionId;
    const restore = failRevocations();
    clock += 24 * DAY;
    await b.step(null);
    assert.deepEqual(state().stale, [old]);
    restore();
    const cli = t3.cli;
    t3.cli = async (command, args) => (args[2] === "revoke" && args[3] === old ? { code: 1, stdout: "", stderr: "busy" } : cli(command, args));
    const off = box({ T3CODEBOX_HUB_URL: "" });
    assert.equal(await off.step(null), 30_000);
    assert.equal(leaveRequests().length, 0);
    t3.cli = cli;
    assert.equal(await off.step(null), h.DONE);
    assert.equal(leaveRequests().length, 1);
    assert.equal(t3.sessions.length, 0);
  });

  test("a hub that gave no leave address is not contacted", async () => {
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew` }];
    await box().step(null);
    await box().step("leave");
    assert.equal(state().status, "left");
    assert.deepEqual(hub.requests.map((r) => r.url), ["/enrol"]);
    assert.equal(t3.sessions.length, 0);
  });

  test("Leave on the dashboard: tokens revoked, then the hub told with the key; Retry enrols again with the same code", async () => {
    const b = box();
    await b.step(null);
    const old = state().credential.sessionId;
    events = [];
    assert.equal(await b.step("leave"), h.IDLE);
    assert.ok(at("t3", "session", "revoke", old) >= 0 && at("t3", "session", "revoke", old) < at("hub", "/leave"), JSON.stringify(events));
    assert.equal(leaveRequests()[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(leaveRequests()[0].data, { protocol: 1 });
    assert.ok(!state().key, "the key is forgotten");
    assert.equal(view(b).enrolled, false);
    await b.step("retry");
    assert.equal(hub.enrolments.length, 2);
    assert.equal(hub.enrolments[1].code, CODE);
    assert.equal(state().status, "connected");
  });

  test("a new code whose leave had to wait for T3: the box enrols with it once the old tokens are revoked", async () => {
    await box().step(null);
    const restore = failRevocations();
    const b = box({ T3CODEBOX_HUB_CODE: "another-code" });
    assert.equal(await b.step(null), 30_000);
    assert.equal(leaveRequests().length, 0);
    restore();
    assert.ok(Number.isFinite(await b.step(null)), "not idle until someone presses Retry");
    assert.equal(leaveRequests().length, 1);
    await b.step(null);
    assert.equal(hub.enrolments.length, 2);
    assert.equal(hub.enrolments[1].code, "another-code");
    assert.equal(state().status, "connected");
    assert.equal(t3.sessions.length, 1);
  });
});

describe("enrolment refusals", () => {
  const refusals = [
    [401, { error: "invalid_code", message: "This enrolment code is unknown." }, "This enrolment code is unknown"],
    [403, { error: "invalid_code", message: "This enrolment code was used already." }, "This enrolment code was used already"],
    [403, { error: "invalid_code", message: "This enrolment code has expired." }, "This enrolment code has expired"],
    [401, { error: "invalid_code" }, "invalid_code"],
    [403, undefined, "HTTP 403"],
    [400, { error: "unsupported_protocol", message: "This hub speaks protocol 2." }, "This hub speaks protocol 2"],
    [409, { error: "unsupported_box" }, "unsupported_box"],
    [404, {}, "HTTP 404"],
    [418, { error: "refused" }, "refused"],
  ];
  for (const [status, answer, shown] of refusals) {
    test(`${status} ${answer?.message ?? answer?.error ?? "without a body"}: stops, revokes the token, says why, and is not tried again`, async () => {
      hub.enrol = () => [status, answer];
      const b = box();
      assert.equal(await b.step(null), h.IDLE);
      const sent = hub.enrolments[0].t3code.token;
      assert.ok(!t3.sessions.some((s) => s.token === sent));
      assert.equal(t3.sessions.length, 0);
      const s = state();
      assert.equal(s.status, "rejected");
      assert.equal(s.error, `The hub refused the enrolment: ${shown}. Set a new code, or press Retry.`);
      assert.ok(!s.key && !s.pending && !s.credential);
      assert.equal(mcpCalls.length, 0);
      assert.equal(view(b).status, "rejected");
      assert.equal(view(b).enrolled, false);
      assert.equal(view(b).error, s.error);
      assert.equal(await b.step(null), h.IDLE);
      assert.equal(await box().step(null), h.IDLE, "nor after a restart");
      clock += 30 * DAY;
      assert.equal(await b.step(null), h.IDLE);
      assert.equal(hub.enrolments.length, 1);
      assertNoSecretsLeaked();
    });
  }

  test("a 408 is a hub that did not answer in time: tried again", async () => {
    hub.enrol = () => [408, {}];
    assert.equal(await box().step(null), 15_000);
    assert.equal(state().status, "enrolling");
    assert.match(state().error, /HTTP 408/);
  });

  test("a 422 for an unsupported box: not enrolled, nothing registered; the updated box sends the same code on Retry", async () => {
    hub.enrol = () => [422, { error: "unsupported_box", message: "This hub needs T3 Code 0.0.50 or later." }];
    const b = box();
    assert.equal(await b.step(null), h.IDLE);
    assert.equal(state().status, "rejected");
    assert.equal(view(b).enrolled, false);
    assert.ok(!state().key);
    assert.equal(t3.sessions.length, 0);
    assert.equal(mcpCalls.length, 0);
    assert.equal(await box({ T3CODEBOX_VERSION: "0.0.50-1" }).step(null), h.IDLE, "an update alone does not try again: Retry does");
    hub.enrol = () => [200, { protocol: 1, key: KEY, renewalUrl: `${hub.url}/renew` }];
    await box({ T3CODEBOX_VERSION: "0.0.50-1" }).step("retry");
    assert.equal(hub.enrolments.length, 2);
    assert.equal(hub.enrolments[1].code, CODE, "the code the hub left unused");
    assert.equal(hub.enrolments[1].box.t3codebox, "0.0.50-1");
    assert.notEqual(hub.enrolments[1].t3code.token, hub.enrolments[0].t3code.token, "a new token: the refused one was revoked");
    assert.equal(state().status, "connected");
  });

  test("the hub's message is shown as one line of at most 200 characters", async () => {
    hub.enrol = () => [403, { error: "invalid_code", message: `${"x".repeat(150)}\n<b>${"y".repeat(150)}` }];
    await box().step(null);
    const { error } = state();
    const shown = error.slice("The hub refused the enrolment: ".length, error.indexOf(". Set a new code"));
    assert.equal(shown.length, 200);
    assert.ok(shown.startsWith(`${"x".repeat(150)} <b>`));
    assert.ok(!error.includes("\n"));
  });
});

describe("dashboard view", () => {
  test("shows status, hub, renewal time and agents, never the key or a token", async () => {
    await box().step(null);
    const view = h.publicState(state(), h.config({ T3CODEBOX_HUB_URL: `${hub.url}/enrol` }));
    assert.equal(view.status, "connected");
    assert.equal(view.enrolled, true);
    assert.equal(view.hub, "Test hub");
    assert.equal(view.origin, hub.url);
    assert.equal(view.renewBy, new Date(Date.parse(state().credential.expiresAt) - 7 * DAY).toISOString());
    assert.deepEqual(view.mcp, { name: "hub", agents: ["claude", "codex", "cursor", "grok", "opencode"] });
    assert.ok(!JSON.stringify(view).includes(KEY));
    assert.deepEqual(h.publicState(null, { url: null }), { configured: false, status: "off" });
    assert.equal(h.publicState(state(), { url: null }).status, "leaving");
    assert.equal(h.publicState(null, h.config({ T3CODEBOX_HUB_URL: "ftp://x" })).status, "error");
  });
});
