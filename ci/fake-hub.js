// A hub for ci/test.sh (ci/test.hub.yaml runs it next to the box): the enrolment protocol of docs/hub.md, with
// single-use codes from HUB_CODES. It tries every token it gets on the box's T3 Code, recording what the token may
// do, and answers GET /state with what it saw, secrets included, so the test can look for them in the box's logs.
"use strict";
const crypto = require("node:crypto");
const http = require("node:http");

const BOX = process.env.BOX_T3 || "http://t3codebox:3773";
const SELF = process.env.HUB_SELF || "http://hub:8080";
const codes = new Set((process.env.HUB_CODES || "").split(",").filter(Boolean));
const used = new Set();
const seen = { enrolments: [], refused: 0, renewals: 0, leaves: 0, codes: [...codes], keys: [], tokens: [], checks: [] };

// What a token may do on the box: its session's scopes, and whether it can list pairing links (it should not).
async function check(token) {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const session = await fetch(`${BOX}/api/auth/session`, auth).then((r) => r.json()).catch(() => null);
  const pairingLinks = await fetch(`${BOX}/api/auth/pairing-links`, auth).then((r) => r.status).catch(() => 0);
  seen.checks.push({ authenticated: session?.authenticated === true, scopes: session?.scopes ?? null, pairingLinks });
}

const send = (response, status, data) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(data === undefined ? "" : JSON.stringify(data));
};
const keyOf = (request) => String(request.headers.authorization ?? "").replace(/^Bearer /, "");

http.createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (request.method === "GET" && request.url === "/state") return send(response, 200, seen);
  if (request.method !== "POST") return send(response, 404, { error: "not_found" });
  if (request.url === "/enrol") {
    if (body?.protocol !== 1) return send(response, 400, { error: "unsupported_protocol", message: "This hub speaks protocol 1." });
    if (!codes.has(body.code) || used.has(body.code)) {
      seen.refused++;
      return send(response, 403, { error: "invalid_code", message: "This enrolment code is not valid, or was used already." });
    }
    used.add(body.code);
    const key = crypto.randomBytes(24).toString("base64url");
    seen.keys.push(key);
    seen.tokens.push(body.t3code?.token);
    seen.enrolments.push({ box: body.box, scopes: body.t3code?.scopes, expiresAt: body.t3code?.expiresAt });
    await check(body.t3code?.token);
    // A renewAfter in the past, which the box must not take as a reason to renew at once.
    return send(response, 200, {
      protocol: 1, boxId: `box-${seen.enrolments.length}`, hub: { name: "T3CodeBox test hub" }, key,
      mcp: { name: "hub", url: `${SELF}/mcp` }, renewalUrl: `${SELF}/renew`, leaveUrl: `${SELF}/leave`,
      renewAfter: "2020-01-01T00:00:00Z",
    });
  }
  if (!seen.keys.includes(keyOf(request))) return send(response, 401, { error: "unknown_box" });
  if (request.url === "/renew") {
    seen.renewals++;
    seen.tokens.push(body?.t3code?.token);
    await check(body?.t3code?.token);
    return send(response, 200, { protocol: 1 });
  }
  if (request.url === "/leave") {
    seen.leaves++;
    return send(response, 204);
  }
  send(response, 404, { error: "not_found" });
}).listen(8080, () => console.log("fake hub on port 8080"));
