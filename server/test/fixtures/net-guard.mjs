// A network guard for a child process, preloaded with `node --import <this file's URL>` (test/local-start.unit.test.mjs,
// fix inbox #151): every outbound connection and every DNS lookup the process attempts is written to NET_GUARD_LOG (one
// JSON line each: {kind: 'connect' | 'dns', host, port, allowed}), and refused unless it stays on this machine (loopback:
// 127.0.0.0/8, ::1, localhost, or no host at all, which Node takes as localhost; and the unspecified addresses 0.0.0.0
// and ::, which a server looks up to listen on every interface, and which a connection takes as this machine). A refused
// connection fails as a connection error on the next tick and a refused lookup as ENOTFOUND, before any packet or DNS
// query leaves the machine, so a test can show that nothing tried to reach another host, and that nothing could have.
// Unix sockets and named pipes pass. Node's fetch, http, https and tls all connect through net.Socket.prototype.connect,
// and look names up with dns.lookup; the ES module exports of node:dns are synced to the patched functions
// (syncBuiltinESMExports), so `import {lookup} from 'node:dns'` gets the guarded one too.
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const LOG = process.env.NET_GUARD_LOG || null;
const note = rec => { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({pid: process.pid, ...rec})}\n`); };
const loopback = h => h == null || h === '' || h === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::1' || h === '[::1]'
  || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(h) || h === '0.0.0.0' || h === '::';

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];   // the internal form: [options, callback]
  let host, port, pipe = null;
  if (opts && typeof opts === 'object') ({host, port, path: pipe = null} = opts);
  else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) { port = Number(opts); host = typeof args[1] === 'string' ? args[1] : undefined; }
  else if (typeof opts === 'string') pipe = opts;
  if (pipe) return connect.apply(this, args);
  const allowed = loopback(host);
  note({kind: 'connect', host: host ?? null, port: port ?? null, allowed});
  if (allowed) return connect.apply(this, args);
  const err = Object.assign(new Error(`net-guard: refused a connection to ${host}:${port}`), {code: 'ECONNREFUSED'});
  process.nextTick(() => this.destroy(err));
  return this;
};

const refusedLookup = host => Object.assign(new Error(`net-guard: refused a DNS lookup of ${host}`), {code: 'ENOTFOUND', hostname: host});
const lookup = dns.lookup;
dns.lookup = function guardedLookup(host, ...rest) {
  const allowed = loopback(host), cb = rest[rest.length - 1];
  note({kind: 'dns', host, allowed});
  if (allowed) return lookup.call(this, host, ...rest);
  if (typeof cb !== 'function') throw refusedLookup(host);
  process.nextTick(() => cb(refusedLookup(host)));
  return {};
};
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = async (host, ...rest) => {
  const allowed = loopback(host);
  note({kind: 'dns', host, allowed});
  if (!allowed) throw refusedLookup(host);
  return lookupPromise(host, ...rest);
};
syncBuiltinESMExports();
note({kind: 'loaded'});
