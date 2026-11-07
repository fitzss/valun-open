// Node-only host checker for delivery measurements: resolveHost(host) -> 'public' | 'private' | 'not_found', from the
// addresses the system resolver returns (getaddrinfo, as the Python client's socket.getaddrinfo). DNS only: no page is
// fetched and no connection is opened to the host. Imported separately ("valun/dns") so that browser bundles of the
// main entry never pull in node:dns.
//
//   import {resolveHost} from 'valun/dns';
//   const agent = new ValunAgent(client, {resolveHost});

import {lookup} from 'node:dns/promises';
import {hostResolver} from './measure.js';

export const resolveHost = hostResolver(async host => (await lookup(host, {all: true})).map(a => a.address));
