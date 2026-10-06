# Qwen-Image-2.1 integration (research, 2026-10-06)

Scope: how the workbench (`generators/qwen.mjs`, SPEC_v5 §2 live proposals and §3 character studio) talks to the
Qwen-Image-2.1 studio in `local-gen/qwen-image21/`, whether Dani's laptop can run it, what the alternatives cost, and
what is safe to expose. Nothing was installed or downloaded for this note.

Paths below are relative to `local-gen/qwen-image21/`. `app.py` = `web/app.py`, `index.html` = `web/index.html`,
`engine.py` = `web/engine.py`.

---

## 1. Verdict

| question | answer |
|---|---|
| Can the **studio as shipped** (`web/app.py`) run on Dani's laptop? | **No.** It needs about 31 GB of disk (17.5 GB bf16 text encoder in the HF cache, an 8.7 GB fp8 encoder cache, 4.2 GB for Q4 GGUF, the VAE and LoRAs), and C: has 23.6 GB free. It also keeps about 8.7 GB of encoder in RAM; the laptop has 15.7 GB with 3.1 GB free right now. The default NVFP4 variants need Blackwell (sm_120), and the 4070 Laptop is sm_89. |
| Can Qwen-Image-2.1 run on the laptop **at all**? | **Barely, and not live.** The route is a Q4 GGUF stack in ComfyUI or stable-diffusion.cpp, outside the studio: Q4_K_M DiT 4.20 GB + Q4_K_M encoder 5.03 GB + VAE 0.68 GB = 9.9 GB of disk. The encoder sits in RAM, so the browser and other apps have to be closed. My estimate: about 20–40 s per 1024² text-to-image at 6 turbo steps, and 1–5 min per edit with references. None of the studio tools, drafts or API come with it. This is fine for an offline batch and useless for "live". |
| Recommended | **Rent an RTX 5090 by the hour (RunPod Secure Cloud, $0.99/h, plus a 60 GB network volume at about $4.20/month), run the studio unchanged except for a 3-line Linux patch, and reach it through an SSH tunnel on `127.0.0.1:7860`.** A 2-hour session with 60 proposals costs about **$2.25 of GPU time**. The fallback with no pod running is fal `qwen-image-edit-2511`, which the workbench already reaches through `fal.mjs`: $0.03/MP, so about $1.80 per 60 images. That is a different and older model, with none of the studio's tools. |

Hardware measured on 2026-10-06:
- `nvidia-smi`: RTX 4070 Laptop GPU, 8188 MiB, compute capability 8.9, driver 610.78, 1.1 GB already in use by the desktop.
- RAM: 15.7 GB, 3.1 GB free.
- Pagefile: 17.8 GB.
- Drives: C: 23.6 GB free of 465 GB. D: is the 0.3 GB EFI partition. E: is "DriverCD", 2.2 GB free of 10 GB.
- No other drive has room.

---

## 2. The studio's HTTP API (web/app.py)

FastAPI with one GPU worker thread. Every generation goes through one endpoint, `POST /api/generate`. The tools (pose,
outfit, relight, boxes, turn and so on) are not separate endpoints: **`index.html` builds a prompt, a set of reference
images and a LoRA list, then calls `/api/generate`.** So `qwen.mjs` has to rebuild those recipes itself (§3).

### 2.1 Endpoints

| endpoint | request | response | file:line |
|---|---|---|---|
| `GET /api/status` | – | `{model: {state: unloaded\|loading\|loaded\|standby\|unloading\|error, variant, error, load_seconds, started, expected_s, options: {recommended_steps, compile, …}, stage, variants: [...], default_variant}, rewriter: {state, error}, gpu: {used_gb, total_gb, peak_gb}, queued, users: [...], locked}` | app.py:349-365, engine.py:1126 |
| `POST /api/model/load` | `{variant, compile=false, vae_tiling=null, te_resident=false, attention="native"\|"sage"}` | `{ok: true}`, asynchronous: poll `/api/status` until `state == "loaded"`. 400 for an unknown variant, 409 if other users are connected and the variant would change. | app.py:317-323, 375-382 |
| `POST /api/model/unload` | – | `{ok}` (409 when shared) | app.py:385-389 |
| `POST /api/generate` | `GenerateRequest` (below) | the whole `Job` as JSON (`id`, `status: "queued"`, …). 409 "load a model first" unless the state is loaded, loading or standby. 400 for more than 10 images, a bad image, or an unknown LoRA or a scale outside ±2. | app.py:325-341, 601-627 |
| `GET /api/jobs` | – | **every job of the caller**, newest first, each with `queue_pos`. There is **no `GET /api/jobs/{id}`**: poll this list and filter by id. | app.py:630-635 |
| `GET /api/jobs/{id}/preview` | – | the latest live-preview JPEG (TAE decode, 512 px, one per step); 404 when there is none yet. Cache-bust it with `?n=<preview_n>`. | app.py:694-699, engine.py:975-981 |
| `POST /api/jobs/{id}/finish` | – | finishes a **draft** from its saved latents; the Job is queued again. 409 if it is not a draft, or if a different variant is loaded. | app.py:702-715 |
| `POST /api/jobs/{id}/hide` | `{hidden: bool}` | `{hidden}`: the "xN pick" (unpicked options are hidden, not deleted) | app.py:722-728 |
| `DELETE /api/jobs/{id}` | – | `{deleted}`; also removes a queued job from the queue and deletes its PNGs | app.py:677-688 |
| `GET /api/queue` | – | `{total, ahead_of_mine}` (everyone's jobs, counts only) | app.py:638-644 |
| `GET /api/stats` | – | timing rows per (variant, steps, size): `median_s`, `step_s`, `decode_s` | app.py:647-674 |
| `GET /api/loras` | – | the catalog (`loras.json` + `models/loras/custom.json`) with `ready` (file already downloaded) | app.py:496-498 |
| `POST /api/loras` | `{ref: "owner/repo[/file]" or an HF URL, name, scale, trigger}` | the new catalog entry; downloads up to 2 GB from the Hub | app.py:524-568 |
| `GET /api/loras/search?q=` | – | Hub adapters of Qwen-Image-2.1 | app.py:571-583 |
| `POST /api/enhance` | `{prompt}` | `{prompt}` rewritten by the Pocket-0.8B enhancer (needs llama-server; 503 otherwise) | app.py:419-427 |
| `POST /api/jobs/{id}/share`, `/fork`, `GET /api/shared` | – | public gallery; the workbench does not need these | app.py:735-785 |
| `GET /output/{id}.png`, `/output/{id}_ref{i}.png` | – | the PNG (RGBA when transparent); owner-checked | app.py:788-801 |
| `POST /api/shutdown` | – | kills the process (serve.sh restarts it). **No authentication at all.** | app.py:392-398 |

**`GenerateRequest`** (app.py:325-341):
```json
{ "prompt": "…", "images": ["data:image/png;base64,…"],
  "loras": [{"id": "outfit", "scale": 1.0}],
  "width": null, "height": null, "output_resolution": 1024,
  "steps": 30, "seed": 42,
  "negative_prompt": "", "true_cfg_scale": 1.0,
  "transparent": false, "fast_decode": false,
  "stop_after": null, "ref_strengths": null,
  "parent": null, "tool": "pose" }
```
- `images`: up to 10 data URLs, each decoded as RGBA. Any image makes the call an edit. With `width`/`height` null, the
  output follows the aspect of the last reference (engine.py:875-877). The UI caps edits at about 1 MP, in multiples
  of 32 (`editSize`, index.html:953-957). A Pose run on a 2048×1376 upscale paged memory for more than 40 minutes
  (triage U5).
- **`steps` defaults to 30.** The turbo variants want 6 (`nvfp4m-turbo2`) or 4 (`-turbo`). Read
  `status.model.options.recommended_steps` and always send it.
- `stop_after: k` (k < steps) makes a **draft**: the job stops after step k and stores the full-VAE decode of the
  model's clean-image guess. `POST /finish` then runs the rest, and the result is bit-exact against one continuous run
  (triage V2).
- `fast_decode: true` does the final decode with the tiny autoencoder (about 5 ms instead of 0.4–1 s), slightly softer.
- `ref_strengths`: one value per reference in [0, 2]. Values other than 1 cost about 12% per step and trigger a
  one-time recompile of about 5 minutes (C14).
- `parent`: one of your own job ids, so the studio's version tree links them. It is optional for the workbench, which
  keeps its own tree.
- `tool`: a tag matching `^[a-z0-9_-]{1,24}$`.

**`Job`** (app.py:42-79), the fields the workbench reads:
- `id` (8 hex characters);
- `status`: queued, generating, done or error;
- `progress` (0–1), `preview_n`, `error`;
- `image_url`: relative, `/output/<id>.png?s=<steps>`;
- `result_size` (`"1024×1024"`, with a Unicode ×);
- `seed` (changed by the empty-alpha retry, app.py:171-187);
- `timings`: `total_s`, `step_s`, `decode_s`;
- `draft_steps`: non-null means the image shown is a draft;
- `queue_pos` (in `/api/jobs` only).

### 2.2 Queue and concurrency
- One worker owns the GPU. Load, unload and standby go first; generations follow, **round-robin per owner**
  (the least recently served owner goes next), so two users' batches alternate image by image (app.py:214-251).
- There is **no `num_images`**. Three or four proposals means three or four POSTs with seeds `base+k`, which is what
  the UI does (index.html:1081-1093). They render **one after another**.
- Standby: after `QWEN_STANDBY_S` seconds (default 600) with no requests, the transformer is parked in RAM. The next
  image costs about 1–3 s more. **Any** request, including `/api/status`, counts as activity (app.py:256-313).
- A CUDA OOM makes the process exit with code 3 on purpose. serve.sh restarts it **with no model loaded**, so the
  client has to load it again (app.py:205-209, `serve.sh`).

### 2.3 Auth (X-User)
- Owner = the `X-User` header, case-folded. **With no header, the owner is `QWEN_LOCAL_OWNER`** (default
  `you@example.com`) (app.py:86, 401-405).
- The header is trusted blindly. It is safe only because the original deployment had a Caddy gate strip it from
  browsers, and the app **binds to 127.0.0.1** (app.py:816, hard-coded; `PORT` only changes the port).
- Jobs, previews, `/output` and `/finish` are owner-scoped: a different owner gets 404 (app.py:408-412). **`qwen.mjs`
  must send the same identity on every call**, including the image download. The simplest choice is no header at all.

### 2.4 Things that block or shape remote use
1. **It binds to 127.0.0.1 only** (app.py:816). That is good, and the reason to reach it through an SSH or Tailscale
   tunnel rather than editing the code.
2. **No CORS middleware.** Browser `fetch` from the workbench page to `:7860` fails. All calls must go through the
   workbench's Node side (`qwen.mjs`, or a small proxy route in serve.mjs), which is where generators run anyway.
3. **Windows-only subprocess flag.** engine.py:58, 87 and 129 and rewriter.py:49 pass `creationflags=0x08000000` to
   `subprocess.run`. Python raises `ValueError` for that on Linux. engine.py:129 (`gpu_used_gb`) has no `try`, so
   **`check_gpu_free` makes every model load fail on a Linux pod.**
   - Patch: `creationflags=0x08000000 if os.name == "nt" else 0`, in 4 places.
   - `own_children_gpu_gb` calls `powershell`, but it is wrapped in `try`.
   - `rewriter.py:17` hard-codes `E:/llamacpp/llama-server.exe`. The enhancer then reports an error and nothing else
     breaks.
4. **Import-time network access.** `TRANSFORMER_LINEARS = _transformer_linears()` (app.py:598) downloads the
   transformer config from the Hub at startup, so the server needs HF access, or a warm HF cache, to start.
5. `/api/shutdown`, `POST /api/loras` (disk-filling downloads) and `/api/model/unload` have no authentication.
   Anyone who can reach the port can use them.

---

## 3. Recipes: workbench action → `/api/generate` body

All of these come from `index.html`. "Image 1" means `images[0]`.

| workbench action | prompt (verbatim template) | images | loras / size | source |
|---|---|---|---|---|
| **Text-to-image proposal** | the director's text, which may expand `{pred}` values | none | user LoRAs (style chips) | index.html:663-681 |
| **Whole-image edit** | `<text> Keep everything else exactly the same.` | [current] | user LoRAs | index.html:1061, 1069-1070 |
| **Multi-image edit / combine refs** | free text that refers to `<image1>`, `<image2>`… or "image 1/2" | up to 10, first = main subject; keep it to 2 or 3 (3 refs page VRAM even on 16 GB: C15, 326-519 s) | `ref_strengths` optional | app.py:331, triage C14/C15 |
| **Box / mask edit** (no mask field: the marks are drawn into the image) | `Edit the image: <t1> inside the red box; <t2> inside the green box…. Do not draw the boxes or any colored outlines in the result. Keep everything else exactly the same.` | [current with boxes burned in, colours red #ff0000, green #00ff00, blue #0000ff, yellow #ffff00 in order] | none | index.html:915, 1056-1068 |
| **Add object** | `Add <what> inside the red box, filling the box naturally with lighting, shadows and perspective that match the scene. Do not draw the box or any outline in the result. Keep everything else exactly the same.` | [burned red box] | `[]`, N options | index.html:1912-1919 |
| **Remove** | trigger of `remover` (`Remove the red highlighted object from the scene`) | [burned red box] | `remover` 1.0 | index.html:1921-1924 |
| **Draw-then-edit (doodle)** | `<doodle> Turn the magenta scribble into <what>` | [image with magenta strokes burned in] | user LoRAs (`doodle` optional) | index.html:560, 1067 |
| **Move** | `MOVE_PROMPT` (red box = from, green box = to) | [burned boxes] | – | index.html:557, 1066 |
| **Extend / outpaint** | `Extend the scene naturally into the gray areas, matching lighting and perspective.` | [canvas padded with #808080, ≤1 MP] | `outpaint`; width/height = canvas | index.html:1925-1934 |
| **Outfit** | `Dress the person in image 1 in the <what> shown in image 2. Keep their face, hair, hands, pose and the background exactly the same.` | [person, garment photo] | `outfit` 1.0 | index.html:1935-1939 |
| **Relight** (grounds a pasted object: light, highlights, contact shadow) | the `relight` trigger (`pengyu Apply consistent lighting…`) | [current] | `relight` 1.0 | index.html:1158, 1173, 1295; loras.json |
| **Pose** | 1 person, keep identity: `Use <image2> as the identity, clothing and style reference. Recreate the same subject in the body pose and framing shown by <image1>.\nThe subject is <phrase>.` No identity: `Generate an image of the subject described in the text, following the body pose and framing in <image1>.\nThe subject is <phrase>.` For 2 people, see the source. | **image 1 = a rendered OpenPose stick figure PNG** at the output size (18 COCO keypoints, limbs `POSE_LIMBS` coloured `POSE_COLS`, black background); image 2 = identity (current image) | `loras: []`; size = current image capped at 1 MP | index.html:1351-1356, 1710-1718, 1790, 1944-1966 |
| **Rotate / turn (object)** | `<orbit> rotate the camera <45\|90\|135\|180> degrees to the <right\|left>, <eye level\|low angle\|elevated>. The image has alpha channel and the background is transparent.` | [current, **must be RGBA**] | `orbit` 1.0, `transparent: true`, 768×768 | index.html:1161, 1315-1319, 1940-1943 |
| **Make RGBA first** (cutout) | `Keep the main subject exactly as it is and remove the background completely.` | [current] | `transparent: true` | index.html:2010 |
| **Character sheet** (front, side and back views in one image) | `Create a character design sheet of this character: front, side and back views in full body, plus three facial expressions, on a plain light background. Keep the design, outfit and colors exactly the same.` | [current] | 1536×1024, no LoRA | index.html:2009 |
| **Upscale / refine** | `Recreate this image at high resolution…` | [current] | width/height ×2, max 2048 | index.html:2004-2007 |

**Pose input.** The studio takes **an image, not skeleton JSON**. The skeleton is rendered client-side from the 3D pose
editor and sent as reference 1. `qwen.mjs`, or the workbench page, has to rasterise its own skeleton the same way:
- OpenPose-18 order (0 nose, 1 neck, 2–4 right arm, 5–7 left arm, 8–10 right leg, 11–13 left leg, 14–17 eyes and ears);
- limb colours as in `POSE_COLS`;
- on black, at the output size.

A grey-mannequin render is worse: the subject copies the grey, and jumping poses lose their air (P2). Results from
C15/C21:
- PCK@0.2 is 0.98 with the skeleton alone and 0.97 with skeleton + identity, against 0.41 with text only;
- about 11 s per pose edit on a 5080;
- kneeling comes out as a half crouch, and hand-on-hip is weak (no hand keypoints).

**Which LoRAs rotate.** In `web/loras.json`:
- `orbit` (ML-Intern-lab viewpoint-orbit) is the only verified one. It needs a transparent object at 768², and comes
  out "toe-on" at 90°; the base model mirrors instead (LPIPS 0.358, triage L8 and "orbit").
- `anyangle` (lilylilith AnyAngle) needs a rough 3D render at the target angle as image 1. It has not been auto-tested.
- For a **person**, the practical "rotation" tools are:
  - the **Pose** tool with a camera yaw in the skeleton (the 3D editor projects it);
  - the **character sheet** preset (front, side and back views at once);
  - "orbit" on an RGBA cutout of the character.
- There is no multi-angle-of-a-person LoRA for 2.1 in the catalog. 2509/2511 multi-angle LoRAs were rejected because
  there is no evidence they load on 2.1 (triage "L-").

**3–4 proposals.** Send N POSTs with `seed = base + k`. If the director picks one, optionally hide the rest
(`/hide`, as `pickOption` does at index.html:1118-1122).

---

## 4. Speed facts (output/research/triage.md, RTX 5080 16 GB, `nvfp4m-turbo2`)

| what | measured |
|---|---|
| denoise step | about 0.40 s per step at 1024² (S1). The UI advertises "Turbo · 6 steps · ~3 s" for text-to-image (index.html:295). |
| tool edits (1 ref, 768–1024) | 8–18 s per tool (V1); pose about 11 s (C21); plate extract about 8 s (L16) |
| 2-image 1024 edit | 9.8 s on a clean card. With other processes on the GPU: median 12.8 s and 23.4 s with the host K/V cache (S9). Paging: 210–530 s. |
| first edit after a load | 93 s (compile). The first biased-`ref_strengths` image costs about 5 min more (C14). |
| model load | first 3–6 min (quantise + compile + cache), then 2–3 min (SETUP.md). Waking from standby: about 1–3 s. |
| live preview | tiny-AE decode about 5 ms, 512 px, one frame per step (engine.py:975-981) |
| draft | `stop_after=2` of 6, then `/finish`: exact (V2) |
| rejected speedups | TeaCache / cache-dit (6 steps leave nothing to cache), Nunchaku, TensorRT and others (S-) |
| 4-step candidates | S4 (PDD student, weak on edits) and L17 (MFD), both WATCH |

**What "live" can realistically mean** on a 5080 or 5090:
- About 1–2 s after a debounced change, the first preview frames appear at `preview_n` 1–2.
- Text-to-image: the first full proposal arrives after about 3–4 s, and 4 proposals after about 12–16 s, run serially.
- Character edits: one result in about 10–15 s, and 4 proposals in about 40–60 s.
- To feel live, send **one draft-quality proposal first**: 768², `stop_after: 2` or `fast_decode: true`, and watch
  `/preview`. Queue the other 2–3 after it, and **delete queued stale jobs** when the director keeps typing
  (`DELETE /api/jobs/{id}` also removes them from the queue).

On an RTX 4090 (Ada, no FP4) the `fp8dq-turbo2` variant would be the one to use. It has no measurements in this repo.
Expect it to be roughly 1.5–2× slower than NVFP4 (estimate).

---

## 5. Feasibility on Dani's laptop (RTX 4070 Laptop 8 GB, 15.7 GB RAM, 23.6 GB free)

### GGUF files: `leejet/Qwen-Image-2.1-GGUF`
Transformer only. 7B parameters, 32 blocks. Fetched 2026-10-06.

| quant | file | fits 8 GB next to activations + VAE? |
|---|---|---|
| Q2_K | 2.56 GB | yes; poor quality expected |
| Q3_K | 3.27 GB | yes |
| Q4_0 / Q4_K | 4.20 GB | yes, the sweet spot |
| Q5_0 | 5.07 GB | tight; edits will page |
| Q6_K | 6.00 GB | no room for edit prefix caches |
| Q8_0 | 7.69 GB | no |

The model card gives no VRAM, RAM or speed notes. It recommends stable-diffusion.cpp or the leejet ComfyUI-GGUF node.
The text encoder is separate: Qwen3-VL-8B, 17.5 GB in bf16. A Q4_K_M encoder GGUF is 5.03 GB, so the
**Q4 stack is 9.91 GB** (openclawdc.com, 2026-09-23). Unsloth says Q4_K_M "runs on 11 GB VRAM". The smallest
published run is an RTX 3050 6 GB with Q4_0 and `--offload-to-cpu`: about **4 min 50 s per image** at 1184², 25 steps.
No 8 GB measurement has been published.

### Running the studio itself
| path | disk | RAM | VRAM | result |
|---|---|---|---|---|
| studio `gguf-Q4_0` (diffusers GGUFLinear, engine.py:185-226) | HF snapshot of the text encoder (17.5 GB) + fp8 encoder cache (8.7 GB) + GGUF 4.2 + VAE + transformer config ≈ **31 GB** | encoder in RAM, peak about 8.7 GB (engine.py:448-451) | 4.2 GB + activations + VAE + about 4 GB of prefix K/V for edits | **does not fit on disk (23.6 GB free) and nearly fills RAM.** `check_gpu_free` refuses to load if more than 7 GB is in use (engine.py:46). |
| studio `nvfp4*` | – | – | – | **impossible**: FP4 kernels need Blackwell (sm_120); this GPU is sm_89 |
| studio `fp8dq-turbo2` | same 31 GB+ | same | 7.3 GB transformer | does not fit in 8 GB |

### Outside the studio
ComfyUI ≥ 0.37 or sd.cpp, with Q4_K_M DiT + Q4_K_M encoder + VAE (9.9 GB on disk) + the Viggle turbo LoRA (0.68 GB):
- **Disk:** fits, about 11 GB.
- **RAM:** the 5 GB encoder on the CPU side, with 3.1 GB free now. Close the browser and other apps first, or Windows
  pages to the 17.8 GB pagefile.
- **Speed (estimate, unmeasured):** the 4070 Laptop is roughly 2–3× a 3050 Laptop and keeps the Q4 DiT resident, so:
  - text-to-image 1024² at 6 turbo steps: about **20–40 s**; 768² drafts about 10–20 s;
  - prompt encode: several seconds for each new prompt;
  - 1-reference edits at 768²: **about 1–2 min**;
  - 2+ references: several minutes, because of paging.
- **Quality:** Q4 GGUF is a visible step down from the studio's NVFP4m with turbo (the studio measured quantisation
  quality with `quality.py`, but its numbers are not in the package). The turbo LoRA runs on GGUF as a runtime patch.
- **Lost:** every studio feature (API, drafts, previews, tool recipes, prefix-cache tiers). Using it would mean writing
  a ComfyUI workflow and a ComfyUI generator (the `comfyui.mjs` stub, D9).

**Bottom line.** The studio cannot run on this laptop. The smallest setup that runs at all is the ComfyUI Q4 stack
above: about 11 GB of disk, an offline batch generator at roughly 0.5–2 images per minute. It does not meet SPEC_v5's
"live" goal, and it is only worth trying if Dani wants $0 batch proposals overnight. **Recommendation: do not set it up
for the workbench.**

---

## 6. Options and cost: "60 proposals in a 2-hour session"

Assumptions: GPU time is booked for 2 h plus 15 min of pod start and model load, so 2.25 h. 60 proposals are about
3–12 min of real GPU work on a 5090, so the rest is idle time you pay for. Prices were fetched 2026-10-06 unless a row
says otherwise.

| option | runs the studio? | unit price | cost per session | notes / source |
|---|---|---|---|---|
| Laptop, ComfyUI Q4 | no | $0 | **$0** | not live: about 30–60 min of GPU time for 60 images at 1024 (estimate) |
| **RunPod RTX 5090, Secure Cloud** | **yes (Blackwell, NVFP4)** | **$0.99/h**, plus a network volume of $0.07/GB/month (60 GB ≈ $4.20/month) | **≈ $2.23** + storage | network volumes are Secure Cloud only. runpod.io/pricing, docs.runpod.io/storage |
| RunPod RTX 5090, Community Cloud | yes | $0.69/h; pod volume $0.10/GB/month running, $0.20 stopped (60 GB stopped ≈ $12/month), and the same host's GPU may not be free when you restart | ≈ $1.55 + storage | runpod.io/pricing |
| RunPod RTX 4090, Community | yes, `fp8dq-turbo2` only (Ada) | $0.34/h | ≈ $0.77 | slower, and the fp8dq path is untested here |
| Vast.ai RTX 5090 | yes | from $0.34/h, median ≈ $0.63/h (marketplace, changes every 5 min) | ≈ $0.80–1.42 + disk | computeprices.com / deploybase.ai, 2026-08/09; host quality varies |
| Vast.ai RTX 4090 | fp8dq only | from $0.31/h, median ≈ $0.39/h | ≈ $0.70–0.90 | same |
| Modal L40S (no consumer Blackwell) | yes, fp8dq only, after containerising | $0.000542/s ≈ $1.95/h | ≈ $4.39; the $30/month Starter credit covers about 6 sessions | modal.com/pricing. Serverless cold start = 35 GB of weights + a 2–6 min load, so keep one container warm for the session. |
| RunPod serverless 5090 | yes, after containerising | $1.58/h of active time | cheap per image, but every cold start pays the load | poor fit for "live" |
| **fal `qwen-image-edit-2511`** (Qwen-Image-Edit, **not 2.1**) | no (none of the studio tools) | $0.03/MP; `num_images` 1–4; multiple `image_urls` | **≈ $1.80** at 1 MP | fal.ai llms.txt. Latency is not published; expect a queue plus about 5–20 s (unverified). |
| fal `qwen-image-edit-2511-multiple-angles` | no | $0.035/MP; azimuth, elevation and zoom parameters (96 camera poses) | ≈ $2.10 | the closest hosted equivalent of "rotate via LoRA" |
| fal `qwen-image-2/pro/edit` | no | $0.075/image, 1–3 refs, up to 6 outputs | ≈ $4.50 | fal.ai llms.txt |
| fal `qwen-image-2.1` | – | the page says "$0 per compute second", status "(Unknown)", text-to-image only | – | looks like a placeholder; apimaster.ai (2026-09-23): "no official Qwen-Image-2.1 API". Do not rely on it. |
| Alibaba Model Studio `qwen-image-3.0` | no | $0.03/image | ≈ $1.80 | commercial API (eesel.ai); a different model |

Tunnel tools (not re-verified today): an SSH tunnel to the pod costs $0; Tailscale's Personal plan and Cloudflare
Tunnel are free.

---

## 7. Recommended path

1. **Now:** build `qwen.mjs` against the API in §2–3. Test it with a mock server, the way `tools/mock-fal.mjs` tests fal.
   When no qwen server is reachable, the workbench routes the request to fal `qwen-image-edit-2511` through the normal
   approval Queue, as SPEC_v5 §3 already says.
2. **When Dani says go:** rent a **RunPod Secure Cloud RTX 5090** (≥ 32 GB RAM, ≥ 60 GB network volume, Linux,
   PyTorch cu128 image).
   - Copy `local-gen/qwen-image21/` (65 MB) to it and apply the `creationflags` patch (§2.4-3).
   - Run `fetch_models.py` with `HF_HOME` on the volume, once (35 GB).
   - Start it with `QWEN_IMAGE_AUTOLOAD=nvfp4m-turbo2 bash serve.sh`.
   - On the laptop: `ssh -N -L 7860:127.0.0.1:7860 root@<pod> -p <port>`. The workbench keeps
     `qwen_base = http://127.0.0.1:7860`.
   - Session cost ≈ $2.25, plus about $4.20/month of storage. Terminate or stop the pod after the session. The volume
     keeps the weights and the 14 GB of quantised caches, so the next load takes 2–3 min, not 10+.
3. The "nothing paid without approval" rule: starting a pod is the paid act. Treat **a session** as one approved
   request with a cap (hours × $/h). The individual proposals cost $0 on top of it. Fal fallbacks stay per-request and
   approved.

---

## 8. What `generators/qwen.mjs` must implement

The contract is the same as `fal.mjs` and `comfyui.mjs` (`lib/run.mjs`): `id`, `label`, `kinds`, `configured`,
`supports`, `estimate`, `submit`, `poll`, `fetch`. The live path also needs the extras listed under "Live".

- **Config:** `qwen_base` in `workbench.config.json`, default `http://127.0.0.1:7860`. Accept only `http:` or
  `https:`. An optional fixed `qwen_user` is sent as `X-User` on **every** call or on none. Never send the fal key, or
  any other secret, to this origin.
- **`configured()`:** `GET /api/status` with a timeout of about 2 s. It returns `ok` plus the model state, variant,
  `recommended_steps` and GPU numbers. It is not configured when the server is unreachable.
- **Ensure loaded:**
  - `unloaded` or `error`: `POST /api/model/load {variant: default_variant}`, then poll `/api/status` every 2 s up to
    about 8 min (show `stage` and `started`/`expected_s`).
  - `standby` is fine: `/generate` wakes it.
  - After a 409 "load a model first", or a job error containing "GPU context lost", wait for the restart and load again.
- **`estimate()`:** $0 per image (the pod's hourly cost is approved per session, §7).
- **`submit(req)`:**
  - Map `req.tool` (edit, boxes, add, remove, doodle, outpaint, outfit, relight, pose, orbit, cutout, sheet, upscale,
    t2i) to the recipes in §3.
  - Read every local ref and send it as a data URL. Downscale so that width × height ≤ 1 MP, in multiples of 32, as
    `editSize` does. Send at most 10 refs; warn above 2.
  - Burn boxes, doodles and the pose skeleton into PNGs **on the workbench side**.
  - Use `steps = recommended_steps` (never the server default of 30).
  - For proposals: N = 1–4 POSTs with `seed = base + k`.
  - Return the handle `{base, ids: [...]}`, with no secrets in it.
- **`poll(handle)`:** `GET /api/jobs`, filtered to `handle.ids`. Map queued (with `queue_pos`), generating (with
  `progress`), done (when all are done) and error (keep `job.error`). A job that is missing means it was deleted or
  the owner was wrong: treat it as failed.
- **`fetch(handle)`:** for each job, `[{url: base + image_url, ext: "png"}]`. Image URLs are relative and
  **owner-scoped**, so the runner's download must carry the same `X-User` (or none). Keep `seed`, `timings` and
  `draft_steps` in job.json.
- **Live (SPEC_v5 §2–3), outside the approval queue:**
  - `preview(jobId, n)` proxies `GET /api/jobs/{id}/preview?n=` to the page. The page cannot call `:7860` itself:
    there is no CORS, and the server binds to localhost.
  - `cancel(ids)` uses `DELETE /api/jobs/{id}` for proposals that are still queued when the note changes again.
  - `finish(id)` uses `POST /api/jobs/{id}/finish` for a picked draft.
  - `pick(id, others)`: optional `/hide`.
  - Debounce about 1 s. Allow at most one live batch in flight per line or character.
- **Errors:** pass `detail` from 4xx bodies through unchanged. Count OOM restarts and stop auto-retrying after 2.
- **Tests:** a mock `/api/status`, `/generate`, `/jobs` and `/output` behind `WB_TEST=1`, as `WB_FAL_BASE` does for fal.

---

## 9. Security notes for remote use

- **Never expose `:7860` to the internet as it is.** There is no authentication. `X-User` is trusted blindly, so anyone
  can impersonate any owner and read their images. `/api/shutdown` and `/api/model/unload` are open. `POST /api/loras`
  makes the server download up to 2 GB per call from arbitrary HF repos. RunPod's public `https://<pod>-7860.proxy.runpod.net`
  proxy would hand all of this to anyone who finds the URL. Since the app binds to 127.0.0.1 it will not even answer
  there, so keep it that way.
- **Use an SSH local forward** (preferred: no extra software, the port stays on the pod's loopback) **or Tailscale**,
  with the studio on the tailnet address and ACLs limited to Dani's devices. If a friend's PC hosts it, the same rule
  applies: the tunnel ends on that machine's loopback.
- **If several people must share one server**, put an authenticating reverse proxy in front: Caddy, or Cloudflare
  Access with Cloudflare Tunnel. It must **strip any incoming `X-User` and set it from the verified identity**, as the
  original PC-DAZE gate did (app.py:401-405).
- **The workbench side:**
  - only `qwen.mjs`, in Node, talks to the studio;
  - `qwen_base` comes from config, never from a request or an agent;
  - outputs are downloaded only from `qwen_base`'s own origin;
  - images sent to a rented pod leave the laptop, which conflicts with "data stays local". Do not send refs flagged
    private to a remote qwen server unless Dani opts in, using the same check as `privateUploadOk` for fal.
- **Pod hygiene:**
  - the network volume holds Dani's generated images (`output/<owner>/`): delete them, or the volume, when he is done;
  - stop the pod after the session so it does not bill idle hours;
  - never put an HF or Civitai token in the repo.

---

## 10. Licence

- Qwen-Image-2.1 weights, the GGUF quants ("follows the license of the original model") and the Viggle turbo LoRA are
  under the **Qwen Research License**. They may be used, copied, distributed and modified **"for research or evaluation
  purposes only … FOR NON-COMMERCIAL PURPOSES ONLY"**, and commercial use needs a separate grant. Redistributing the
  weights means including the licence and the notice "Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT", and
  marking modified files. Products have to say "Built with Qwen". "Qwen" cannot be the primary name of a derivative.
  Breach lets Qwen terminate, and you must then delete the Materials.
  (huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE.)
- **Integration code is not the Materials.** `qwen.mjs` speaks HTTP to a server the user runs. It can ship in the public
  MIT workbench repo, as long as:
  - the repo **does not include, vendor or auto-download** the weights, the GGUFs or the turbo LoRA;
  - `fetch_models.py` is not run without the user;
  - the README says "Qwen-Image-2.1 is under the Qwen Research License (non-commercial); you download it yourself".
  - Keep `local-gen/qwen-image21/` out of the workbench repo too. Its code has no stated licence, and it is someone
    else's project. Link to it instead.
- **Dani's use:** a personal, non-monetised videoclip fits "non-commercial". If the clip is ever monetised (ads,
  sales, client work), the 2.1 outputs need either a commercial grant from Qwen or a re-render with a commercially
  licensed model. fal's Qwen-Image-Edit-2511 is Apache-2.0-era Qwen-Image; check the model page at the time.
- Each catalog LoRA has its own licence (SETUP.md). Civitai ones are often non-commercial too.
- The "Built with Qwen" notice belongs in the workbench docs wherever the qwen generator is offered.

---

## Sources (fetched 2026-10-06 unless dated)
- leejet/Qwen-Image-2.1-GGUF, files and card: https://huggingface.co/leejet/Qwen-Image-2.1-GGUF
- Qwen Research License: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE
- Q4 stack sizes and 3050 / 4060 Ti / 5090 timings (2026-09-23): https://openclawdc.com/blog/can-i-run-qwen-image-2-1-locally/
- Unsloth requirements: https://unsloth.ai/docs/models/qwen-image-2.1
- RunPod pricing: https://www.runpod.io/pricing. Storage rules: https://docs.runpod.io/storage/overview
- Vast.ai 5090 and 4090: https://computeprices.com/providers/vast/gpus/rtx5090,
  https://computeprices.com/providers/vast/gpus/rtx4090, https://deploybase.ai/articles/rtx-5090-on-vastai-pricing-specs-how-to-rent
- Modal pricing: https://modal.com/pricing
- fal: https://fal.ai/models/fal-ai/qwen-image-edit-2511/llms.txt,
  https://fal.ai/models/fal-ai/qwen-image-edit-2511-multiple-angles/llms.txt,
  https://fal.ai/models/fal-ai/qwen-image-2/pro/edit/llms.txt, https://fal.ai/models/fal-ai/qwen-image-2.1
- No official 2.1 API (2026-09-23): https://apimaster.ai/blog/qwen-image-2-1-api. Model Studio qwen-image-3.0:
  https://www.eesel.ai/blog/qwen-image-2-1-alternatives
