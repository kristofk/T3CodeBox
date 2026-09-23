// Starts the browser MCP server the way an agent does and opens a page through it.
const { spawn } = require("child_process");
const server = spawn("t3codebox-browser-mcp", [], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buffer = "";
let nextId = 0;
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const finish = (ok, detail) => {
  console.log(ok ? "ok" : `fail: ${detail}`);
  server.kill();
  process.exit(ok ? 0 : 1);
};
setTimeout(() => finish(false, "timeout"), 90000);
(async () => {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t3codebox-test", version: "1" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const result = JSON.stringify(
    await request("tools/call", {
      name: "browser_navigate",
      arguments: { url: "data:text/html,<title>t3codebox-probe</title>" },
    }),
  );
  finish(result.includes("t3codebox-probe"), result.slice(0, 400));
})();
