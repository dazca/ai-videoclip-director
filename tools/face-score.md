# Optional: a local face-embedding score for identity checks

ROADMAP_v4 D7 has two paths. The workbench ships one of them:

- **The agent's vision check (built in, free).** The agent looks at each new output next to the approved identity
  image and writes a check against the character's constants checklist (`check_add`). It needs no model, no download
  and no GPU.
- **A face-embedding score (not built).** A local face-recognition model compares the two faces and gives a
  similarity number. Nothing in the workbench computes it, downloads a model or calls a service. This page only
  describes how a local tool could fill the `score` field of a check if the director ever asks for one.

## The hook

A check (`checks.json`, `js/checks.js`) may carry:

```json
"score": { "model": "arcface-r100 (insightface buffalo_l)", "value": 0.71, "threshold": 0.5, "metric": "cosine" }
```

- `model`: what made the number (up to 80 characters).
- `value`: the number itself.
- `threshold`: optional, the value the tool treats as "same person".
- `metric`: optional, for example `cosine`.

`check_add` accepts `score` and refuses a malformed one. The badge and its hover detail show it ("face score
arcface…: 0.71 (threshold 0.5)"). The score never changes the verdict by itself, and like every check it never
approves, rejects or picks anything.

## How a local tool could fill it

Constraints on this machine:

- **Never `pip install` into the global Python.** It has pinned packages (numpy 1.26.3, opencv 4.11) that other
  projects rely on. Use a virtual environment only for this tool.
- **8 GB of VRAM.** A face-recognition model needs well under 1 GB, so the GPU is not the limit. The CPU works too and
  is fast enough for a handful of images.
- **Disk.** The disk is tight. An InsightFace model pack is about 300 MB (`buffalo_l`), and onnxruntime plus its
  dependencies are a few hundred MB more. Check the free space first, and keep the venv and the models outside the
  workbench and the project folders.
- **Licences.** InsightFace's pretrained models are for non-commercial research use. Read the model's licence before
  using it on a released video.

A sketch, run by hand by the owner, outside the workbench:

```
python -m venv C:\tools\face-score\.venv
C:\tools\face-score\.venv\Scripts\pip install insightface onnxruntime    # into the venv only
```

The script (`face_score.py`, kept next to the venv, not in this repository) would:

1. Read the open asks: `node <workbench>/mcp/client.mjs checks_get '{"entity":"ada"}' --project <p>`. Each ask lists
   the outputs (`files[].abs`) and the target to name. `checklist[].identity.abs` is the approved identity image.
2. Detect the largest face in the identity image and in each output, take each face's normalised embedding, and compute
   the cosine similarity.
3. Record a check with the score, through the same tool the agent uses:

   ```
   node <workbench>/mcp/client.mjs check_add '{"target":{"kind":"node","id":"ada/n05"},"against":{"entity":"ada"},
     "verdict":"ok","score":{"model":"arcface-r100 (buffalo_l)","value":0.71,"threshold":0.5,"metric":"cosine"},
     "note":"face score only","by":"face-score"}' --project <p>
   ```

   A face-only tool cannot see the constants (a clip's side, a seam), so it should leave `items` empty. The agent's
   vision check stays the one that reads the checklist. Two checks on the same output are fine: the badge shows the
   newest, and the hover detail lists the earlier ones.

Model downloads happen only when the owner runs the tool by hand. The workbench, its tests and its MCP tools never
download or run a model.
