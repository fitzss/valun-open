// The network's request limits, in one place (fix inbox #145; the local-readiness audit of Nov 18: IMG-2, MR-4, MR-5,
// COV-8): the self-serve join caps (Pilot.joinSandbox), the per-minute budgets of lib/pilot/http.mjs, and the A2A front
// door's (lib/a2a.mjs). Every agent behind one client address shares that address's budgets, and through a port Docker
// publishes every client on the machine comes from one address (the bridge's gateway): on a local server the whole
// machine gets 12 self-serve joins an hour and 90 writes a minute. So a local server (VALUN_ENVIRONMENT=local, the
// local image), and only a local server, takes settings that change them, for scale tests: limitSettings below. The
// hosted servers (the testnet, staging) always run the defaults: a setting given to one is ignored, and it says so.
import {SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, SANDBOX_JOINS_PER_HOUR_TOTAL, SANDBOX_JOINS_PER_DAY} from './core.mjs';

// Writes (every request but GET and HEAD, counted before routing, refused ones too) per minute, per client address and
// per token; reads per minute per token (agent and owner tokens apart), 4 times the writes; reads per minute per client
// address, whatever token a read carries (public reads are served from the burst cache, so several agents and viewers
// behind one address get more than one token's budget). Sliding 60 s windows.
export const WRITES_PER_MINUTE = 90;
export const TOKEN_READS_PER_MINUTE = WRITES_PER_MINUTE * 4;
export const IP_READS_PER_MINUTE = 1800;
// The A2A front door (read-only): requests per minute per client address.
export const A2A_PER_MINUTE = 120;
// The largest request body a /pilot/v1 route or the A2A endpoint reads (413 too_large above it).
export const BODY_MAX_BYTES = 65_536;

export const DEFAULT_LIMITS = Object.freeze({
  sandbox_joins: Object.freeze({per_address_per_hour: SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, per_hour: SANDBOX_JOINS_PER_HOUR_TOTAL, per_day: SANDBOX_JOINS_PER_DAY}),
  writes_per_minute: Object.freeze({per_address: WRITES_PER_MINUTE, per_token: WRITES_PER_MINUTE}),
  reads_per_minute: Object.freeze({per_address: IP_READS_PER_MINUTE, per_token: TOKEN_READS_PER_MINUTE}),
});

// A local server's settings, each a whole number from 1 to LIMIT_MAX: [variable, group, key] of DEFAULT_LIMITS.
export const LIMIT_MAX = 1_000_000;
export const LIMIT_SETTINGS = Object.freeze([
  ['PILOT_SANDBOX_JOINS_PER_HOUR_PER_ADDRESS', 'sandbox_joins', 'per_address_per_hour'],
  ['PILOT_SANDBOX_JOINS_PER_HOUR', 'sandbox_joins', 'per_hour'],
  ['PILOT_SANDBOX_JOINS_PER_DAY', 'sandbox_joins', 'per_day'],
  ['PILOT_WRITES_PER_MINUTE_PER_ADDRESS', 'writes_per_minute', 'per_address'],
  ['PILOT_WRITES_PER_MINUTE_PER_TOKEN', 'writes_per_minute', 'per_token'],
  ['PILOT_READS_PER_MINUTE_PER_ADDRESS', 'reads_per_minute', 'per_address'],
  ['PILOT_READS_PER_MINUTE_PER_TOKEN', 'reads_per_minute', 'per_token'],
].map(s => Object.freeze(s)));
const settingOf = Object.fromEntries(LIMIT_SETTINGS.map(([name, group, key]) => [`${group}.${key}`, name]));
// The variable that sets a limit (for the messages of a local server's refusals).
export const limitSetting = (group, key) => settingOf[`${group}.${key}`];

// The limits a server runs with, from its environment. `local`: whether it is a local server (lib/environment.mjs
// LOCAL). Returns {limits, joinLimits, routeCfg, ignored, errors}:
//   - limits: the effective limits, shaped as DEFAULT_LIMITS (GET /info `limits` on a local server);
//   - joinLimits: the Pilot's constructor option (core.mjs joinSandbox);
//   - routeCfg: what server.mjs adds to the cfg of createPilotRoutes: on a local server every budget, the defaults
//     included, so that no budget follows from another (lib/pilot/http.mjs derives the per-token reads, and the
//     per-address ones, from the per-token writes when only those are given); {} elsewhere, so a hosted server's routes
//     run exactly as before;
//   - ignored: the settings a hosted server was given (it runs the defaults);
//   - errors: one line per setting that is not a whole number from 1 to LIMIT_MAX (the server does not start).
export function limitSettings(env = {}, {local = false} = {}) {
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([g, v]) => [g, {...v}]));
  const ignored = [], errors = [];
  for (const [name, group, key] of LIMIT_SETTINGS) {
    const v = env[name];
    if (v === undefined || v === '') continue;
    if (!local) { ignored.push(name); continue; }
    if (!/^\d{1,7}$/.test(v) || Number(v) < 1 || Number(v) > LIMIT_MAX) { errors.push(`${name}=${String(v).slice(0, 40)}: a whole number from 1 to ${LIMIT_MAX}`); continue; }
    limits[group][key] = Number(v);
  }
  const routeCfg = local ? {pilotIpWriteLimitPerMinute: limits.writes_per_minute.per_address, pilotRateLimitPerMinute: limits.writes_per_minute.per_token,
    pilotIpReadLimitPerMinute: limits.reads_per_minute.per_address, pilotReadLimitPerMinute: limits.reads_per_minute.per_token} : {};
  return {limits, joinLimits: {...limits.sandbox_joins}, routeCfg, ignored, errors};
}

// What a local server says at start when VALUN_TRUST_FLY_CLIENT_IP=1 (server.mjs): it counts each client by the address it
// connects from, never by the Fly-Client-IP header a client sends, which would let any client pick its own budgets.
export const LOCAL_FLY_IP_IGNORED = 'VALUN_TRUST_FLY_CLIENT_IP=1: ignored on a local server, which counts each client by the address it connects '
  + 'from, never by a header the client sends; to give your agents more room, raise its limits (PILOT_WRITES_PER_MINUTE_PER_ADDRESS and the '
  + 'others: docs/LOCAL.md)';

// What a hosted server says, once at start, about the settings it was given and ignores.
export const ignoredLimitsLine = names => `Pilot: ${names.join(', ')}: ignored: only a local server (VALUN_ENVIRONMENT=local) takes `
  + `${names.length === 1 ? 'this setting' : 'these settings'}; this server runs the default limits`;
// What a local server says, once at start, about the limits its settings changed (`limits` as limitSettings gives them);
// null when it runs the defaults.
export function changedLimitsLine(limits) {
  const changed = LIMIT_SETTINGS.filter(([, g, k]) => limits[g][k] !== DEFAULT_LIMITS[g][k])
    .map(([name, g, k]) => `${name}=${limits[g][k]} (the default is ${DEFAULT_LIMITS[g][k]})`);
  return changed.length ? `Pilot: limits: ${changed.join(', ')}; GET /pilot/v1/info gives every limit (limits)` : null;
}
