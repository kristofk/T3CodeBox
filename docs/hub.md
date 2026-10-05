# Hubs

T3CodeBox runs on its own. It can also be connected to a hub: a separate service that installs and manages boxes,
gives their agents shared tools, and starts agent runs through T3 Code. Hub mode is off unless it is set, and a box
without it behaves exactly as before.

The first part of this page is for people running a box; [the enrolment protocol](#the-enrolment-protocol) is for
people writing a hub.

## Connecting a box to a hub

The hub gives you an enrolment address and a one-time code. Put them in `.env` and start the box:

```sh
T3CODEBOX_HUB_URL=https://hub.example.com/api/boxes/enrol
T3CODEBOX_HUB_CODE=<the code>
```

Or keep the code out of the box's environment: mount it as a file (a Docker secret, for example) and set
`T3CODEBOX_HUB_CODE_FILE` to its path inside the container. The code is used once; it can be removed after
enrolment.

Once T3 answers, the box enrols. In the background, so T3 starts and works whether the hub answers or not:

1. It creates a T3 Code access token for the hub. The token can read and work threads (create threads, start and
   stop turns, read threads and projects), and nothing more: not the terminal, not T3's own access settings, not T3
   Connect.
2. It sends the hub the code, the token and a description of the box: its name (the environment name,
   `T3CODEBOX_NAME` or the hostname), the T3CodeBox and T3 Code versions, T3 Code's orchestration protocol version,
   and which agents it has.
3. The hub answers with its MCP server and a key for it. The box adds that server to every agent's user config,
   the way it adds the `browser` server: only where no entry of that name exists, never changing one you made.
4. Before the token expires, or when the hub asks, the box sends the hub a new one and revokes the old one. A box
   that was off past the expiry sends a new one when it starts.

The dashboard's **Hub** card shows where this stands: not connected, enrolling, connected (to which hub, since when,
when the token is renewed next), or what went wrong.

- **The hub doesn't answer:** the box tries again, from every 15 seconds up to every 30 minutes, until it does.
- **The hub refuses the code:** the card says why, and the box stops trying. Set a new code and restart the box, or
  press **Retry**.
- **Revoked by hand:** the hub's token shows on the dashboard's T3 access card as a paired device named
  `Hub <id>`. Revoke it there and the box gives the hub a new one within the hour; to cut the hub off, leave.

### Leaving

- Remove `T3CODEBOX_HUB_URL` from `.env` and run `docker compose up -d`. On that start the box removes the MCP
  entries it added (only those, and only while they are as it made them), revokes the hub's tokens, tells the hub
  and forgets the enrolment.
- Or press **Leave** on the dashboard: the same, but the settings stay. The box enrols again with a new code, or
  with **Retry**.
- A new code enrols the box again from the start; a new address leaves the old hub first.

The box keeps its enrolment in `~/.t3codebox/hub.json` (mode 600), in the home volume: the hub's key, and a token
that hasn't reached the hub yet. Never the code.

## Shared skills

Mount a folder of skills read-only at `/skills`, and every agent gets them, hub or no hub. In `compose.yaml`:

```yaml
    volumes:
      - ./skills:/skills:ro
```

Each skill is a folder with a `SKILL.md`. T3CodeBox links each one into `~/.agents/skills` (which Codex, Cursor
and OpenCode read), `~/.claude/skills` and `~/.grok/skills`, the same layout the `skills` CLI makes. It checks the
folder every minute: a new skill is linked in, and the links of one that is gone are removed. It never replaces a
skill of that name that is already there, never touches a link it didn't make, and never writes to `/skills`.

The dashboard lists these skills as coming from `/skills`, read-only: change them in the folder. `~/.agents/skills`
stays writable, so installing skills from the dashboard keeps working next to them. (Mounting a folder read-only over
`~/.agents/skills` itself also works for those three agents, but then the dashboard can't install or remove skills,
and says so.)

## Behind a hub's proxy

A hub may show a box's T3 Code at the root of one address and the dashboard under a path on the same address, say
`/dashboard/`, with the proxy stripping that path.

- **The dashboard works under a stripped path prefix.** Every address in the page is relative, the sign-in is a
  request from the page rather than a form, the session cookie is for the whole address (`Path=/`), and nothing
  redirects. Opened without the trailing slash, the page adds it before its first request.
- **Pairing links:** set `T3CODEBOX_PUBLIC_URL` to T3's address as devices reach it, and the dashboard's **Pair a
  device** uses it for new links and QR codes. Without it, the page guesses from its own address.
- **One sign-in:** a proxy that signs users in itself can sign them in to the dashboard too. Set
  `DASHBOARD_PROXY_SECRET` to a random secret of at least 32 characters, and have the proxy send it in the
  `X-T3CodeBox-Proxy-Secret` header on every request it forwards to the dashboard. A request with the right secret
  counts as signed in; the secret is compared in constant time, a request the browser marks cross-site never counts,
  and a shorter secret turns the feature off with a warning in the logs.

  Only use it when the dashboard is reachable through that proxy alone (its port bound to loopback or a private
  network, as `compose.yaml` does), when the proxy removes that header from what clients send, and when the proxy
  lets through only people who may use the box: whoever the proxy lets through has the dashboard, which is worth as
  much as a shell in the container.
- The browser's remote desktop is linuxserver's, and isn't covered here.

## The enrolment protocol

Version 1. Everything is JSON over HTTP(S), UTF-8, with `Content-Type: application/json`. The box never follows a
redirect, waits at most 15 seconds for an answer, and reads at most 64 KB of it. Times are ISO 8601 in UTC.

The hub must use HTTPS unless the box reaches it on a private network. The box accepts plain `http://` addresses
because a hub on the same Docker network as the box is a common setup.

### Enrolment

The box sends `POST` to the enrolment address it was given, exactly as given (`T3CODEBOX_HUB_URL`):

```json
{
  "protocol": 1,
  "code": "<the one-time enrolment code>",
  "box": {
    "name": "Kris's NAS",
    "environmentId": "38b7af4d-916c-4c41-81ef-6f9328f19485",
    "t3codebox": "0.0.45-1",
    "t3code": "0.0.45",
    "orchestrationProtocol": 1,
    "agents": ["claude", "codex", "cursor", "grok", "opencode"],
    "url": null
  },
  "t3code": {
    "tokenType": "Bearer",
    "token": "<T3 Code access token>",
    "scopes": ["orchestration:read", "orchestration:operate"],
    "expiresAt": "2026-11-04T12:00:00.000Z"
  }
}
```

- `box.name`: T3 Code's environment name. `box.environmentId`: T3 Code's environment id, stable for a box's home
  volume. Both as `GET /.well-known/t3/environment` on the box reports them.
- `box.t3codebox`: the image version, such as `0.0.45-1`. `box.t3code`: T3 Code's version.
- `box.orchestrationProtocol`: T3 Code's `orchestrationProtocolVersion`, the version of the API the token is for.
- `box.agents`: the agent CLIs installed: any of `claude`, `codex`, `cursor`, `grok`, `opencode`.
- `box.url`: T3 Code's address as the box's owner set it (`T3CODEBOX_PUBLIC_URL`), or `null`. The hub otherwise
  uses the address it knows the box by.
- `t3code.token`: for T3 Code's HTTP API as `Authorization: Bearer <token>`, and for its WebSocket through T3 Code's
  own ticket exchange, as T3 Code's clients use it. `scopes` says what it may do; `expiresAt` when it stops working.

A successful answer is `200` (or another `2xx`):

```json
{
  "protocol": 1,
  "boxId": "box-7f3a",
  "hub": { "name": "Home hub" },
  "key": "<the box's key, 16 to 512 characters of A-Z a-z 0-9 . _ ~ + / = ->",
  "mcp": { "name": "hub", "url": "https://hub.example.com/mcp" },
  "renewalUrl": "https://hub.example.com/api/boxes/renew",
  "leaveUrl": "https://hub.example.com/api/boxes/leave",
  "renewAfter": "2026-10-12T12:00:00Z"
}
```

- `protocol` (required): `1`.
- `key` (required): the box's key. The box sends it as `Authorization: Bearer <key>` to the MCP server, the renewal
  address and the leave address.
- `renewalUrl` (required) and `leaveUrl` (optional): on the same origin (scheme, host and port) as the enrolment
  address; the box refuses an answer that names another.
- `mcp` (optional): an MCP server (streamable HTTP) to register for the agents under `name`. The name is 1 to 40
  characters of `a-z`, `0-9` and `-`, starting with a letter or digit, and not `browser`. The URL is `https://`, or
  `http://` when the enrolment address is. Without `mcp`, nothing is registered.
- `hub.name` (optional): shown on the box's dashboard. `boxId` (optional): the hub's id for the box, kept for
  reference.
- `renewAfter` (optional): when the box should send a new token, if sooner than its own schedule.

An answer that breaks any of these is not used: the box revokes the token it sent, shows the problem on its
dashboard, and doesn't try again with that code.

### Errors

The hub answers a failure with a status and a JSON body:

```json
{ "error": "invalid_code", "message": "This enrolment code was used already." }
```

`error` is a short code for programs, `message` one sentence for the box's owner; the box shows `message` (or else
`error`) on its dashboard, as plain text, at most 200 characters.

| Status | Meaning | The box |
| --- | --- | --- |
| `400` | Malformed, or a protocol version the hub doesn't speak (`unsupported_protocol`) | Stops; revokes the token |
| `401`, `403` | Code unknown, used, expired, or not for this box (`invalid_code`) | Stops; revokes the token |
| `409`, `422` | The box isn't supported, for example its T3 Code version (`unsupported_box`) | Stops; revokes the token |
| other `4xx` | Refused | Stops; revokes the token |
| `408`, `429`, `5xx`, no answer | Try later | Tries again: 15 s, 30 s, 1, 2, 5, 10, then every 30 minutes, give or take a fifth, or after `Retry-After` (seconds, 5 s to an hour) |

"Stops" means until the box's owner sets a new code or presses Retry. While it tries again, the box sends the same
token every time, so a hub that answers late gets the token the box will use.

### Renewal

T3 Code's tokens last 30 days. The box sends a new one a week before the hub's expires, or at `renewAfter` if
that is sooner, or when its owner presses **Renew now**, or within the hour after the hub's token was revoked on the
box:

```
POST <renewalUrl>
Authorization: Bearer <key>

{ "protocol": 1, "box": { … as above … }, "t3code": { … a new token … } }
```

The hub answers `200` with `{ "protocol": 1 }` and, optionally, a new `renewAfter`. It replaces the stored token
with the new one at once. The box revokes the old token once the hub has answered, so the hub must not use the old
one after that answer.

| Status | The box |
| --- | --- |
| `2xx` | Done; next renewal per its schedule or `renewAfter` |
| `401`, `403`, `404`, `410` | The hub no longer knows the box: it stops renewing and says so on its dashboard |
| anything else, no answer | Tries again with the backoff above, with the same new token |

A box that was off, or couldn't reach the hub, past the expiry needs nothing from anyone: when it can, it sends a
new token with its key. The key doesn't expire; a hub that wants a box gone answers its renewals with `401`.

### Leaving

When its owner leaves (on the dashboard, or by removing `T3CODEBOX_HUB_URL`), and the hub gave a `leaveUrl`, the box
sends one `POST <leaveUrl>` with `Authorization: Bearer <key>` and `{ "protocol": 1 }`, waits at most 5 seconds and
doesn't try again. It has already revoked the hub's tokens. The hub should answer `204`, forget the box's token and
key, and treat the box as gone.

### What a hub must never do with the token

- Log it, show it, or return it from any API, its own users included.
- Send it anywhere but the box's own T3 Code.
- Store it in plain text: keep it with the hub's other secrets, encrypted at rest.
- Use one box's token for another box, or keep a replaced token.
- Ask for more: the token's scopes are the box's decision. A hub that needs something the token can't do asks the
  box's owner.

The same goes for the code (once used, worthless, but still not to be logged) and the key, which the hub should
store as a hash where it only needs to check it.

### Versioning

Every request and answer carries `protocol`. This page is version 1. A change that an old box or hub would
misunderstand gets a new version; new optional fields don't. A hub that doesn't speak a box's version answers
`400` with `unsupported_protocol` and the versions it speaks in `message`. A box that gets an answer with another
version uses none of it.

T3 Code's own API versions separately: `box.orchestrationProtocol` and `box.t3code` tell the hub whether it can drive
the box. A hub that can't answers `422` with `unsupported_box`.
