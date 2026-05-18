import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

await loadDotenv(join(SCRIPT_DIR, '.env'));

const TOKEN = required('LIFX_TOKEN');
const IP = required('MACBOOK_IP');
const SELECTOR = process.env.LIFX_SELECTOR ?? 'all';
const PING_INTERVAL_S = parseFloat(process.env.PING_INTERVAL_S ?? '3');
const PING_TIMEOUT_S = parseInt(process.env.PING_TIMEOUT_S ?? '1', 10);
const DIM_AFTER_S = parseInt(process.env.DIM_AFTER_S ?? '120', 10);
const OFF_AFTER_S = parseInt(process.env.OFF_AFTER_S ?? '300', 10);
const DIM_BRIGHTNESS = parseFloat(process.env.DIM_BRIGHTNESS ?? '0.15');
const FULL_BRIGHTNESS = parseFloat(process.env.FULL_BRIGHTNESS ?? '1.0');
const STATE_PATH = process.env.STATE_PATH ?? join(SCRIPT_DIR, 'state.json');
const ONCE = process.argv.includes('--once');

const MODES = {
  on: { power: 'on', brightness: FULL_BRIGHTNESS },
  dim: { power: 'on', brightness: DIM_BRIGHTNESS },
  off: { power: 'off' },
};

let state = await readState(STATE_PATH);
let running = true;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { running = false; });
}

log(`startup: ping=${IP} every ${PING_INTERVAL_S}s, dim after ${DIM_AFTER_S}s, off after ${OFF_AFTER_S}s`);

while (running) {
  try {
    await tick();
  } catch (err) {
    log(`tick failed: ${err.message}`);
  }
  if (ONCE) break;
  await sleep(PING_INTERVAL_S * 1000);
}

async function tick() {
  const now = Date.now();
  const reachable = await pingOnce(IP, PING_TIMEOUT_S);

  const lastReachableAt = reachable ? now : (state.lastReachableAt ?? now);
  const secondsDown = reachable ? 0 : (now - lastReachableAt) / 1000;

  let desired;
  if (reachable) {
    desired = 'on';
  } else if (secondsDown >= OFF_AFTER_S) {
    desired = 'off';
  } else if (secondsDown >= DIM_AFTER_S) {
    desired = 'dim';
  } else {
    desired = state.lastMode ?? 'on';
  }

  const transition = desired !== state.lastMode;
  if (transition) {
    await setLifxState(SELECTOR, TOKEN, MODES[desired]);
    log(`macbook=${reachable ? 'up' : `down(${Math.round(secondsDown)}s)`} lights -> ${desired}`);
  }

  state = {
    lastMode: desired,
    lastReachable: reachable,
    lastReachableAt,
    lastCheck: new Date(now).toISOString(),
  };
  await writeState(STATE_PATH, state);
}

async function pingOnce(ip, timeoutSec) {
  try {
    await execFileP('ping', ['-c', '1', '-W', String(timeoutSec), ip]);
    return true;
  } catch {
    return false;
  }
}

async function setLifxState(selector, token, body) {
  const url = `https://api.lifx.com/v1/lights/${encodeURIComponent(selector)}/state`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LIFX API ${res.status}: ${text}`);
  }
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(path, state) {
  await writeFile(path, JSON.stringify(state, null, 2));
}

async function loadDotenv(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
