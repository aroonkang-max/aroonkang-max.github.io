# Focus Frame Extractor

Static website that finds the in-focus frames of a video and exports them.
Everything runs in the browser; no server-side code.

Files:
- `index.html` – the full page (use this when hosting anywhere)
- `focus-worker.js` – decoding + scoring worker
- `label-font.ttf` – DejaVu Sans Mono (free license, https://dejavu-fonts.github.io/License.html), used to burn frame numbers into exported videos
- `ffmpeg-core.js`, `ffmpeg-core.gz.wasm` – ffmpeg.wasm 0.12.10 core (MIT/LGPL), gzip-compressed (the worker decompresses it)
- `src/` – page source; `cd src && python3 build.py example.b64` regenerates the page (then copy index.html up one level)

Host it publicly with GitHub Pages: push this folder to a repo, then Settings → Pages →
Deploy from branch → `main` / root. Any static host (Netlify, Cloudflare Pages) also works.
Local test: `python3 -m http.server` in this folder, then open http://localhost:8000.

Timeline: scores are smoothed with a moving average; frames whose smoothed score reaches
the threshold form in-focus blocks (short gaps merged, short blocks dropped). Each block
shows its average score, and the subject's average velocity (linear fit of position vs time)
and acceleration (2x the quadratic coefficient) from the tracked centroid of its strongest
edges. Click the chart to identify the frame at that point.

Export: one MP4 clip per in-focus block (ZIP, encoded in a single pass and split at block
starts), a single block's clip from its table row, image ZIPs, or one combined MP4. Clips can
be slowed to 1/2, 1/4 or 1/10 speed. Video exports can burn the original frame number and
timestamp into the top-left corner of every frame (on by default).

Method: grayscale → subtract a median background built from keyframes → Laplacian
(or Sobel) response → score = mean of the strongest 0.05% of responses. Auto threshold
is Otsu's method on log scores. Frames scoring at or above the threshold are exported.
