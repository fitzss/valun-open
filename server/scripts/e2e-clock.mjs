// E2E-1 test hook, never used by the server itself: preloaded with `node --import <this file> server.mjs` by
// scripts/e2e-python-client.mjs for its fault-injection stack only. E2E_CLOCK_FILE names a file holding a clock offset
// in milliseconds (a whole number, default 0); Date.now() returns the real time plus that offset, read again every
// 100 ms, so the e2e script can move this server's clock (and so its windows: D-1's T + 1 h + 60 s, the 10-minute
// initiation window, note timestamps) while it runs. Nothing else is changed. Without E2E_CLOCK_FILE it does nothing.
import fs from 'node:fs';

const file = process.env.E2E_CLOCK_FILE;
if (file) {
  const real = Date.now.bind(Date);
  let offset = 0;
  const read = () => {
    try {
      const v = Number(fs.readFileSync(file, 'utf8').trim() || '0');
      if (Number.isInteger(v)) offset = v;
    } catch { /* keep the last offset */ }
  };
  read();
  setInterval(read, 100).unref();
  Date.now = () => real() + offset;
}
