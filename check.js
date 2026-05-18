import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

await loadDotenv(join(SCRIPT_DIR, '.env'));

const TOKEN = required('LIFX_TOKEN');
const IP = required('MACBOOK_IP');
const SELECTOR = process.env.LIFX_SELECTOR ?? 'all';
const DIM_THRESHOLD = parseInt(process.env.DIM_THRESHOLD ?? '2', 10);
const OFF_THRESHOLD = parseInt(process.env.OFF_THRESHOLD ?? '5', 10);
const PING_TIMEOUT_S = parseInt(process.env.PING_TIMEOUT_S ?? '1', 10);
const DIM_BRIGHTNESS = parseFloat(process.env.DIM_BRIGHTNESS ?? '0.15');
const FULL_BRIGHTNESS = parseFloat(process.env.FULL_BRIGHTNESS ?? '1.0');
const STATE_PATH = process.env.STATE_PATH ?? join(SCRIPT_DIR, 'state.json');

const MODES = {
  on: { power: 'on', brightness: FULL_BRIGHTNESS },
  dim: { power: 'on', brightness: DIM_BRIGHTNESS },
  off: { power: 'off' },
};

const reachable = await pingOnce(IP, PING_TIMEOUT_S);
const state = await readState(STATE_PATH);
const consecutiveMisses = reachable ? 0 : (state.consecutiveMisses ?? 0) + 1;

let desired;
if (reachable) {
  desired = 'on';
} else if (consecutiveMisses >= OFF_THRESHOLD) {
  desired = 'off';
} else if (consecutiveMisses >= DIM_THRESHOLD) {
  desired = 'dim';
} else {
  desired = state.lastMode ?? 'on';
}

const transition = desired !== state.lastMode;
if (transition) {
  await setLifxState(SELECTOR, TOKEN, MODES[desired]);
}

await writeState(STATE_PATH, {
  lastMode: desired,
  consecutiveMisses,
  lastCheck: new Date().toISOString(),
  lastReachable: reachable,
});

const stamp = new Date().toISOString();
const note = transition ? `lights -> ${desired}` : `lights=${desired} (no change)`;
console.log(`[${stamp}] macbook=${reachable ? 'up' : `down(${consecutiveMisses})`} ${note}`);

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
