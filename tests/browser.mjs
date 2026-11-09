// Shared headless-browser bootstrap for the e2e checks.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAVES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'saves');
const ephemeralSaves = new Set();
let cleanupInstalled = false;

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', () => {
    for (const file of ephemeralSaves) {
      try { fs.unlinkSync(file); } catch (e) { /* rien à nettoyer */ }
    }
  });
}

// The world lives on disk now, so two suites sharing one save would inherit each
// other's edits and player position. Unless the caller picked a slot itself
// (persistence.mjs does), every page load gets a throwaway one, removed on exit.
export function isolatedUrl(url) {
  const target = new URL(url);
  if (target.searchParams.has('world')) return target.toString();
  const slot = `e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  target.searchParams.set('world', slot);
  installCleanup();
  ephemeralSaves.add(path.join(SAVES_DIR, `${slot}.json`));
  return target.toString();
}

// Prefer a Chromium already on this machine (Playwright's download cache first)
// so the suites run without fetching a browser.
export function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(root)) {
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const dir of dirs) {
      const base = path.join(root, dir);
      if (!fs.statSync(base).isDirectory()) continue;
      for (const sub of fs.readdirSync(base)) {
        for (const bin of ['chrome-linux64/chrome', 'chrome-linux-arm64/chrome', 'chrome-linux/chrome']) {
          const candidate = path.join(base, sub, bin);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // fall back to whatever playwright-core knows about
}

export const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
];

// Waits for the debug hook and for the saved world to be read back from disk: a
// test that touches physics or meshes before that restore lands would race it.
export async function waitForBoot(page, timeout = 30000) {
  await page.waitForFunction(() => !!window.__mc, null, { timeout });
  await page.waitForFunction(
    () => !window.__mc.worldReady || window.__mc.worldReady(),
    null,
    { timeout },
  );
}

// Loads the game and waits until the debug hook is live.
export async function openGame(url = 'http://localhost:8080', viewport = { width: 1024, height: 640 }) {
  const chrome = findChromium();
  const browser = await chromium.launch({
    ...(chrome ? { executablePath: chrome } : {}),
    args: GL_ARGS,
  });
  const page = await browser.newPage({ viewport });

  const consoleErrors = [];
  const badResponses = [];
  const servedUrls = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    servedUrls.push(`${r.status()} ${r.url()}`);
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(isolatedUrl(url), { waitUntil: 'load' });
  await waitForBoot(page);

  return { browser, page, consoleErrors, badResponses, servedUrls };
}

// Tiny assertion reporter shared by the suites.
export function makeReporter() {
  const results = [];
  let failures = 0;
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    if (!ok) failures++;
    const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`${tag}  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  };
  const summary = () => {
    const ok = results.length - failures;
    const tail = failures ? `\x1b[31m${failures} échec(s)\x1b[0m` : '\x1b[32mtout est vert\x1b[0m';
    console.log(`\n${ok}/${results.length} contrôles OK — ${tail}`);
    return failures;
  };
  return { check, summary, get failures() { return failures; } };
}
