'use strict';

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULTS = { fps: 60, duration: 5, aspect: 16 / 9, target2K: 2560, maxDuration: 60 };

const CFG = {
  navTimeoutMs:   parseInt(process.env.NAV_TIMEOUT_MS   || '60000',  10),
  protoTimeoutMs: parseInt(process.env.PROTO_TIMEOUT_MS || '180000', 10),
  frameTimeoutMs: parseInt(process.env.FRAME_TIMEOUT_MS || '20000',  10),
  softDeadlineMs: parseInt(process.env.SOFT_DEADLINE_MS || String(5.5 * 3600_000), 10),
  frameFormat:    (process.env.FRAME_FORMAT  || 'jpeg').toLowerCase(),
  frameQuality:   parseInt(process.env.FRAME_QUALITY || '95', 10),
  force:          process.env.FORCE_RERENDER === '1',
  keepFrames:     process.env.KEEP_FRAMES === '1',
};

const EXT = CFG.frameFormat === 'jpeg' ? 'jpg'
          : CFG.frameFormat === 'webp' ? 'webp' : 'png';

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (...a) => console.log(`[${elapsed()}s] [render]`, ...a);

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
  return { width: Math.max(2, Math.floor(w/2)*2), height: Math.max(2, Math.floor(h/2)*2) };
}

function sha(str, len = 16) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, len);
}

async function readMeta(page) {
  return page.evaluate(() => {
    const get  = (n) => { const e = document.querySelector(`meta[name="${n}"]`); return e ? (e.getAttribute('content')||'').trim() : null; };
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

/**
 * Advance virtual time by `ms`. RESOLVE on either budgetExpired or safety
 * timeout — jangan reject, karena satu frame nyangkut tidak boleh
 * menggagalkan seluruh video.
 */
function advanceVirtualTime(client, ms, label = '') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      client.off('Emulation.virtualTimeBudgetExpired', onExpire);
      clearTimeout(timer);
      if (reason === 'timeout') log(`      ⚠ advance ${ms}ms timeout${label ? ` (${label})` : ''} — lanjut`);
      resolve();
    };
    const onExpire = () => finish('expired');
    client.on('Emulation.virtualTimeBudgetExpired', onExpire);
    const timer = setTimeout(() => finish('timeout'), CFG.frameTimeoutMs);

    client.send('Emulation.setVirtualTimePolicy', {
      policy: 'advance',
      budget: ms,
      maxVirtualTimeTaskStarvationCount: 10_000,
    }).catch((err) => {
      log(`      ⚠ setVirtualTimePolicy error: ${err.message}`);
      finish('error');
    });
  });
}

function encodeMp4(framesDir, outputPath, fps) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(fps), '-start_number', '0',
      '-i', path.join(framesDir, `frame_%05d.${EXT}`),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps), '-fps_mode', 'cfr',
      '-movflags', '+faststart', '-threads', '0', '-an',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    proc.on('error', reject);
  });
}

const readState  = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeState = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

// ── render satu video ──────────────────────────────────────────────────────
async function processVideo(browser, htmlFile, videoDir, framesRoot, outputDir) {
  const htmlPath   = path.join(videoDir, htmlFile);
  const baseName   = htmlFile.replace(/\.html?$/i, '');
  const framesDir  = path.join(framesRoot, baseName);
  const outputPath = path.join(outputDir, `${baseName}.mp4`);
  const stateFile  = path.join(framesDir, '.state.json');
  const fileUrl    = pathToFileURL(htmlPath).href;

  log(`▶ ${htmlFile}`);
  const tStart = Date.now();
  fs.mkdirSync(framesDir, { recursive: true });

  // ── PASS 1: navigasi normal untuk baca meta ──────────────────────────
  //  PENTING: pakai SATU page untuk pass 1 & 2 (jangan buat page baru).
  log(`   pass 1: load & baca meta`);
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(CFG.navTimeoutMs);
  page.setDefaultTimeout(CFG.navTimeoutMs);
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeoutMs });

  const meta = await readMeta(page);
  log(`   meta: ${JSON.stringify(meta)}`);

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

  const size        = computeSize(aspect, DEFAULTS.target2K);
  const totalFrames = Math.round(fps * duration);
  const background  = meta.background || '#000000';
  const frameBudget = 1000 / fps;

  log(`   → ${size.width}×${size.height} @ ${fps}fps, ${totalFrames} frame (${duration}s)`);

  // ── resume dari checkpoint ───────────────────────────────────────────
  const htmlHash   = sha(fs.readFileSync(htmlPath));
  const expectHash = sha(`${htmlHash}|${size.width}x${size.height}|${fps}|${totalFrames}|${background}`);
  const state      = readState(stateFile);
  let resumeFrom   = 0;
  let skipPhase1   = false;

  if (!CFG.force && state && state.hash === expectHash) {
    if (state.phase === 'frames-done') {
      skipPhase1 = true;
      log(`   ↺ skip phase 1 (frames lengkap)`);
    } else {
      let n = state.completedFrames || 0;
      while (n > 0) {
        const p = path.join(framesDir, `frame_${String(n-1).padStart(5,'0')}.${EXT}`);
        if (fs.existsSync(p)) break;
        n--;
      }
      resumeFrom = n;
      log(`   ↺ resume dari frame ${resumeFrom + 1}/${totalFrames}`);
    }
  } else {
    for (const f of fs.readdirSync(framesDir)) {
      if (f.startsWith('frame_') || f === '.state.json') {
        try { fs.rmSync(path.join(framesDir, f)); } catch {}
      }
    }
  }

  // ── PASS 2: set viewport baru, aktifkan virtual time, RELOAD page yg sama
  if (!skipPhase1) {
    log(`   pass 2: viewport ${size.width}×${size.height} + virtual time`);
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });

    const client = await page.createCDPSession();
    await client.send('Emulation.setVirtualTimePolicy', {
      policy: 'pauseIfNetworkFetchesPending',
      budget: 60_000,
      maxVirtualTimeTaskStarvationCount: 10_000,
    });

    log(`   reload page dgn virtual time`);
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeoutMs });

    log(`   settle 500ms real-time`);
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate((c) => {
      document.documentElement.style.background = c;
      if (document.body) document.body.style.background = c;
    }, background);

    if (resumeFrom > 0) {
      log(`   fast-forward ${resumeFrom} frame`);
      await advanceVirtualTime(client, resumeFrom * frameBudget, 'fast-forward');
    }

    writeState(stateFile, {
      hash: expectHash, htmlHash, width: size.width, height: size.height,
      fps, totalFrames, background, completedFrames: resumeFrom,
      phase: 'frames-in-progress', updatedAt: new Date().toISOString(),
    });

    log(`   render ${totalFrames - resumeFrom} frame...`);
    const shotOpts = { type: CFG.frameFormat, optimizeForSpeed: true, fromSurface: true };
    if (CFG.frameFormat === 'jpeg' || CFG.frameFormat === 'webp') shotOpts.quality = CFG.frameQuality;

    try {
      for (let i = resumeFrom; i < totalFrames; i++) {
        await advanceVirtualTime(client, frameBudget);
        const buf = await page.screenshot(shotOpts);
        fs.writeFileSync(path.join(framesDir, `frame_${String(i).padStart(5,'0')}.${EXT}`), buf);

        if ((i + 1) % 30 === 0 || i === totalFrames - 1) {
          writeState(stateFile, {
            hash: expectHash, htmlHash, width: size.width, height: size.height,
            fps, totalFrames, background, completedFrames: i + 1,
            phase: 'frames-in-progress', updatedAt: new Date().toISOString(),
          });
          const pct = (((i + 1) / totalFrames) * 100).toFixed(1);
          log(`      frame ${i + 1}/${totalFrames} (${pct}%)`);
        }

        if (autoStop && i % 10 === 0 && i > 0) {
          const done = await page.evaluate(() => !!window.__videoDone);
          if (done) { log(`      auto-stop pada frame ${i + 1}`); break; }
        }
      }
    } finally {
      await page.close().catch(() => {});
    }

    const actualFrames = fs.readdirSync(framesDir).filter(f => /^frame_\d+\./.test(f)).length;
    writeState(stateFile, {
      hash: expectHash, htmlHash, width: size.width, height: size.height,
      fps, totalFrames, background, completedFrames: actualFrames,
      phase: 'frames-done', updatedAt: new Date().toISOString(),
    });
    log(`   ✓ phase 1 selesai (${actualFrames} frame)`);
  } else {
    await page.close().catch(() => {});
  }

  // ── PHASE 2: encode ──────────────────────────────────────────────────
  log(`   phase 2: encode → ${path.basename(outputPath)}`);
  await encodeMp4(framesDir, outputPath, fps);

  const stat = fs.statSync(outputPath);
  log(`   ✓ ${baseName}.mp4 (${(stat.size/1024/1024).toFixed(1)} MB) dalam ${((Date.now()-tStart)/1000).toFixed(1)}s`);

  if (!CFG.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });

  return { file: htmlFile, ok: true, outputPath, bytes: stat.size };
}

// ── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const cwd        = process.cwd();
  const videoDir   = path.join(cwd, 'video');
  const framesRoot = path.join(cwd, 'frames');
  const outputDir  = path.join(cwd, 'output');

  if (!fs.existsSync(videoDir)) { console.error('Folder video/ tidak ditemukan.'); process.exit(1); }
  const files = fs.readdirSync(videoDir).filter(f => /\.html?$/i.test(f)).sort();
  if (files.length === 0) { console.error('Tidak ada file .html di video/.'); process.exit(1); }

  fs.mkdirSync(framesRoot, { recursive: true });
  fs.mkdirSync(outputDir,  { recursive: true });

  log(`Menemukan ${files.length} file: ${files.join(', ')}`);
  log(`Config: format=${EXT} q=${CFG.frameQuality} force=${CFG.force} keepFrames=${CFG.keepFrames}`);
  log(`Timeouts: nav=${CFG.navTimeoutMs}ms proto=${CFG.protoTimeoutMs}ms frame=${CFG.frameTimeoutMs}ms`);

  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: CFG.protoTimeoutMs,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--font-render-hinting=none', '--hide-scrollbars', '--mute-audio',
    ],
  });

  const results = [];
  try {
    for (const file of files) {
      if (Date.now() - t0 > CFG.softDeadlineMs) {
        log(`⏸ soft deadline tercapai. Berhenti rapi.`);
        break;
      }
      try {
        results.push(await processVideo(browser, file, videoDir, framesRoot, outputDir));
      } catch (err) {
        log(`   ✗ ${file} gagal: ${err.message}`);
        console.error(err.stack);
        results.push({ file, ok: false, error: String(err) });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const ok  = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);
  log(''); log('═══ RINGKASAN ═══');
  for (const r of results) {
    if (r.ok) log(`  ✓ ${r.file} → ${path.basename(r.outputPath)} (${(r.bytes/1024/1024).toFixed(1)} MB)`);
    else      log(`  ✗ ${r.file} — ${r.error}`);
  }
  log(`Total: ${ok.length} sukses, ${bad.length} gagal, ${elapsed()}s`);

  if (bad.length > 0) process.exit(2);
  process.exit(0);
}

process.on('SIGTERM', () => { log('SIGTERM — keluar rapi.'); process.exit(0); });

main().catch(e => { console.error(e); process.exit(1); });    // Bersihkan sisa lama
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
