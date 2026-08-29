// Run browser mocha tests via Brave headless + CDP against the dev-server.
import { spawn } from 'node:child_process';

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const TEST_URL = process.argv[2] || 'http://localhost:5001/index.html';

// Launch Brave headless with remote debugging
const chrome = spawn(BRAVE, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=9222',
  '--user-data-dir=/tmp/brave-test-profile',
  TEST_URL,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderrBuf = '';
chrome.stderr.on('data', (d) => { stderrBuf += d.toString(); });

// Wait for DevTools endpoint
const devtoolsPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Brave did not start:\n' + stderrBuf.slice(-1500))), 20000);
  const poll = () => {
    fetch('http://localhost:9222/json/version')
      .then((r) => r.json())
      .then((d) => { clearTimeout(timer); resolve(d.webSocketDebuggerUrl); })
      .catch(() => setTimeout(poll, 500));
  };
  poll();
  chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Brave exited code=${code}`)); });
});
console.log('[runner] DevTools:', devtoolsPort);

// List pages
const pages = await fetch('http://localhost:9222/json/list').then((r) => r.json());
const page = pages.find((p) => p.type === 'page');
if (!page) { console.log('[runner] NO PAGE TARGET'); process.exit(1); }
const pageWs = page.webSocketDebuggerUrl;
console.log('[runner] page ws:', pageWs);

// CDP client
const ws = new WebSocket(pageWs);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');

// Wait for mocha to finish
let result = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const { result: evalRes } = await send('Runtime.evaluate', {
    expression: `(() => {
      const mochaEl = document.getElementById('mocha');
      if (!mochaEl) return { done: false };
      const failures = document.querySelectorAll('#mocha .fail').length;
      const passes = document.querySelectorAll('#mocha .pass').length;
      if (failures + passes > 0) return { done: true, failures, passes, html: mochaEl.textContent.slice(0, 5000) };
      return { done: false };
    })()`,
    returnByValue: true,
  });
  const r = evalRes.result.value;
  if (r.done) { result = r; break; }
}

if (!result) {
  console.log('[runner] TIMEOUT waiting for mocha results');
  const { result: evalRes } = await send('Runtime.evaluate', {
    expression: `document.body ? document.body.textContent.slice(0, 2000) : 'NO BODY'`,
    returnByValue: true,
  });
  console.log('page:', evalRes.result.value);
} else {
  console.log('[runner] ===== MOCHA RESULTS =====');
  console.log(`passes: ${result.passes}, failures: ${result.failures}`);
  console.log('--- report ---');
  console.log(result.html);
}

ws.close();
chrome.kill();
process.exit(result && result.failures === 0 ? 0 : 1);
