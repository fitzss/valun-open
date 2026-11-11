#!/usr/bin/env node
// stdio <-> Streamable HTTP bridge for MCP clients that only launch local (stdio) servers.
// It forwards each JSON-RPC line from stdin to the Valun /mcp endpoint and writes the replies to stdout.
// Zero dependencies; Node 18+. Copy this one file to any machine.
//
//   VALUN_MCP_URL  default https://valun-desk.fly.dev/mcp
//   VALUN_TOKEN    the demo passphrase (only needed for tools that make changes)
//
// Example client config (Claude Desktop, Hermes stdio, ...):
//   {"command": "node", "args": ["/path/valun-mcp-stdio.mjs"], "env": {"VALUN_TOKEN": "..."}}
import readline from 'node:readline';

const url = process.env.VALUN_MCP_URL || 'https://valun-desk.fly.dev/mcp';
const token = process.env.VALUN_TOKEN || '';
let protocolVersion = null;
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return out({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}}); }
  const headers = {'content-type': 'application/json', accept: 'application/json, text/event-stream'};
  if (token) headers['x-valun-token'] = token;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  try {
    const r = await fetch(url, {method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(60_000)});
    if (r.status === 202) return; // notification accepted
    const reply = await r.json();
    if (msg.method === 'initialize' && reply.result?.protocolVersion) protocolVersion = reply.result.protocolVersion;
    out(reply);
  } catch (e) {
    if ('id' in msg) out({jsonrpc: '2.0', id: msg.id, error: {code: -32000, message: `Valun endpoint unreachable (${url}): ${e.cause?.code || e.name}`}});
  }
}

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
let chain = Promise.resolve();
rl.on('line', line => { if (line.trim()) chain = chain.then(() => forward(line)); });
rl.on('close', () => chain.then(() => process.exit(0)));
