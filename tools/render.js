'use strict';

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// ── Konfigurasi ────────────────────────────────────────────────────────────
const DEFAULTS = {
  fps: 60,
  duration: 5,
  aspect: 16 / 9,
  target2K: 2560,
  maxDuration: 60,
};

const CFG = {
  navTimeoutMs:   parseInt(process.env.NAV_TIMEOUT_MS   || '30000', 10),
  protoTimeoutMs: parseInt(process.env.PROTO_TIMEOUT_MS || '180000', 10),
  frameTimeoutMs: parseInt(process.env.FRAME_TIMEOUT_MS || '15000', 10),
  // Berhenti rapi sebelum GHA hard-kill (default 5j30m)
  softDeadlineMs: parseInt(process.env.SOFT_DEADLINE_MS || String(5.5 * 3600_000), 10),
  // 'jpeg' | 'png' | 'webp'
  frameFormat:  (process.env.FRAME_FORMAT  || 'jpeg').toLowerCase(),
  frameQuality: parseInt(process.env.FRAME_QUALITY || '95', 10),
  force:        process.env.FORCE_RERENDER === '1',
  keepFrames:   process.env.KEEP_FRAMES === '1',
};

const EXT = CFG.frameFormat === 'jpeg' ? 'jpg'
          : CFG.frameFormat === 'webp' ? 'webp'
          : 'png';

const log = (...a) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] [render]`, ...a);
};

const startedAt = Date.now();
const elapsedSec = () => ((Date.now() - startedAt) / 1000).toFixed(1);

// ── Util ───────────────────────────────────────────────────────────────────
function parseRatio(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = parseFloat(m[1]), h = parseFloat(m[2]);
  return w && h ? w / h : null;
}

function computeSize(aspect, longest) {
  let w, h;
  if (aspect >= 1) { w = longest; h = Math.round(longest / aspect); }
  else             { h = longest; w = Math.round(longest * aspect); }
  return {
    width:  Math.max(2, Math.floor(w / 2) * 2),
    height: Math.max(2, Math.floor(h / 2) * 2),
  };
}

function sha(str, len = 16) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, len);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms); }),
  ]);
}

// ── Meta dari HTML ─────────────────────────────────────────────────────────
async function readMeta(page) {
  return page.evaluate(() => {
    const get  = (n) => { const e = document.querySelector(`meta[name="${n}"]`); return e ? (e.getAttribute('content') || '').trim() : null; };
    const attr = (n) => document.documentElement.getAttribute(n) || (document.body && document.body.getAttribute(n)) || null;
    return {
      aspect:     get('video-aspect')     || attr('data-video-aspect'),
      width:      get('video-width')      || attr('data-video-width'),
      height:     get('video-height')     || attr('data-video-height'),
      duration:   get('video-duration')   || attr('data-video-duration'),
      fps:        get('video-fps')        || attr('data-video-fps'),
      background: get('video-background') || attr('data-video-background'),
    };
  });
}

// ── Advance virtual time ───────────────────────────────────────────────────
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
    const timer = setTimeout(() => finish(new Error('virtualTime budget timeout')), CFG.frameTimeoutMs);

    client.send('Emulation.setVirtualTimePolicy', {
      policy: 'advance',
      budget: ms,
      maxVirtualTimeTaskStarvationCount: 10_000,
    }).catch((e) => finish(e));
  });
}

// ── PHASE 1: render frame ke disk ──────────────────────────────────────────
async function renderFrames(browser, htmlPath, framesDir, opts) {
  const { width, height, fps, totalFrames, background, resumeFrom } = opts;
  const framePath = (i) => path.join(framesDir, `frame_${String(i).padStart(5, '0')}.${EXT}`);

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(CFG.navTimeoutMs);
  page.setDefaultTimeout(CFG.navTimeoutMs);
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  const client = await page.createCDPSession();

  // PENTING: pauseIfNetworkFetchesPending, bukan 'pause' (fix timeout 60s).
  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    initialVirtualTime: Math.round(resumeFrom * (1000 / fps)),
    budget: 60_000,
    maxVirtualTimeTaskStarvationCount: 10_000,
  });

  const fileUrl = pathToFileURL(htmlPath).href;
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeoutMs });

  // Beri waktu nyata untuk decode font/gambar. Virtual time tetap pause.
  await new Promise((r) => setTimeout(r, 400));

  await page.evaluate((c) => {
    document.documentElement.style.background = c;
    if (document.body) document.body.style.background = c;
  }, background);

  const frameBudget = 1000 / fps;
  const shotOpts = { type: CFG.frameFormat, optimizeForSpeed: true, fromSurface: true };
  if (CFG.frameFormat === 'jpeg' || CFG.frameFormat === 'webp') shotOpts.quality = CFG.frameQuality;

  try {
    for (let i = resumeFrom; i < totalFrames; i++) {
      await advanceVirtualTime(client, frameBudget);

      const buf = await withTimeout(
        page.screenshot(shotOpts),
        CFG.frameTimeoutMs,
        `frame ${i}`
      );
      fs.writeFileSync(framePath(i), buf);

      if (i % 30 === 0 || i === totalFrames - 1) {
        const pct = (((i + 1) / totalFrames) * 100).toFixed(1);
        log(`      frame ${i + 1}/${totalFrames} (${pct}%)`);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return totalFrames;
}

// ── PHASE 2: frames → MP4 ──────────────────────────────────────────────────
function encodeMp4(framesDir, outputPath, fps) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(fps),
      '-start_number', '0',
      '-i', path.join(framesDir, `frame_%05d.${EXT}`),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-fps_mode', 'cfr',
      '-movflags', '+faststart',
      '-threads', '0',
      '-an',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    proc.on('error', reject);
  });
}

// ── State / checkpoint ─────────────────────────────────────────────────────
function readState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return null; }
}
function writeState(stateFile, obj) {
  fs.writeFileSync(stateFile, JSON.stringify(obj, null, 2));
}

// ── Render satu video ──────────────────────────────────────────────────────
async function processVideo(browser, htmlFile, videoDir, framesRoot, outputDir) {
  const htmlPath = path.join(videoDir, htmlFile);
  const baseName = htmlFile.replace(/\.html?$/i, '');
  const framesDir = path.join(framesRoot, baseName);
  const outputPath = path.join(outputDir, `${baseName}.mp4`);
  const stateFile = path.join(framesDir, '.state.json');

  log(`▶ ${htmlFile} (t=${elapsedSec()}s)`);
  const t0 = Date.now();

  // ── PASS 1: baca meta ────────────────────────────────────────────────
  const probe = await browser.newPage();
  probe.setDefaultNavigationTimeout(CFG.navTimeoutMs);
  await probe.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await probe.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeoutMs });
  const meta = await readMeta(probe);
  await probe.close();

  let aspect = DEFAULTS.aspect;
  if (meta.aspect) { const p = parseRatio(meta.aspect); if (p) aspect = p; }
  else if (meta.width && meta.height) {
    const w = parseFloat(meta.width), h = parseFloat(meta.height);
    if (w > 0 && h > 0) aspect = w / h;
  }

  const fps = meta.fps ? Math.max(1, Math.min(120, parseFloat(meta.fps))) : DEFAULTS.fps;
  let duration = DEFAULTS.duration, autoStop = false;
  if (meta.duration) {
    if (String(meta.duration).toLowerCase() === 'auto') { autoStop = true; duration = DEFAULTS.maxDuration; }
    else { const d = parseFloat(meta.duration); if (d > 0) duration = Math.min(d, DEFAULTS.maxDuration); }
  }
  const size = computeSize(aspect, DEFAULTS.target2K);
  const totalFrames = Math.round(fps * duration);
  const background = meta.background || '#000000';

  // ── CEK STATE (bisa skip render ulang) ───────────────────────────────
  const htmlBody = fs.readFileSync(htmlPath);
  const htmlHash = sha(htmlBody);
  const expectHash = sha(`${htmlHash}|${size.width}x${size.height}|${fps}|${totalFrames}|${background}`);

  fs.mkdirSync(framesDir, { recursive: true });
  let state = readState(stateFile);
  let resumeFrom = 0;

  if (!CFG.force && state && state.hash === expectHash && state.phase === 'frames-done') {
    log(`   ↺ skip phase 1 (frames sudah lengkap, hash cocok)`);
  } else if (!CFG.force && state && state.hash === expectHash && state.phase === 'frames-in-progress') {
    // Verifikasi frame terakhir benar-benar ada
    let n = state.completedFrames;
    while (n > 0) {
      const p = path.join(framesDir, `frame_${String(n - 1).padStart(5, '0')}.${EXT}`);
      if (fs.existsSync(p)) break;
      n--;
    }
    resumeFrom = n;
    log(`   ↺ resume phase 1 dari frame ${resumeFrom + 1}/${totalFrames}`);
  } else {
    // Bersihkan sisa lama
    for (const f of fs.readdirSync(framesDir)) {
      if (f.startsWith('frame_') || f === '.state.json') fs.rmSync(path.join(framesDir, f));
    }
    state = null;
  }

  // ── PHASE 1 ──────────────────────────────────────────────────────────
  if (!state || state.phase !== 'frames-done') {
    writeState(stateFile, {
      hash: expectHash, htmlHash, width: size.width, height: size.height,
      fps, totalFrames, background, completedFrames: resumeFrom,
      phase: 'frames-in-progress', startedAt: new Date().toISOString(),
    });

    log(`   phase 1 → ${totalFrames} frame @ ${size.width}×${size.height} (${EXT} q${CFG.frameQuality})`);
    await renderFrames(browser, htmlPath, framesDir, {
      width: size.width, height: size.height, fps, totalFrames, background, resumeFrom,
    });

    writeState(stateFile, {
      hash: expectHash, htmlHash, width: size.width, height: size.height,
      fps, totalFrames, background, completedFrames: totalFrames,
      phase: 'frames-done', updatedAt: new Date().toISOString(),
    });
    log(`   ✓ phase 1 selesai`);
  }

  // ── PHASE 2 ──────────────────────────────────────────────────────────
  log(`   phase 2 → encode MP4`);
  await encodeMp4(framesDir, outputPath, fps);

  const stat = fs.statSync(outputPath);
  log(`   ✓ ${baseName}.mp4 (${(stat.size / 1024 / 1024).toFixed(1)} MB) dalam ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Bersihkan frames kalau tidak diminta simpan
  if (!CFG.keepFrames) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    log(`   ⌫ frames dihapus (set KEEP_FRAMES=1 untuk mempertahankan)`);
  }

  return { file: htmlFile, ok: true, outputPath, bytes: stat.size };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const cwd = process.cwd();
  const videoDir   = path.join(cwd, 'video');
  const framesRoot = path.join(cwd, 'frames');
  const outputDir  = path.join(cwd, 'output');

  if (!fs.existsSync(videoDir)) { console.error('Folder video/ tidak ditemukan.'); process.exit(1); }

  const files = fs.readdirSync(videoDir).filter((f) => /\.html?$/i.test(f)).sort();
  if (files.length === 0) { console.error('Tidak ada file .html di folder video/.'); process.exit(1); }

  fs.mkdirSync(framesRoot, { recursive: true });
  fs.mkdirSync(outputDir,  { recursive: true });

  log(`Menemukan ${files.length} HTML: ${files.join(', ')}`);
  log(`Konfigurasi: format=${EXT} q=${CFG.frameQuality} force=${CFG.force} keepFrames=${CFG.keepFrames}`);
  log(`Soft deadline: ${(CFG.softDeadlineMs / 3600_000).toFixed(1)}j dari sekarang`);

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: CFG.protoTimeoutMs,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--font-render-hinting=none', '--hide-scrollbars', '--mute-audio',
    ],
  });

  const results = [];
  let softStop = false;

  try {
    for (const file of files) {
      // Cek soft deadline SEBELUM memulai video baru
      if (Date.now() - startedAt > CFG.softDeadlineMs) {
        log(`⏸ Soft deadline tercapai. Sisa ${files.length - results.length} video dilewati.`);
        softStop = true;
        break;
      }

      try {
        const r = await processVideo(browser, file, videoDir, framesRoot, outputDir);
        results.push(r);
      } catch (err) {
        log(`   ✗ ${file} gagal: ${err.message}`);
        results.push({ file, ok: false, error: String(err) });
        // Beri kesempatan ke video berikutnya meski satu gagal
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  log('');
  log('═══ RINGKASAN ═══');
  for (const r of results) {
    if (r.ok) log(`  ✓ ${r.file} → ${path.basename(r.outputPath)} (${(r.bytes / 1024 / 1024).toFixed(1)} MB)`);
    else      log(`  ✗ ${r.file} — ${r.error}`);
  }
  log(`Total: ${ok.length} sukses, ${bad.length} gagal, ${elapsedSec()}s`);

  if (softStop) process.exit(0);      // tidak error, cuma berhenti rapi
  if (bad.length > 0) process.exit(2); // ada yang gagal
  process.exit(0);
}

// Graceful: kalau GHA kirim SIGTERM, coba selesaikan tulis state dan keluar.
process.on('SIGTERM', () => {
  log('SIGTERM diterima — keluar rapi. Frame yang sudah ada akan di-resume di run berikutnya.');
  process.exit(0);
});

main().catch((err) => { console.error(err); process.exit(1); });
