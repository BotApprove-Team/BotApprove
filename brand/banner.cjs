/**
 * Builds BotApprove's banners from banner.html, so they cannot drift apart.
 *
 *   node brand/banner.cjs
 *
 * Rendered by headless Chrome, because the banners are set in IBM Plex like the
 * site and Chrome loads it the way the site does. Set CHROME to the browser's
 * path if it is not in the usual place. Nothing here is a dependency of the
 * bot: the size check reads the PNG header directly rather than pulling in an
 * image library.
 *
 * The files land in brand/. The site serves its own copies from
 * src/web/public, which are replaced deliberately, not by this script.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('No Chrome or Edge found. Set CHROME to its path.');
  process.exit(1);
}

const page = 'file:///' + path.join(__dirname, 'banner.html').replace(/\\/g, '/');

// [file, css width, css height, layout, scale, what it is for]
const jobs = [
  ['cover.png', 1024, 576, 'cover', 1, 'App Directory cover'],
  ['banner.png', 1920, 1080, 'cover', 1, 'og:image for the site'],
  ['profile-banner.png', 680, 240, 'wide', 1, 'Discord profile banner'],
  ['profile-banner-2x.png', 680, 240, 'wide', 2, 'the same at 2x'],
  ['x-header.png', 1500, 500, 'x', 1, 'X header'],
  ['x-header-2x.png', 1500, 500, 'x', 2, 'the same at 2x'],
];

function pngSize(file) {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

let failed = false;
for (const [name, W, H, layout, scale, use] of jobs) {
  const out = path.join(__dirname, name);
  const run = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${W},${H}`,
    '--virtual-time-budget=10000',
    `--screenshot=${out}`,
    `${page}#${layout}`,
  ], { encoding: 'utf8' });
  if (run.status !== 0 || !fs.existsSync(out)) {
    console.error(`${name} failed`, run.stderr);
    process.exit(1);
  }
  const [w, h] = pngSize(out);
  const ok = w === W * scale && h === H * scale;
  if (!ok) failed = true;
  console.log(`${name.padEnd(22)} ${w}x${h}${ok ? '' : `  WRONG, wanted ${W * scale}x${H * scale}`}  ${use}`);
}
process.exit(failed ? 1 : 0);
