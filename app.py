import csv
import io
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_UPLOAD_MB", "512")) * 1024 * 1024

MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "600"))
MAX_PIXELS = int(os.getenv("MAX_FRAME_PIXELS", "20000000"))
MAX_CONCURRENT_JOBS = int(os.getenv("MAX_CONCURRENT_JOBS", "2"))
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "7200"))

sessions = {}
jobs = {}
state_lock = threading.Lock()


def parse_rate(value):
    try:
        numerator, denominator = value.split("/", 1)
        denominator = float(denominator)
        return float(numerator) / denominator if denominator else 0.0
    except (AttributeError, ValueError, ZeroDivisionError):
        return 0.0


def ffprobe(path):
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=format_name,duration",
        "-of", "json", str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError("FFmpeg could not read this video. Try another video file.")
    data = json.loads(result.stdout)
    streams = data.get("streams") or []
    if not streams:
        raise ValueError("No video stream was found in this file.")
    stream = streams[0]
    fmt = data.get("format") or {}
    fps = parse_rate(stream.get("avg_frame_rate")) or parse_rate(stream.get("r_frame_rate"))
    try:
        duration = float(stream.get("duration") or fmt.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    try:
        frame_count = int(stream.get("nb_frames"))
    except (TypeError, ValueError):
        frame_count = round(duration * fps) if duration and fps else 0
    width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
    if not width or not height:
        raise ValueError("The video dimensions could not be read.")
    if width * height > MAX_PIXELS:
        raise ValueError(f"This video is too large to process ({width} × {height}).")
    if not fps or fps > 240:
        raise ValueError("The video's frame rate could not be read reliably.")
    if not duration or duration > MAX_DURATION_SECONDS:
        raise ValueError(f"Videos must be shorter than {MAX_DURATION_SECONDS // 60} minutes.")
    return {
        "codec": stream.get("codec_name", "unknown"),
        "format": fmt.get("format_name", "unknown"),
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "frame_count": frame_count,
    }


def prune_expired():
    cutoff = time.time() - SESSION_TTL_SECONDS
    with state_lock:
        expired_tokens = [
            token for token, record in sessions.items()
            if record["created_at"] < cutoff
            and not any(job.get("token") == token and job.get("state") in {"queued", "running"} for job in jobs.values())
        ]
        for token in expired_tokens:
            record = sessions.pop(token, None)
            if record:
                shutil.rmtree(record["workdir"], ignore_errors=True)
        expired_jobs = [job_id for job_id, job in jobs.items() if job.get("created_at", 0) < cutoff]
        for job_id in expired_jobs:
            jobs.pop(job_id, None)


def cleanup_worker():
    while True:
        time.sleep(300)
        prune_expired()


threading.Thread(target=cleanup_worker, daemon=True, name="focusframe-cleanup").start()


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/inspect")
def inspect_video():
    prune_expired()
    upload = request.files.get("video")
    if upload is None or not upload.filename:
        return jsonify(error="Choose a video file first."), 400

    workdir = Path(tempfile.mkdtemp(prefix="focusframe_"))
    video_path = workdir / "upload_video"
    preview_path = workdir / "preview.jpg"
    upload.save(video_path)

    try:
        metadata = ffprobe(video_path)
        preview = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(video_path),
             "-map", "0:v:0", "-frames:v", "1", "-y", str(preview_path)],
            capture_output=True, timeout=60,
        )
        if preview.returncode or not preview_path.exists():
            raise ValueError("FFmpeg could not make a preview frame from this video.")
    except (subprocess.TimeoutExpired, ValueError, json.JSONDecodeError) as error:
        shutil.rmtree(workdir, ignore_errors=True)
        return jsonify(error=str(error)), 400

    token = secrets.token_urlsafe(20)
    with state_lock:
        sessions[token] = {
            "path": str(video_path), "preview": str(preview_path), "workdir": str(workdir),
            "metadata": metadata, "created_at": time.time(),
        }
    return jsonify(token=token, **metadata)


@app.get("/api/preview/<token>")
def preview(token):
    with state_lock:
        record = sessions.get(token)
    if not record or not Path(record["preview"]).exists():
        return jsonify(error="This upload has expired. Upload it again."), 404
    return send_file(record["preview"], mimetype="image/jpeg", max_age=0)


def read_frame(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    if not chunks:
        return None
    if remaining:
        raise RuntimeError("FFmpeg returned a truncated video frame.")
    return b"".join(chunks)


def focus_score(rgb, region):
    height, width = rgb.shape[:2]
    if region:
        x, y, w, h = region
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(width, int(x + w)), min(height, int(y + h))
        crop = rgb[y0:y1, x0:x1]
    else:
        crop = rgb
    if crop.shape[0] < 3 or crop.shape[1] < 3:
        return 0.0

    gray = (0.299 * crop[:, :, 0] + 0.587 * crop[:, :, 1] + 0.114 * crop[:, :, 2]).astype(np.uint8)
    longest = max(gray.shape)
    if longest > 640:
        scale = 640 / longest
        new_size = (max(3, round(gray.shape[1] * scale)), max(3, round(gray.shape[0] * scale)))
        gray = np.asarray(Image.fromarray(gray).resize(new_size, Image.Resampling.BILINEAR))

    center = gray[1:-1, 1:-1].astype(np.int16)
    laplacian = (
        gray[1:-1, :-2].astype(np.int16)
        + gray[1:-1, 2:].astype(np.int16)
        + gray[:-2, 1:-1].astype(np.int16)
        + gray[2:, 1:-1].astype(np.int16)
        - 4 * center
    )
    return float(np.var(laplacian, dtype=np.float64))


def run_job(job_id, token, region, cutoff):
    with state_lock:
        session = sessions.get(token)
        job = jobs.get(job_id)
        if not session or not job:
            return
        job["state"] = "running"

    metadata = session["metadata"]
    workdir = Path(session["workdir"])
    frames_dir = workdir / f"frames_{job_id}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    zip_path = workdir / f"focused_frames_{job_id}.zip"
    frame_size = metadata["width"] * metadata["height"] * 3
    command = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", session["path"],
        "-map", "0:v:0", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]
    rows = []
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        frame_index = 0
        while True:
            raw = read_frame(process.stdout, frame_size)
            if raw is None:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(metadata["height"], metadata["width"], 3)
            score = focus_score(rgb, region)
            if score >= cutoff:
                filename = f"frame_{len(rows) + 1:05d}.jpg"
                output_path = frames_dir / filename
                Image.fromarray(rgb, mode="RGB").save(output_path, format="JPEG", quality=94, optimize=True)
                rows.append((filename, frame_index, frame_index / metadata["fps"], score, output_path))
            frame_index += 1
            if frame_index % 10 == 0:
                expected = metadata["frame_count"] or round(metadata["duration"] * metadata["fps"])
                progress = min(99, int(frame_index * 100 / expected)) if expected else 0
                with state_lock:
                    if job_id in jobs:
                        jobs[job_id].update(frames_seen=frame_index, frames_kept=len(rows), progress=progress)

        return_code = process.wait(timeout=60)
        if return_code != 0:
            raise RuntimeError("FFmpeg could not decode this video.")

        manifest = io.StringIO()
        writer = csv.writer(manifest)
        writer.writerow(["frame_file", "frame_index_zero_based", "time_seconds", "laplacian_variance"])
        for filename, index, timestamp, score, _ in rows:
            writer.writerow([filename, index, f"{timestamp:.6f}", f"{score:.3f}"])
        (workdir / f"manifest_{job_id}.csv").write_text(manifest.getvalue(), encoding="utf-8")

        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED) as archive:
            for filename, _, _, _, path in rows:
                archive.write(path, arcname=f"frames/{filename}")
            archive.write(workdir / f"manifest_{job_id}.csv", arcname="manifest.csv")

        with state_lock:
            if job_id in jobs:
                jobs[job_id].update(
                    state="done", progress=100, frames_seen=frame_index,
                    frames_kept=len(rows), zip_path=str(zip_path),
                )
    except Exception as error:
        if process and process.poll() is None:
            process.kill()
            process.wait()
        with state_lock:
            if job_id in jobs:
                jobs[job_id].update(state="error", error=str(error))
    finally:
        if process and process.stdout:
            process.stdout.close()


@app.post("/api/process")
def process_video():
    body = request.get_json(silent=True) or {}
    token = body.get("token")
    try:
        cutoff = float(body.get("cutoff", 100))
    except (TypeError, ValueError):
        return jsonify(error="Focus cutoff must be a number."), 400
    if not 0 <= cutoff <= 100000:
        return jsonify(error="Focus cutoff is outside the allowed range."), 400

    with state_lock:
        session = sessions.get(token)
        if not session:
            return jsonify(error="Upload the video again before processing."), 404
        active = sum(job.get("state") in {"queued", "running"} for job in jobs.values())
        if active >= MAX_CONCURRENT_JOBS:
            return jsonify(error="The processor is busy. Try again in a minute."), 429
        metadata = session["metadata"]
        raw_region = body.get("region")
        region = None
        if raw_region:
            try:
                x, y = float(raw_region["x"]), float(raw_region["y"])
                w, h = float(raw_region["w"]), float(raw_region["h"])
                if x < 0 or y < 0 or w < 3 or h < 3 or x + w > metadata["width"] or y + h > metadata["height"]:
                    raise ValueError
                region = (x, y, w, h)
            except (KeyError, TypeError, ValueError):
                return jsonify(error="The selected subject region is invalid. Draw it again."), 400

        job_id = secrets.token_urlsafe(16)
        jobs[job_id] = {
            "token": token, "state": "queued", "progress": 0, "frames_seen": 0,
            "frames_kept": 0, "created_at": time.time(), "error": None,
        }

    threading.Thread(target=run_job, args=(job_id, token, region, cutoff), daemon=True).start()
    return jsonify(job_id=job_id), 202


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    with state_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify(error="This processing job has expired."), 404
        result = {key: job.get(key) for key in ("state", "progress", "frames_seen", "frames_kept", "error")}
    return jsonify(result)


@app.get("/api/jobs/<job_id>/download")
def download(job_id):
    with state_lock:
        job = jobs.get(job_id)
        if not job or job.get("state") != "done" or not Path(job.get("zip_path", "")).exists():
            return jsonify(error="The ZIP is not ready."), 404
        zip_path = job["zip_path"]
    return send_file(zip_path, mimetype="application/zip", as_attachment=True, download_name="focused_frames.zip")


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error=f"Upload is too large. Maximum size is {app.config['MAX_CONTENT_LENGTH'] // (1024 * 1024)} MB."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=False)
