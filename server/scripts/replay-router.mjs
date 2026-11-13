// The retired pilot's app (valun-desk, which holds valun.tech, www.valun.tech and valun-desk.fly.dev): every request is
// replayed by Fly's proxy to the app that now serves Valun (VALUN_RETIRED_TO_APP, the testnet's valun-testnet), with its
// method, path, headers and body, so every hostname the pilot had keeps working and serves the one network. Nothing of
// the pilot runs (no tracker, no app); its data stays on the volume, untouched. Started by scripts/docker-entrypoint.sh
// when VALUN_RETIRED_TO_APP is set.
//
// Fly-Replay works between apps of one organization, for request bodies up to Fly's replay limit (Valun's are a few
// KB). If a request ever arrives without Fly's proxy in front (it cannot on Fly), the answer is a 503 that names the
// network's address, never the pilot's data.
import http from 'node:http';

const app = process.env.VALUN_RETIRED_TO_APP, port = Number(process.env.PORT || 8080);
const origin = process.env.VALUN_RETIRED_ORIGIN || 'https://valun.tech';
if (!/^[a-z0-9-]{2,63}$/.test(app || '')) { console.error('replay-router: VALUN_RETIRED_TO_APP must be a Fly app name'); process.exit(2); }

const server = http.createServer((req, res) => {
  // Fly's health check and anything Fly asks on the machine itself: answered here.
  if (req.url === '/__retired') {
    res.writeHead(200, {'content-type': 'application/json'});
    return res.end(JSON.stringify({retired: 'valun-pilot-1', replays_to: app, network: origin}));
  }
  res.writeHead(503, {'fly-replay': `app=${app}`, 'content-type': 'application/json', 'retry-after': '5'});
  res.end(JSON.stringify({error: 'moved', message: `The Valun pilot network (valun-pilot-1) was retired on 2026-11-13. Valun runs on one network: ${origin}`}));
});
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({action: 'replay_router_started', replays_to: app, port})));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
