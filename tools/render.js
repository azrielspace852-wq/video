'use strict';

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULTS = {
  fps: 60,
  duration: 5,
  aspect: 16 / 9,
  target2K: 2560,
  maxDuration: 60,
};

const NAV_TIMEOUT = 30_000;   // per-navigasi
const PROTO_TIMEOUT = 180_000; // CDP call timeout

const log = (...a) => console.log('[render]', ...a);

function parseRatio(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!w || !h) return null;
  return w / h;
}

function computeSize(aspect, longest) {
  let w, h;
  if (aspect >= 1) {
    w = longest;
    h = Math.round(longest / aspect);
  } else {
    h = longest;
    w = Math.round(longest * aspect);
  }
  w = Math.max(2, Math.floor(w / 2) * 2);
  h = Math.max(2, Math.floor(h / 2) * 2);
  return { width: w, height: h };
}

async function readMeta(page) {
  return page.evaluate(() => {
    const get = (n) => {
      const el = document.querySelector(`meta[name="${n}"]`);
      return el ? (el.getAttribute('content') || '').trim() : null;
    };
    const html = document.documentElement;
    const body = document.body;
    const attr = (n) =>
      (html && html.getAttribute(n)) || (body && body.getAttribute(n)) || null;
    return {
      aspect:     get('video-aspect')    || attr('data-video-aspect'),
      width:      get('video-width')     || attr('data-video-width'),
      height:     get('video-height')    || attr('data-video-height'),
      duration:   get('video-duration')  || attr('data-video-duration'),
      fps:        get('video-fps')       || attr('data-video-fps'),
      background: get('video-background')|| attr('data-video-background'),
    };
  });
}

/**
 * Advance virtual time by `ms`. Resolves when Chromium emits
 * `Emulation.virtualTimeBudgetExpired`, or after a real-time safety cap.
 */
function advanceVirtualTime(client, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      client.off('Emulation.virtualTimeBudgetExpired', onExpire);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const onExpire = () => finish();
    client.on('Emulation.virtualTimeBudgetExpired', onExpire);

    // safety cap: kalau 15s real time tidak ada kabar, lanjut saja
    const timer = setTimeout(() => finish(), 15_000);

    client
      .send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: ms,
        maxVirtualTimeTaskStarvationCount: 10_000,
      })
      .catch((err) => finish(err));
  });
}

async function renderOne(browser, htmlPath, outputPath) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(NAV_TIMEOUT);

  const fileUrl = pathToFileURL(htmlPath).href;

  // ─── PASS 1: load normal untuk baca meta ──────────────────────────────
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const meta = await readMeta(page);

  let aspect = DEFAULTS.aspect;
  if (meta.aspect) {
    const p = parseRatio(meta.aspect);
    if (p) aspect = p;
  } else if (meta.width && meta.height) {
    const w = parseFloat(meta.width);
    const h = parseFloat(meta.height);
    if (w > 0 && h > 0) aspect = w / h;
  }

  const fps = meta.fps
    ? Math.max(1, Math.min(120, parseFloat(meta.fps)))
    : DEFAULTS.fps;

  let duration = DEFAULTS.duration;
  let autoStop = false;
  if (meta.duration) {
    if (String(meta.duration).toLowerCase() === 'auto') {
      autoStop = true;
      duration = DEFAULTS.maxDuration;
    } else {
      const d = parseFloat(meta.duration);
      if (d > 0) duration = Math.min(d, DEFAULTS.maxDuration);
    }
  }

  const size = computeSize(aspect, DEFAULTS.target2K);
  await page.setViewport({
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
  });

  // ─── PASS 2: reload dengan virtual time ───────────────────────────────
  const client = await page.createCDPSession();

  // ★ Kunci perbaikan: JANGAN 'pause' dulu.
  // 'pauseIfNetworkFetchesPending' membiarkan virtual time jalan selama
  // ada network request pending → event `load` tetap bisa fire.
  // Begitu network idle, virtual time otomatis pause.
  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: 60_000,                    // upper bound virtual ms untuk load
    maxVirtualTimeTaskStarvationCount: 10_000,
  });

  await page.goto(fileUrl, {
    waitUntil: 'domcontentloaded',     // load bisa tidak fire di beberapa lib
    timeout: NAV_TIMEOUT,
  });

  // Beri waktu real (bukan virtual) supaya font/image decode selesai.
  // Virtual time tetap paused, jadi tidak memajukan animasi.
  await new Promise((r) => setTimeout(r, 500));

  const bg = meta.background || '#000000';
  await page.evaluate((c) => {
    document.documentElement.style.background = c;
    if (document.body) document.body.style.background = c;
  }, bg);

  // ─── ffmpeg ───────────────────────────────────────────────────────────
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-vsync', 'cfr',
    '-movflags', '+faststart',
    '-an',
    outputPath,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))
    );
    ffmpeg.on('error', reject);
  });

  const frameBudget = 1000 / fps;
  const totalFrames = Math.round(fps * duration);

  const writeFrame = (buf) =>
    new Promise((resolve, reject) => {
      ffmpeg.stdin.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  let framesWritten = 0;
  let stoppedEarly = false;

  try {
    for (let i = 0; i < totalFrames; i++) {
      await advanceVirtualTime(client, frameBudget);

      const buf = await page.screenshot({
        type: 'png',
        optimizeForSpeed: true,
      });
      await writeFrame(buf);
      framesWritten++;

      if (autoStop && i % 10 === 0 && i > 0) {
        const done = await page.evaluate(() => !!window.__videoDone);
        if (done) {
          stoppedEarly = true;
          log(`  auto-stop pada frame ${i + 1}`);
          break;
        }
      }

      if (i % 30 === 0 || i === totalFrames - 1) {
        log(`  frame ${i + 1}/${totalFrames}`);
      }
    }
  } finally {
    ffmpeg.stdin.end();
    await ffmpegDone.catch(() => {});
    await page.close();
  }

  return {
    width: size.width,
    height: size.height,
    fps,
    frames: framesWritten,
    duration: framesWritten / fps,
    stoppedEarly,
  };
}

async function main() {
  const cwd = process.cwd();
  const videoDir = path.join(cwd, 'video');
  const outputDir = path.join(cwd, 'output');

  if (!fs.existsSync(videoDir)) {
    console.error('Folder video/ tidak ditemukan.');
    process.exit(1);
  }

  const files = fs
    .readdirSync(videoDir)
    .filter((f) => /\.html?$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error('Tidak ada file .html di folder video/.');
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  log(`Menemukan ${files.length} file HTML.`);

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: PROTO_TIMEOUT,        // ★ tambahan penting
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });

  const results = [];
  try {
    for (const file of files) {
      const htmlPath = path.join(videoDir, file);
      const baseName = file.replace(/\.html?$/i, '');
      const outputPath = path.join(outputDir, `${baseName}.mp4`);
      log(`▶ ${file}`);
      const t0 = Date.now();
      try {
        const info = await renderOne(browser, htmlPath, outputPath);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        log(
          `  ✓ ${baseName}.mp4 — ${info.width}x${info.height} @ ${info.fps}fps, ` +
          `${info.frames} frames (${sec}s)`
        );
        results.push({ file, ok: true, info });
      } catch (err) {
        log(`  ✗ ${file} gagal: ${err.message}`);
        results.push({ file, ok: false, error: String(err) });
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} file gagal dirender.`);
    process.exit(2);
  }
  log('Selesai.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
