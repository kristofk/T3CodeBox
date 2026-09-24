// Unit tests for the dashboard: parsers, provider cards, password and session store. The samples are real
// output from a running container (personal details replaced) unless marked "made up".
// Run: node --test ci/dashboard.test.js (make check runs it in node:lts-slim).
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const d = require("../rootfs/usr/local/lib/t3codebox-dashboard/server.js");

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const noEnv = { ANTHROPIC_API_KEY: false, CLAUDE_CODE_OAUTH_TOKEN: false, OPENAI_API_KEY: false, CURSOR_API_KEY: false, XAI_API_KEY: false };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "t3codebox-dashboard-"));

describe("parseVersion", () => {
  test("finds the version in each CLI's --version output", () => {
    assert.equal(d.parseVersion("2.1.280 (Claude Code)\n"), "2.1.280");
    assert.equal(d.parseVersion("codex-cli 0.156.1\n"), "0.156.1");
    assert.equal(d.parseVersion("2026.09.18-9a7762b\n"), "2026.09.18-9a7762b");
    assert.equal(d.parseVersion("grok 1.0.41 (4220f3b224a6)\n"), "1.0.41");
    assert.equal(d.parseVersion("1.18.32\n"), "1.18.32");
    assert.equal(d.parseVersion("gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0\n"), "2.101.0");
    assert.equal(d.parseVersion("t3 v0.0.42\n"), "0.0.42");
    assert.equal(d.parseVersion(""), null);
  });
});

describe("mounts", () => {
  const bindMounts = `3113 2169 0:135 / / rw,relatime - overlay overlay rw,lowerdir=/mnt/.ix-apps/docker/overlay2/l/35CS:/mnt/.ix-apps/docker/overlay2/l/UYF7,upperdir=/mnt/.ix-apps/docker/overlay2/06bb/diff,workdir=/mnt/.ix-apps/docker/overlay2/06bb/work
3115 3113 0:336 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
3119 3118 0:44 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw
3122 3113 0:61 /t3codebox/workspace /workspace rw,noatime - zfs Main/docker rw,xattr,posixacl,casesensitive
3123 3113 0:61 /t3codebox/home /home/t3codebox rw,noatime - zfs Main/docker rw,xattr,posixacl,casesensitive
3124 3113 0:94 /containers/99579ef9/resolv.conf /etc/resolv.conf rw,noatime - zfs Main/ix-apps/docker rw,xattr,posixacl,casesensitive
`;

  test("bind mounts show the path inside the source file system", () => {
    const mounts = d.parseMountinfo(bindMounts);
    assert.deepEqual(d.describeMount(mounts, "/home/t3codebox"), { kind: "bind", root: "/t3codebox/home", source: "Main/docker", fsType: "zfs" });
    assert.equal(d.describeMount(mounts, "/workspace").root, "/t3codebox/workspace");
  });

  test("named volumes are recognised by their _data folder (made up, Docker's usual layouts)", () => {
    const mounts = d.parseMountinfo(`1500 1400 8:1 /var/lib/docker/volumes/t3codebox-home/_data /home/t3codebox rw,relatime - ext4 /dev/sda1 rw
1501 1400 0:94 /volumes/t3codebox-workspace/_data /workspace rw,noatime - zfs Main/ix-apps/docker rw
`);
    assert.deepEqual(d.describeMount(mounts, "/home/t3codebox"), { kind: "volume", volume: "t3codebox-home", source: "/dev/sda1", fsType: "ext4" });
    assert.equal(d.describeMount(mounts, "/workspace").volume, "t3codebox-workspace");
  });

  test("a folder without a mount, in tmpfs, over-mounted or with a space in its path (made up)", () => {
    const mounts = d.parseMountinfo(`1 0 0:1 / / rw - overlay overlay rw
2 1 0:2 / /workspace rw - tmpfs tmpfs rw
3 1 8:1 /srv/old /home/t3codebox rw - ext4 /dev/sda1 rw
4 1 8:1 /srv/my\\040home /home/t3codebox ro,relatime shared:1 - ext4 /dev/sda1 rw
`);
    assert.deepEqual(d.describeMount(mounts, "/elsewhere"), { kind: "none" });
    assert.equal(d.describeMount(mounts, "/workspace").kind, "tmpfs");
    assert.equal(d.describeMount(mounts, "/home/t3codebox").root, "/srv/my home");
    assert.equal(mounts[3].readOnly, true);
  });
});

describe("cgroup files", () => {
  const memoryStat = "anon 543555584\nfile 613679104\nkernel 24096768\ninactive_anon 561250304\ninactive_file 7667712\nactive_file 606064640\n";

  test("memory in use leaves out the inactive page cache; max is no limit", () => {
    assert.deepEqual(d.parseMemory("1200115712\n", "max\n", memoryStat), { used: 1200115712 - 7667712, limit: null });
    assert.deepEqual(d.parseMemory("1000\n", "8589934592\n", ""), { used: 1000, limit: 8589934592 });
  });

  test("cgroup v1 has no memory.current: unknown", () => {
    assert.equal(d.parseMemory(null, null, null), null);
  });

  test("cpu.max is the limit in cores", () => {
    assert.equal(d.parseCpuMax("max 100000\n"), null);
    assert.equal(d.parseCpuMax("200000 100000\n"), 2);
    assert.equal(d.parseCpuMax("150000 100000\n"), 1.5);
    assert.equal(d.parseCpuMax(null), null);
  });

  test("cpu.stat", () => {
    const stat = d.parseKeyValues("usage_usec 1836813128\nuser_usec 1431345595\nsystem_usec 405467533\nnr_periods 0\n");
    assert.equal(stat.usage_usec, 1836813128);
    assert.equal(stat.nr_periods, 0);
  });
});

describe("processes", () => {
  const tini = "1 (tini) S 0 1 1 0 -1 4194560 642 926102 21 1355 73 228 13261 164 20 0 1 0 16447234 2703360 99 18446744073709551615 94263229652992 0";

  test("/proc/<pid>/stat, also with spaces and parentheses in the name", () => {
    assert.deepEqual(d.parseProcStat(tini), { pid: 1, comm: "tini", ppid: 0, startTicks: 16447234 });
    const odd = d.parseProcStat("42 (my (odd) name) S 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 500 0");
    assert.equal(odd.comm, "my (odd) name");
    assert.equal(odd.ppid, 7);
    assert.equal(d.parseProcStat("garbage"), null);
  });

  test("container uptime from PID 1's start and /proc/uptime", () => {
    assert.ok(Math.abs(d.containerUptime(tini, "243568.42 3276404.16\n") - (243568.42 - 164472.34)) < 0.001);
    assert.equal(d.containerUptime(null, null), null);
  });

  test("counts running agents by executable, once per agent tree", () => {
    const processes = [
      { pid: 1, ppid: 0, comm: "tini", exe: "/usr/bin/tini" },
      { pid: 7, ppid: 1, comm: "node-MainThread", exe: "/opt/t3/t3" },
      { pid: 8, ppid: 7, comm: "t3-resource-mon", exe: "/opt/t3/resource-monitor/linux-x64/t3-resource-monitor" },
      { pid: 9, ppid: 7, comm: "claude", exe: "/usr/local/bin/claude" },
      { pid: 10, ppid: 7, comm: "claude", exe: "/usr/local/bin/claude" },
      { pid: 11, ppid: 9, comm: "claude", exe: "/usr/local/bin/claude" },
      // Codex: the npm wrapper runs as node and starts the native binary, which starts a helper (made up tree).
      { pid: 20, ppid: 7, comm: "MainThread", exe: "/usr/local/bin/node" },
      { pid: 21, ppid: 20, comm: "codex", exe: "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" },
      { pid: 22, ppid: 21, comm: "codex-code-mode", exe: "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host" },
      // Cursor runs as its own node: only the path tells.
      { pid: 30, ppid: 7, comm: "MainThread", exe: "/opt/cursor-agent/node" },
      { pid: 31, ppid: 30, comm: "MainThread", exe: "/opt/cursor-agent/node" },
      { pid: 40, ppid: 7, comm: "opencode", exe: "/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe" },
      { pid: 50, ppid: 7, comm: "grok", exe: "/usr/local/bin/grok (deleted)" },
      { pid: 60, ppid: 1, comm: "bash", exe: "/usr/bin/bash" },
    ];
    assert.deepEqual(d.countAgents(processes), { claude: 2, codex: 1, cursor: 1, grok: 1, opencode: 1 });
    assert.equal(d.agentOf({ comm: "claude", exe: null }), "claude");
    assert.equal(d.agentOf({ comm: "node", exe: "/usr/local/bin/node" }), null);
  });
});

describe("Claude Code", () => {
  const login = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/home/t3codebox/.claude/projects",
  "configDirectory": "/home/t3codebox/.claude",
  "email": "someone@example.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "someone@example.com's Organization",
  "subscriptionType": "max"
}`;
  // A login plus ANTHROPIC_API_KEY: the key wins.
  const loginAndKey = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/home/t3codebox/.claude/projects",
  "configDirectory": "/home/t3codebox/.claude",
  "apiKeySource": "ANTHROPIC_API_KEY",
  "email": null,
  "orgId": null,
  "orgName": null,
  "subscriptionType": null
}`;
  const keyOnly = `{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "analyticsDisabled": false, "apiKeySource": "ANTHROPIC_API_KEY"}`;
  const token = `{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty", "analyticsDisabled": false}`;
  const loggedOut = `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", "analyticsDisabled": false}`;
  const cardFor = (status, env = {}, loginStored = false) =>
    d.claudeCard({ installed: true, version: "2.1.280", status: d.parseClaudeStatus(status), env: { ...noEnv, ...env }, loginStored });

  test("a subscription login", () => {
    const card = cardFor(login, {}, true);
    assert.equal(card.signedIn, true);
    assert.equal(card.method, "Claude login (Max plan)");
    assert.equal(card.account, "someone@example.com");
    assert.deepEqual(card.warnings, []);
    assert.equal(card.signIn, null);
  });

  test("ANTHROPIC_API_KEY next to a login: billed to the API, two methods", () => {
    const card = cardFor(loginAndKey, { ANTHROPIC_API_KEY: true }, true);
    assert.equal(card.method, "API key from .env (ANTHROPIC_API_KEY)");
    assert.equal(card.warnings.length, 2);
    assert.match(card.warnings[0], /billed to the API/);
    assert.match(card.warnings[1], /Two sign-in methods/);
  });

  test("ANTHROPIC_API_KEY alone still warns about billing", () => {
    const card = cardFor(keyOnly, { ANTHROPIC_API_KEY: true });
    assert.equal(card.warnings.length, 1);
    assert.match(card.warnings[0], /billed to the API/);
  });

  test("CLAUDE_CODE_OAUTH_TOKEN", () => {
    const card = cardFor(token, { CLAUDE_CODE_OAUTH_TOKEN: true });
    assert.equal(card.method, "Token from .env (CLAUDE_CODE_OAUTH_TOKEN)");
    assert.deepEqual(card.warnings, []);
  });

  test("signed out: the headless sign-in command", () => {
    const card = cardFor(loggedOut);
    assert.equal(card.signedIn, false);
    assert.equal(card.method, null);
    assert.equal(card.signIn, "docker exec -it t3codebox claude auth login");
  });

  test("unreadable output and a missing CLI", () => {
    assert.equal(cardFor("not json").signedIn, null);
    const missing = d.claudeCard({ installed: false, version: null, status: null, env: noEnv, loginStored: false });
    assert.equal(missing.installed, false);
    assert.equal(missing.signIn, null);
  });
});

describe("Codex", () => {
  const cardFor = (text, env = {}) => d.codexCard({ installed: true, version: "0.156.1", status: d.parseCodexStatus(text), env: { ...noEnv, ...env } });

  test("not logged in", () => {
    const card = cardFor("Not logged in\n");
    assert.equal(card.signedIn, false);
    assert.equal(card.signIn, "docker exec -it t3codebox codex login --device-auth");
    assert.match(card.notes.join(" "), /device code sign-in/);
  });

  test("ChatGPT and API key logins; the masked key never shows (made up)", () => {
    assert.equal(cardFor("Logged in using ChatGPT\n").method, "ChatGPT login");
    const key = cardFor("Logged in using an API key - sk-proj-***ABCD\n");
    assert.equal(key.signedIn, true);
    assert.doesNotMatch(JSON.stringify(key), /sk-|ABCD/);
  });

  test("OPENAI_API_KEY: not counted as a sign-in by Codex, and a second method next to a login", () => {
    assert.match(cardFor("Not logged in\n", { OPENAI_API_KEY: true }).notes[0], /codex login --with-api-key/);
    assert.match(cardFor("Logged in using ChatGPT\n", { OPENAI_API_KEY: true }).warnings[0], /Two sign-in methods/);
  });
});

describe("Cursor", () => {
  test("not logged in", () => {
    const status = d.parseCursorStatus(`{
  "status": "unauthenticated",
  "isAuthenticated": false,
  "hasAccessToken": false,
  "hasRefreshToken": false,
  "message": "Not logged in"
}`);
    const card = d.cursorCard({ installed: true, version: "2026.09.18-9a7762b", status, env: noEnv });
    assert.equal(card.signedIn, false);
    assert.match(card.notes[0], /CURSOR_API_KEY/);
  });

  test("signed in, and the API key method (made up)", () => {
    const status = d.parseCursorStatus(`{"status":"authenticated","isAuthenticated":true,"email":"someone@example.com"}`);
    assert.equal(d.cursorCard({ installed: true, status, env: noEnv }).account, "someone@example.com");
    assert.equal(d.cursorCard({ installed: true, status, env: { ...noEnv, CURSOR_API_KEY: true } }).method, "API key from .env (CURSOR_API_KEY)");
  });
});

describe("Grok Build", () => {
  test("from ~/.grok/auth.json and XAI_API_KEY", () => {
    const none = d.grokCard({ installed: true, loginStored: false, env: noEnv });
    assert.equal(none.signedIn, false);
    assert.equal(none.signIn, "docker exec -it t3codebox grok login --device-auth");
    assert.equal(d.grokCard({ installed: true, loginStored: true, env: noEnv }).method, "Grok login");
    const both = d.grokCard({ installed: true, loginStored: true, env: { ...noEnv, XAI_API_KEY: true } });
    assert.equal(both.method, "API key from .env (XAI_API_KEY)");
    assert.match(both.warnings[0], /Two sign-in methods/);
  });
});

describe("OpenCode", () => {
  const empty = "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n\x1b[0m\n│\n└  0 credentials\n\n";
  const withEnvironment = `${empty}┌  Environment\n│\n●  Anthropic \x1b[90mANTHROPIC_API_KEY\n│\n●  OpenAI \x1b[90mOPENAI_API_KEY\n│\n└  2 environment variables\n\n`;
  // Made up: the credential lines follow the environment lines' format.
  const stored = "┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  Anthropic \x1b[90moauth\n│\n●  GitHub Copilot \x1b[90moauth\n│\n└  2 credentials\n\n";

  test("nothing stored", () => {
    assert.deepEqual(d.parseOpencodeAuth(empty), { credentials: [], environment: [] });
    const card = d.opencodeCard({ installed: true, auth: d.parseOpencodeAuth(empty) });
    assert.equal(card.signedIn, false);
    assert.equal(card.signIn, "docker exec -it t3codebox opencode auth login");
  });

  test("provider variables", () => {
    const auth = d.parseOpencodeAuth(withEnvironment);
    assert.deepEqual(auth.environment, [{ provider: "Anthropic", variable: "ANTHROPIC_API_KEY" }, { provider: "OpenAI", variable: "OPENAI_API_KEY" }]);
    const card = d.opencodeCard({ installed: true, auth });
    assert.equal(card.signedIn, true);
    assert.equal(card.method, "Anthropic (ANTHROPIC_API_KEY), OpenAI (OPENAI_API_KEY)");
  });

  test("stored sign-ins, and one provider set twice", () => {
    const auth = d.parseOpencodeAuth(stored + withEnvironment.slice(empty.length));
    assert.deepEqual(auth.credentials, [{ provider: "Anthropic", type: "oauth" }, { provider: "GitHub Copilot", type: "oauth" }]);
    const card = d.opencodeCard({ installed: true, auth });
    assert.equal(card.method, "Anthropic (login), GitHub Copilot (login), Anthropic (ANTHROPIC_API_KEY), OpenAI (OPENAI_API_KEY)");
    assert.deepEqual(card.warnings, ["Anthropic: a stored sign-in and a variable are both set; one of them is ignored."]);
  });
});

describe("GitHub", () => {
  const signedIn = `{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octocat","tokenSource":"/home/t3codebox/.config/gh/hosts.yml","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}`;
  const tokenAndLogin = `{"hosts":{"github.com":[{"state":"error","error":"non-200 OK status code: 401 Unauthorized body: \\"{\\\\r\\\\n  \\\\\\"message\\\\\\": \\\\\\"Bad credentials\\\\\\"}\\"","active":true,"host":"github.com","login":"","tokenSource":"GH_TOKEN","gitProtocol":"https"},{"state":"success","active":false,"host":"github.com","login":"octocat","tokenSource":"/home/t3codebox/.config/gh/hosts.yml","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}`;
  const loggedOut = `{"hosts":{}}\nYou are not logged into any GitHub hosts. To log in, run: gh auth login\n`;

  test("a gh login", () => {
    const card = d.githubCard({ installed: true, version: "2.101.0", accounts: d.parseGhStatus(signedIn) });
    assert.equal(card.signedIn, true);
    assert.equal(card.account, "octocat");
    assert.equal(card.method, "gh login");
    assert.deepEqual(card.details, ["Scopes: gist, read:org, repo, workflow"]);
  });

  test("a rejected GH_TOKEN next to a stored login", () => {
    const card = d.githubCard({ installed: true, accounts: d.parseGhStatus(tokenAndLogin) });
    assert.equal(card.signedIn, false);
    assert.equal(card.method, "Token from .env (GH_TOKEN)");
    assert.match(card.warnings[0], /Two sign-in methods/);
    assert.match(card.notes[0], /did not accept/);
  });

  test("logged out, with the hint line after the JSON", () => {
    const card = d.githubCard({ installed: true, accounts: d.parseGhStatus(loggedOut) });
    assert.equal(card.signedIn, false);
    assert.equal(card.signIn, "docker exec -it t3codebox gh auth login");
    assert.equal(d.parseGhStatus("error"), null);
  });
});

describe("T3", () => {
  test("paired devices keep label, device and times only", () => {
    const sessions = d.parseT3Sessions(`[
  {
    "sessionId": "254931ee-d73d-40f6-b617-028524e6d10d",
    "method": "bearer-access-token",
    "scopes": ["orchestration:read", "orchestration:operate", "terminal:operate", "review:write", "relay:read"],
    "subject": "one-time-token",
    "client": {
      "label": "my-iphone",
      "ipAddress": "172.16.1.1",
      "userAgent": "T3Code/65 CFNetwork/3896.100.1.2.1 Darwin/27.0.0",
      "deviceType": "mobile",
      "os": "iOS"
    },
    "connected": false,
    "issuedAt": "2026-09-23T15:11:21.921Z",
    "expiresAt": "2026-10-23T15:11:21.921Z",
    "lastConnectedAt": "2026-09-24T12:25:25.842Z"
  }
]
`);
    assert.deepEqual(sessions, [{
      label: "my-iphone", deviceType: "mobile", os: "iOS", browser: null,
      issuedAt: "2026-09-23T15:11:21.921Z", expiresAt: "2026-10-23T15:11:21.921Z", lastConnectedAt: "2026-09-24T12:25:25.842Z",
    }]);
  });

  test("pairing links without the links (made up from the documented fields)", () => {
    assert.deepEqual(d.parseT3Pairings(`[{"id":"p1","label":"t3codebox-test","scopes":["orchestration:read"],"createdAt":"2026-09-24T10:00:00.000Z","expiresAt":"2026-09-24T10:10:00.000Z"}]`),
      [{ label: "t3codebox-test", createdAt: "2026-09-24T10:00:00.000Z", expiresAt: "2026-09-24T10:10:00.000Z" }]);
    assert.deepEqual(d.parseT3Pairings("[]\n\n"), []);
    assert.equal(d.parseT3Pairings("Error: no server"), null);
  });
});

describe("SKILL.md frontmatter", () => {
  test("plain values", () => {
    assert.deepEqual(d.parseSkillFrontmatter(`---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance.
---

# Skill Creator
`), { name: "skill-creator", description: "Create new skills, modify and improve existing skills, and measure skill performance." });
  });

  test("quoted values, other keys, CRLF", () => {
    assert.deepEqual(d.parseSkillFrontmatter('---\r\nname: pptx\r\ndescription: "Use this skill any time a .pptx file is \\"involved\\" — as input, output, or both."\r\nlicense: Proprietary. LICENSE.txt has complete terms\r\n---\r\n'),
      { name: "pptx", description: 'Use this skill any time a .pptx file is "involved" — as input, output, or both.' });
    assert.equal(d.parseSkillFrontmatter("---\nname: x\ndescription: 'It''s here'\n---\n").description, "It's here");
  });

  test("block and multi-line values (made up)", () => {
    assert.equal(d.parseSkillFrontmatter("---\nname: a\ndescription: >-\n  Folded over\n  two lines.\nmetadata:\n  type: user\n---\n").description, "Folded over two lines.");
    assert.equal(d.parseSkillFrontmatter("---\nname: b\ndescription: |\n  Line one\n  Line two\n---\n").description, "Line one\nLine two");
    assert.equal(d.parseSkillFrontmatter("---\nname: c\ndescription: Starts here\n  and goes on.\n---\n").description, "Starts here and goes on.");
  });

  test("no frontmatter", () => {
    assert.deepEqual(d.parseSkillFrontmatter("# Just a heading\n"), { name: null, description: null });
    assert.deepEqual(d.parseSkillFrontmatter("---\nname: unterminated\n"), { name: null, description: null });
  });
});

describe("CLI versions", () => {
  test("read once each; one that gave no version is asked again after 30 s, without waiting for it", async () => {
    let clock = 0;
    let answerT3;
    const t3Answer = new Promise((resolve) => (answerT3 = resolve));
    const asked = [];
    const versions = d.versionCache(async (command) => {
      asked.push(command);
      if (command === "t3") return asked.filter((c) => c === "t3").length === 1 ? { installed: true, version: null } : t3Answer;
      return command === "grok" ? { installed: false, version: null } : { installed: true, version: "1.0.0" };
    }, () => clock);
    const first = await versions();
    assert.equal(asked.length, 7);
    assert.equal(first.t3.version, null);
    assert.equal(first.claude.version, "1.0.0");
    clock = 10_000;
    await versions();
    assert.equal(asked.length, 7);
    clock = 40_000;
    assert.equal((await versions()).t3.version, null);
    assert.deepEqual(asked.slice(7), ["t3"]);
    answerT3({ installed: true, version: "0.0.42" });
    await new Promise(setImmediate);
    assert.equal((await versions()).t3.version, "0.0.42");
    clock = 100_000;
    await versions();
    assert.equal(asked.length, 8);
  });
});

describe("small parsers", () => {
  test("du -sk", () => {
    assert.deepEqual(d.parseDu("4200\t/home/t3codebox\n120\t/workspace\n"), { "/home/t3codebox": 4200 * 1024, "/workspace": 120 * 1024 });
  });

  test("user agent labels", () => {
    assert.equal(d.userAgentLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
    assert.equal(d.userAgentLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.0.0 Mobile/15E148 Safari/604.1"), "Chrome on iPhone");
    assert.equal(d.userAgentLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"), "Chrome on Mac");
    assert.equal(d.userAgentLabel("Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36"), "Chrome on Android");
    assert.equal(d.userAgentLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"), "Edge on Windows");
    assert.equal(d.userAgentLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"), "Firefox on Linux");
    assert.equal(d.userAgentLabel("curl/8.14.1"), "curl");
    assert.equal(d.userAgentLabel(undefined), "Unknown browser");
  });
});

describe("password", () => {
  test("constant-time compare of any length", () => {
    assert.equal(d.passwordMatches("secret", "secret"), true);
    assert.equal(d.passwordMatches("secre", "secret"), false);
    assert.equal(d.passwordMatches("a much longer guess", "secret"), false);
    assert.equal(d.passwordMatches(undefined, "secret"), false);
  });

  test("DASHBOARD_PASSWORD wins and writes nothing", (t) => {
    const file = path.join(tempDir(), ".t3codebox", "dashboard-password");
    t.mock.method(console, "log", () => {});
    assert.equal(d.loadPassword(file, { DASHBOARD_PASSWORD: "from-env" }), "from-env");
    assert.equal(fs.existsSync(file), false);
  });

  test("generated once, kept with mode 600, printed only the first time", (t) => {
    const file = path.join(tempDir(), ".t3codebox", "dashboard-password");
    const log = t.mock.method(console, "log", () => {});
    const first = d.loadPassword(file, {});
    assert.match(first, /^[A-Za-z0-9]{24}$/);
    assert.equal(fs.readFileSync(file, "utf8"), `${first}\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(log.mock.calls.some((call) => call.arguments[0].includes(first)));
    const printed = log.mock.callCount();
    assert.equal(d.loadPassword(file, {}), first);
    assert.equal(log.mock.callCount(), printed);
  });
});

describe("SessionStore", () => {
  const now = Date.UTC(2026, 8, 24);
  const newStore = (password = "secret") => {
    const file = path.join(tempDir(), ".t3codebox", "dashboard-sessions.json");
    return { file, store: new d.SessionStore(file, password, now) };
  };

  test("create and look up; the file holds a hash, never the cookie", () => {
    const { file, store } = newStore();
    const { token, session } = store.create("Safari on iPhone", now);
    assert.equal(store.lookup(token, now).id, session.id);
    assert.equal(store.lookup("wrong", now), null);
    assert.equal(store.lookup(undefined, now), null);
    const saved = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(saved, new RegExp(token));
    assert.doesNotMatch(saved, /secret/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.list(now), [{ id: session.id, label: "Safari on iPhone", createdAt: now, lastUsedAt: now }]);
  });

  test("survives a restart", () => {
    const { file, store } = newStore();
    const { token } = store.create("Chrome on Mac", now);
    assert.equal(new d.SessionStore(file, "secret", now).lookup(token, now).label, "Chrome on Mac");
  });

  test("expires a year after the last use; each use extends it", () => {
    const { file, store } = newStore();
    const { token } = store.create("Chrome on Mac", now);
    const later = now + 300 * 24 * 60 * 60 * 1000;
    assert.ok(store.lookup(token, later));
    const reloaded = new d.SessionStore(file, "secret", later);
    assert.ok(reloaded.lookup(token, later + 300 * 24 * 60 * 60 * 1000));
    assert.equal(reloaded.lookup(token, later + 300 * 24 * 60 * 60 * 1000 + YEAR_MS), null);
    assert.deepEqual(reloaded.list(later + 300 * 24 * 60 * 60 * 1000 + YEAR_MS), []);
  });

  test("an old session is dropped when the file is loaded", () => {
    const { file, store } = newStore();
    const { token } = store.create("Chrome on Mac", now);
    const reloaded = new d.SessionStore(file, "secret", now + YEAR_MS);
    assert.equal(reloaded.lookup(token, now + YEAR_MS), null);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /Chrome on Mac/);
  });

  test("sign out one device", () => {
    const { store } = newStore();
    const phone = store.create("Safari on iPhone", now);
    const mac = store.create("Chrome on Mac", now);
    assert.equal(store.revoke(phone.session.id, now), true);
    assert.equal(store.revoke(phone.session.id, now), false);
    assert.equal(store.lookup(phone.token, now), null);
    assert.ok(store.lookup(mac.token, now));
  });

  test("a new password signs every device out, also after switching back", () => {
    const { file, store } = newStore("first");
    const { token } = store.create("Safari on iPhone", now);
    const changed = new d.SessionStore(file, "second", now);
    assert.equal(changed.lookup(token, now), null);
    assert.deepEqual(changed.list(now), []);
    assert.equal(new d.SessionStore(file, "first", now).lookup(token, now), null);
  });
});
