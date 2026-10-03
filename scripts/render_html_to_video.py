#!/usr/bin/env python3
"""
Render a single HTML file to MP4 (no audio) using Xvfb + headful Chromium + ffmpeg.
Designed to run inside a GitHub Actions matrix job (one HTML file per job).
Supports long durations (real-time screen capture), 60 fps, 2K (configurable
long-side), aspect ratio auto-detected from the HTML, and an optional
"finished" signal from the page itself.

HTML conventions (all optional):
  <meta name="video:duration" content="30">        target duration in seconds
  <meta name="video:width" content="1920">         explicit base width
  <meta name="video:height" content="1080">        explicit base height
  <meta name="video:fps" content="60">             per-file fps override
  window.VIDEO_READY = true                        set when page is ready to record
  window.VIDEO_FINISHED = true                     set to stop recording early
  window.VIDEO_DURATION = 30                       JS-side duration override
  window.VIDEO_WIDTH / window.VIDEO_HEIGHT         JS-side dimension override

Changelog (fixed edition):
  - `xset` is now OPTIONAL (best-effort screensaver/DPMS disable). A missing
    xset no longer aborts the render — on Xvfb it is not required anyway.
  - ffmpeg liveness is checked ~2 s after launch; if it died on startup (bad
    args, no X display) we fail fast with the log tail instead of burning the
    full duration and only then retrying.
  - Headless dimension probe is wrapped in try/except (falls back to 16:9).
  - Every MP4 is muxed with AXION Neuralis identity metadata (artist/title/
    comment) so output is self-identifying. Cryptographic signing is done by
    scripts/sign_outputs.sh in the package job.
  - Preflight logs tool versions for easier debugging.
"""
from __future__ import annotations
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from shutil import which

REQUIRED_CMDS = ["ffmpeg", "ffprobe", "Xvfb"]  # xset is optional (see below)
PUBLISHER = "AXION Neuralis"


def log(*args) -> None:
    print(*args, flush=True)


def die(msg: str, code: int = 1) -> None:
    log(f"::error::{msg}")
    sys.exit(code)


def have(cmd: str) -> bool:
    return which(cmd) is not None


def preflight() -> None:
    """Log versions of the tools we rely on (helps debug CI differences)."""
    for c, args in [("ffmpeg", ["-version"]), ("Xvfb", ["-help"])]:
        try:
            out = subprocess.check_output([c] + args, stderr=subprocess.STDOUT, timeout=10)
            first = out.decode(errors="ignore").splitlines()[0] if out else "(no output)"
            log(f"preflight: {c} -> {first}")
        except Exception as e:
            log(f"::warning::preflight: could not query {c}: {e}")
    if not have("xset"):
        log("::warning::xset not found; continuing without screensaver/DPMS disable "
            "(harmless on Xvfb). Install x11-xserver-utils to silence this.")


# ---------------------------------------------------------------------------
# HTML introspection
# ---------------------------------------------------------------------------
def parse_meta(path: Path) -> dict:
    """Extract <meta name="video:*" content="..."> values from the HTML."""
    try:
        txt = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    meta: dict = {}
    for tag in re.findall(r"<meta[^>]*>", txt, re.IGNORECASE):
        m_name = re.search(r'name\s*=\s*["\']video:([^"\']+)["\']', tag, re.IGNORECASE)
        m_content = re.search(r'content\s*=\s*["\']([^"\']*)["\']', tag, re.IGNORECASE)
        if m_name and m_content:
            meta[m_name.group(1).strip().lower()] = m_content.group(1).strip()
    return meta


def probe_with_playwright(html_path: Path) -> dict:
    """Headless probe: read window.VIDEO_* vars + layout dimensions.

    Never raises — returns {} on failure so the render can continue with a
    16:9 fallback instead of crashing the whole job.
    """
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        log(f"::warning::playwright import failed ({e}); using fallback dimensions.")
        return {}
    url = html_path.resolve().as_uri()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            )
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.goto(url, wait_until="load")
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            page.wait_for_timeout(800)
            data = page.evaluate(
                """() => ({
                    vw: window.VIDEO_WIDTH ?? null,
                    vh: window.VIDEO_HEIGHT ?? null,
                    vdur: window.VIDEO_DURATION ?? null,
                    scrollW: document.documentElement.scrollWidth,
                    scrollH: document.documentElement.scrollHeight,
                    bodyW: document.body ? document.body.scrollWidth : 0,
                    bodyH: document.body ? document.body.scrollHeight : 0
                })"""
            )
            browser.close()
        return data or {}
    except Exception as e:
        log(f"::warning::dimension probe failed ({e}); using fallback dimensions.")
        return {}


def even(x: float) -> int:
    v = int(round(x))
    return v if v % 2 == 0 else v + 1


def compute_dims(meta: dict, probe: dict, long_side: int):
    """Return final (W, H) with the longer side == long_side, both even."""
    w = meta.get("width") or probe.get("vw")
    h = meta.get("height") or probe.get("vh")
    if w and h:
        w, h = float(w), float(h)
    else:
        w = max(int(probe.get("scrollW") or 0), int(probe.get("bodyW") or 0))
        h = max(int(probe.get("scrollH") or 0), int(probe.get("bodyH") or 0))
        if w < 10 or h < 10:
            log("::warning::Could not measure page layout; falling back to 16:9 aspect ratio.")
            w, h = 16.0, 9.0
    ratio = w / h
    if w >= h:
        W, H = long_side, long_side / ratio
    else:
        H, W = long_side, long_side * ratio
    W, H = even(W), even(H)
    # Clamp absurd sizes (h264 level / memory safety)
    W, H = min(W, 4096), min(H, 4096)
    return even(W), even(H)


def slugify(rel_path: str) -> str:
    s = re.sub(r"[\\/]+", "__", rel_path)
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_.")
    return s or "video"


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def find_free_display() -> int:
    for d in range(99, 200):
        if not Path(f"/tmp/.X{d}-lock").exists():
            return d
    return 99


def ffprobe_duration(path: Path):
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                str(path),
            ],
            stderr=subprocess.STDOUT,
        ).decode().strip()
        return float(out)
    except Exception:
        return None


def tail_of(path: Path, n: int = 30) -> str:
    try:
        lines = path.read_text(errors="ignore").splitlines()
        return "\n".join(lines[-n:])
    except Exception:
        return "(could not read log)"


def render_once(html_path: Path, out_path: Path, W: int, H: int,
                fps: int, duration: float, max_duration: float,
                crf: int, preset: str) -> float:
    disp = find_free_display()
    env = os.environ.copy()
    env["DISPLAY"] = f":{disp}"
    xvfb = subprocess.Popen(
        ["Xvfb", f":{disp}", "-screen", "0", f"{W}x{H}x24",
         "-nolisten", "tcp", "-ac", "-noreset"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    if xvfb.poll() is not None:
        die(f"Xvfb failed to start on display :{disp}")

    pw = browser = context = page = ffmpeg = log_f = None
    try:
        # xset is best-effort (not required on Xvfb).
        if have("xset"):
            subprocess.run(["xset", "s", "off"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["xset", "-dpms"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        browser = pw.chromium.launch(
            headless=False,
            env=env,
            args=[
                "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                "--kiosk", "--window-position=0,0", f"--window-size={W},{H}",
                "--hide-scrollbars", "--disable-infobars",
                "--no-first-run", "--no-default-browser-check",
                "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
                "--autoplay-policy=no-user-gesture-required", "--mute-audio",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
            ],
        )
        context = browser.new_context(viewport=None, device_scale_factor=1)
        page = context.new_page()
        page.goto(html_path.resolve().as_uri(), wait_until="load")

        # Wait for an optional VIDEO_READY signal (max 30s). If the page never
        # defines it, proceed after a short settle so we don't waste time.
        t0 = time.time()
        while time.time() - t0 < 30:
            try:
                ready = page.evaluate("window.VIDEO_READY")
            except Exception:
                ready = None
            if ready is True:
                break
            if ready is None and time.time() - t0 > 2:
                break
            time.sleep(0.25)
        page.wait_for_timeout(400)

        log_path = out_path.with_suffix(".log")
        log_f = open(log_path, "wb")

        repo = os.environ.get("GITHUB_REPOSITORY", "local")
        sha = (os.environ.get("GITHUB_SHA") or "")[:7]
        run_id = os.environ.get("GITHUB_RUN_ID", "")
        comment = (f"Rendered by {PUBLISHER} HTML\u2192MP4 pipeline | "
                   f"repo={repo} commit={sha} run={run_id} | "
                   f"signed output: see .sig sidecar + verify.sh")
        cmd = [
            "ffmpeg", "-y", "-loglevel", "info",
            "-thread_queue_size", "1024",
            "-video_size", f"{W}x{H}",
            "-framerate", str(fps),
            "-f", "x11grab", "-draw_mouse", "0",
            "-i", f":{disp}.0",
            "-an",
            "-vf", f"fps={fps}",
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-threads", "0",
            "-movflags", "+faststart",
            "-metadata", f"artist={PUBLISHER}",
            "-metadata", f"publisher={PUBLISHER}",
            "-metadata", f"title={html_path.name}",
            "-metadata", f"comment={comment}",
            str(out_path),
        ]
        log("ffmpeg:", " ".join(cmd))
        ffmpeg = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=log_f, stderr=subprocess.STDOUT,
        )
        time.sleep(2.0)

        # Fast-fail: if ffmpeg died on startup, surface the log tail now
        # instead of recording silence for the full duration.
        if ffmpeg.poll() is not None:
            log_f.flush()
            log("::error::ffmpeg exited immediately. Last lines of capture log:")
            log(tail_of(log_path, 40))
            die("ffmpeg failed to start capture.")

        rec_start = time.time()
        end_by = rec_start + min(duration, max_duration)
        while time.time() < end_by:
            time.sleep(0.5)
            if ffmpeg.poll() is not None:
                log("::warning::ffmpeg exited mid-capture; stopping early.")
                break
            try:
                if page.evaluate("window.VIDEO_FINISHED === true"):
                    log("Page signaled VIDEO_FINISHED; stopping recording.")
                    break
            except Exception:
                # Page crashed / navigated away: stop early to avoid garbage.
                log("::warning::Lost contact with page; stopping recording.")
                break
        actual = time.time() - rec_start

        # Graceful stop so ffmpeg finalizes the MP4 (moov atom).
        try:
            ffmpeg.send_signal(signal.SIGINT)
            ffmpeg.wait(timeout=25)
        except Exception:
            try:
                ffmpeg.kill()
            except Exception:
                pass
    finally:
        try:
            if context:
                context.close()
        except Exception:
            pass
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        try:
            if pw:
                pw.stop()
        except Exception:
            pass
        if log_f:
            try:
                log_f.close()
            except Exception:
                pass
        xvfb.terminate()
        try:
            xvfb.wait(timeout=5)
        except Exception:
            xvfb.kill()
    return actual


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def load_config(repo_root: Path) -> dict:
    cfg: dict = {}
    for cand in [repo_root / "video" / "config.json",
                 repo_root / "videos" / "config.json",
                 repo_root / "config.json"]:
        if cand.is_file():
            try:
                cfg.update(json.loads(cand.read_text(encoding="utf-8")))
                log(f"Loaded config overrides from {cand}")
            except Exception as e:
                log(f"::warning::Failed to parse {cand}: {e}")
    return cfg


def main() -> None:
    preflight()
    for c in REQUIRED_CMDS:
        if not have(c):
            die(f"Required command not found: {c}")

    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True)
    ap.add_argument("--out-dir", default="rendered")
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--long-side", type=int, default=2560)
    ap.add_argument("--crf", type=int, default=23)
    ap.add_argument("--preset", default="ultrafast")
    ap.add_argument("--default-duration", type=float, default=10.0)
    ap.add_argument("--max-duration", type=float, default=1800.0)
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    html_path = Path(args.html).resolve()
    if not html_path.is_file():
        die(f"HTML file not found: {html_path}")

    cfg = load_config(repo_root)
    fps = int(cfg.get("fps", args.fps))
    long_side = int(cfg.get("long_side", args.long_side))
    crf = int(cfg.get("crf", args.crf))
    preset = str(cfg.get("preset", args.preset))
    default_duration = float(cfg.get("default_duration", args.default_duration))
    max_duration = float(cfg.get("max_duration", args.max_duration))

    meta = parse_meta(html_path)
    if meta.get("fps"):
        try:
            fps = int(float(meta["fps"]))
        except ValueError:
            pass

    log("Probing page dimensions ...")
    probe = probe_with_playwright(html_path)
    W, H = compute_dims(meta, probe, long_side)

    duration = meta.get("duration") or probe.get("vdur")
    if duration:
        try:
            duration = float(duration)
        except ValueError:
            duration = None
    if not duration:
        duration = default_duration
        log(f"::warning::No duration specified for {html_path.name}; "
            f"recording {duration}s. Use <meta name=\"video:duration\" "
            f"content=\"NN\"> or window.VIDEO_DURATION / window.VIDEO_FINISHED.")
    duration = min(duration, max_duration)

    try:
        rel = html_path.relative_to(repo_root)
    except ValueError:
        rel = Path(html_path.name)
    base = slugify(str(rel))
    if base.lower().endswith(".html"):
        base = base[:-5]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{base}.mp4"

    log(f"== Rendering {rel} ==")
    log(f"   output : {out_path}")
    log(f"   size   : {W}x{H} @ {fps}fps")
    log(f"   target : {duration:.1f}s (max {max_duration:.0f}s)")

    actual_duration = None
    ok = False
    for attempt in (1, 2):
        render_once(html_path, out_path, W, H, fps, duration,
                    max_duration, crf, preset)
        d = ffprobe_duration(out_path)
        actual_duration = d
        if d and d > max(1.0, duration * 0.5):
            ok = True
            break
        if attempt == 1:
            log(f"::warning::Attempt {attempt} produced invalid/too-short video "
                f"(ffprobe duration={d}); retrying once.")
            if out_path.exists():
                out_path.unlink()
        else:
            log(f"::error::Render failed after retry. Check {out_path.with_suffix('.log')}")
    if not ok:
        sys.exit(1)

    manifest = {
        "publisher": PUBLISHER,
        "source_html": str(rel).replace(os.sep, "/"),
        "output_file": out_path.name,
        "width": W,
        "height": H,
        "fps": fps,
        "crf": crf,
        "preset": preset,
        "target_duration_s": round(duration, 2),
        "actual_duration_s": round(actual_duration or 0, 2),
        "size_bytes": out_path.stat().st_size,
        "sha256": sha256_of(out_path),
        "encoded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (out_dir / f"{base}.manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    log("MANIFEST " + json.dumps(manifest))


def sha256_of(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


if __name__ == "__main__":
    main()
