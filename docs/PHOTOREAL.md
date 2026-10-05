<!-- Copied into the workbench from videoclip-research/PHOTOREAL_GUIDE.md (2026-10-04); the recipe it explains is templates/photoreal_recipe.json, built into prompts by js/recipe.js. -->
# Photoreal guide: consistent real-looking character with fal.ai models

Research date: 2026-10-04. Scope: Nano Banana 2 (NB2), Seedream 5, Flux Kontext / FLUX.2, Qwen-Image-Edit, MiniMax Hailuo H3, Kling v3 (incl. Motion Control), all through fal.ai.

Tags: **[V]** read on the cited page today. **[I]** practitioner or reseller claim, plausible but not checked against the vendor. **[U]** could not verify (stated as an assumption). Prices are fal list prices read 2026-10-04 unless noted.

The machine-usable version is `templates/photoreal_recipe.json` (in the workbench).

---

## 0. The eight rules (summary)

1. **Describe a photograph, not an image.** Write a sentence-style scene, then camera, lens, aperture, light, texture. "Describe the scene, don't just list keywords" (Google) [V]. FLUX.2 wants Subject + Action + Style + Context, most important first [V].
2. **Name real optics and light physically.** Focal length, aperture, distance, ISO/shutter, the light source, its direction, its colour temperature, and what it hits. Generic "professional photo / cinematic lighting" pulls toward retouched stock [V BFL, I oakgen].
3. **Ask for imperfection, ban polish.** Pores, fine lines, flyaways, fabric creases, sensor noise. Drop "beautiful, perfect, flawless, 8k, masterpiece, HDR, ultra-detailed". These words push models into their retouched-ad training data [I, several sources].
4. **One light world.** Character and background must share the same key direction, colour temperature and shadow softness; say "the same light falls on her and the room". Lighting mismatch is the main composite tell.
5. **Give every reference a job** ("Image 1 = face, Image 2 = full body, Image 3 = the hair clip, Image 4 = the location") and say what must stay identical [V fal H3 guide, BFL FLUX.2].
6. **Edit in small steps and re-anchor.** One change per edit; restate "keep face, hair, body unchanged"; re-attach the original identity refs every 5-8 edits instead of chaining edits of edits [I].
7. **Animate only approved stills, keep motion small.** 5-6 s, one camera move, face large in frame, describe motion only (not what the image already shows) [V fal H3, I others].
8. **Post-process lightly and globally.** Mild grain matched to the "ISO", a touch of chromatic aberration/vignette, no heavy sharpening, a faithful (non-hallucinating) upscaler.

---

## 1. Prompt structure for stills

### 1.1 Vendor templates

- **Google (Gemini image / NB family), Aug 2025** [V] ([Google dev blog](https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/)):
  `A photorealistic [shot type] of [subject], [action or expression], set in [environment]. The scene is illuminated by [lighting description], creating a [mood] atmosphere. Captured with a [camera/lens details], emphasizing [key textures and details]. The image should be in a [aspect ratio] format.`
  Best practices from the same post: be hyper-specific; give context (what the image is for); iterate conversationally; **semantic negatives** (describe the wanted state positively, e.g. "an empty street" not "no cars"); camera vocabulary for framing.
  Note: Google's NB2/NB Pro prompt pages for 2026 were not reachable on ai.google.dev today; the template above is the 2.5 Flash one, which practitioners still use for NB2 [U for NB2 specifically].
- **BFL FLUX.2** [V] ([prompting guide](https://docs.bfl.ai/guides/prompting_guide_flux2.md), [photoreal use case](https://docs.bfl.ai/guides/usecases_t2i_photorealistic.md)): Subject + Action + Style + Context; word order matters (front-load). **Negative prompts are not supported** — rewrite "no blur" as "sharp focus throughout". 30-80 words is usually ideal. Name camera + lens ("shot on Fujifilm X-T5, 35mm f/1.4"). Ask for "pores, wrinkles, fabric wear, imperfections". Hex colours bind best to an object ("the clip is #F26B1D"). Multi-ref: up to 8 refs on [pro] at 1 MP, ~10 on [flex]; assign roles ("subject from image 1, style from image 2").
- **Seedream 5.0 Pro** (Atlas Cloud guide, 2026-08-06) [I]: "imperfection engineering" beats quality keywords: "visible grain / high-ISO grain", "motion blur on background", "harsh flash shadows", "color cast", "soft focus on far ear", "off-center framing", "no beauty filters". Avoid "8K ultra HD masterpiece, best quality". Known weakness: **skin more over-smoothed than Seedream 4.5**, overshoot in action, content-filter false positives ([Atlas](https://www.atlascloud.ai/blog/guides/seedream-5-pro-realistic-portraits)).
- **NB2 practitioner structure** (Atlabs, 2026-02-28) [I]: `[subject + details] + [action] in [setting], [composition + camera], [lighting + mood], [style]`; 85-135 mm for portraits, f/1.4-2.8 for separation ([atlabs](https://www.atlabs.ai/blog/nano-banana-2-prompting-guide)).

### 1.2 Block order used in our recipe

1. **Reference roles + identity lock** (edit requests only).
2. **Subject**: who, age band, build, hair, wardrobe with materials (matte cotton, enamel, wool), props with exact colour.
3. **Action / pose / expression**: concrete, slightly unposed ("weight on her left leg, glancing past the camera").
4. **Location**: a real, specific place with mundane detail (carpet tiles, cable trays, a chair pushed out). Real places are untidy.
5. **Light, described physically**: source, direction, colour temperature (K or "cool blue / warm tungsten"), hardness, where shadows fall, which practicals are on. One sentence stating that subject and room share it.
6. **Camera**: body or format (full-frame / 35 mm film / phone), focal length, aperture, distance, height, ISO/shutter when it matters (high ISO = honest noise at dawn/night).
7. **Texture**: skin (pores, fine lines, slight redness, under-eye), hair (flyaways), fabric (weave, creases, lint).
8. **Medium / grade**: "unretouched documentary photograph", "Kodak Portra 400 colour" or "natural colour, accurate white balance". Pick one; don't mix contradictory grades ("accurate WB" + "heavy teal-orange") [I sweetprompt 2026-07-12].
9. **Aspect ratio / resolution** via API params, not text.

Camera cheat sheet (BFL) [V]: f/1.4-2.8 shallow, f/8-16 deep; 24 mm wide, 35 mm documentary, 50 mm neutral, 85 mm portrait, 135 mm+ compression. For **full body**, 35-50 mm at 3-5 m keeps proportions natural; 85 mm full body needs ~8 m and flattens the room. Wide lenses (<28 mm) close to a face distort it — useful only if wanted.

Film-stock shortcuts [I]: Kodak Portra 400 (warm, soft skin, fine grain), Kodak Gold 200 (warm consumer), Fujifilm Pro 400H / Superia (cooler greens), Cinestill 800T (tungsten, halation around lights — good for night/neon), Ilford HP5 (B&W). Phone look: "shot on a phone, 24 mm main camera, slight noise reduction smearing in shadows" [I].

### 1.3 Words to leave out (and why)

Quality spam: `8k, 4k, ultra HD, masterpiece, best quality, ultra-detailed, hyperrealistic, award-winning, trending`. Beauty words: `beautiful, gorgeous, perfect, flawless, porcelain, glass skin, smooth skin, airbrushed, symmetrical face, supermodel`. Look words that read as render: `HDR, octane, unreal engine, 3D render, CGI, digital art, concept art, illustration, glossy, vibrant colors, cinematic lighting` (replace "cinematic lighting" with the actual light). Style triggers for 2D: `anime, cartoon, painterly, stylized`. Also avoid `bokeh` spam on interiors (it creates fake-looking cut-outs) [I].

Negative phrasing: NB2 and FLUX.2 have **no negative prompt field**; write the positive state. A short trailing guard sentence ("unretouched, not a render, no beauty filter") is common and harmless with NB/Seedream [I]. Kling v3 and fal's Kling have a real `negative_prompt` field (default "blur, distort, and low quality") [V].

---

## 2. Identity consistency

### 2.1 Reference strategies (no training)

- **NB2 / NB Pro**: up to 14 reference images; practitioners report ~6 are treated at high fidelity on NB Pro [I]. fal NB2 edit takes `image_urls`, `seed`, `thinking_level` ("high" +$0.002), resolution 0.5K-4K [V].
- **Identity pack (recommended)**: 3-6 images of the real person: 1 tight face crop front (≥1024 px), 1 three-quarter, 1 profile, 1 full body neutral outfit, optionally 1 smiling. Same person, varied light, no sunglasses, no heavy makeup/filters. Feed the **face crop first** and name it.
- **Identity sheet**: a single turnaround image (front / ¾ / side / back + face close-up) generated once and approved, then used as one ref. Works well for wardrobe consistency; for face fidelity a **real face crop beats a generated sheet** (the sheet is already one generation away from the person) [I].
- **Explicit lock phrase**: "Keep the person's facial features exactly the same as Image 1" / "Same woman as Image 1" — name the reference, don't say "this person" [I, multiple]. Also lock non-face identity cues: hairline, moles, eyebrow shape, teeth, body proportions, height.
- **Drift budget**: identity holds for ~8-10 sequential edits, then drifts; re-anchor to the original refs every 5-8 edits [I].
- **Text identity card**: keep a 10-12 line description (age, skin tone, hair, distinguishing marks, default wardrobe, things she never wears) and paste the same words in every prompt [I].
- **QA**: score every output by face-embedding cosine (ArcFace/InsightFace) against the real photos and auto-reject below a threshold (see `02-image-gen.md`). Cheap and catches drift humans miss after many images.

### 2.2 ID adapters

PuLID-FLUX / InstantID work on open FLUX/SDXL only; ~$0.04 per image on resellers [I]; a fal PuLID price was not found [U]. In 2026 they are behind NB2/Seedream in-context refs for realism and are not needed in this pipeline.

### 2.3 LoRA / trained identity on fal

| Trainer (fal) | Price | Images | Notes |
|---|---|---|---|
| `fal-ai/flux-lora-portrait-trainer` | $0.0024/step, min 1000 billed → **$2.40** [V] | "at least 10, more is better" [V] | FLUX.1-based; usable with FLUX.1 LoRA endpoints |
| `fal-ai/flux-2-trainer` | $0.0064/step → **$6.40** at default 1000 [V] | ≥10 [V] | FLUX.2 LoRA |
| `fal-ai/qwen-image-edit-trainer` | $4.00 / 1000 steps [I] | – | Edit-model LoRA (identity-preserving edits) |
| `fal-ai/z-image-trainer` | $2.26 / 1000 steps [I] | – | Cheap, fast T2I |
| Phota profile (on fal) | **$2.90** per profile, 30-50 photos; then $0.09/img 1K [V in `02-image-gen.md`] | 30-50 | Trained identity layer on top of NB2 / GPT Image |

Key point: **a LoRA cannot be used with NB2, Seedream, Kling or Hailuo** (closed models). It only helps if you route identity shots through FLUX / Qwen / Z-Image, which are behind NB2 on realism. The prior research cites a benchmark where trained identity beats in-context refs (`02-image-gen.md`, arXiv 2609.04151) [I, not re-read today].

**Recommendation**: start with the reference pack + lock phrase + embedding QA on NB2. If cosine scores stay low on side angles or wide shots, buy a **Phota profile ($2.90)** before any LoRA, because it works on top of the NB2 route we already use. A FLUX.2 LoRA ($6.40 + 15-30 curated photos, one look) is the fallback for a FLUX route, worth it only if dozens of shots need the face at small sizes.

---

## 3. Edit workflows without identity drift

- **Google edit templates** [V]: add/remove — `Using the provided image of [subject], please [add/remove/modify] [element]. Ensure the change is fully integrated with the original style, lighting and perspective.` Inpainting by words ("semantic masking") — `Using the provided image, change only the [specific element] to [new element]. Keep everything else in the image exactly the same, preserving the original style, lighting, and composition.`
- **Flux Kontext** [I, BFL/Comfy docs]: name the person by description, not pronoun ("the woman with short dark hair", not "her"); state what stays ("while maintaining the same facial features, hairstyle and expression"); "change the clothes to…" is safer than "transform her into…" (transform invites a re-cast).
- **Qwen-Image-Edit 2511**: $0.03/MP on fal [I]; when the instruction is vague it can "re-cast" the face instead of preserving it — be concrete and keep edits local [I].
- **Seedream 5.0 Pro Edit**: region-precise, sketch completion, up to 10 refs; $0.0675 (≤1536²) / $0.135 (≤2048²) + $0.0045 per extra ref [I]. **No seed** → not reproducible [I].
- **Masks**: when you have a mask, use a real inpainting endpoint (`fal-ai/flux-pro/v1/fill`, already in the workbench) for wardrobe/prop changes so the face pixels are literally untouched; then a light NB2 "harmonise lighting, keep everything else identical" pass if the seam shows.
- **Sketch-guided edits**: draw a rough shape/colour blob where the prop goes (e.g. orange star at temple) and say "replace the orange scribble with an orange starburst enamel hair clip, real metal and enamel, same light as her hair". Works on NB2 and Seedream edit [I].
- **Props/wardrobe with a ref image**: give the prop its own reference ("Image 3 = the hair clip; copy its shape and colour exactly; scale ~4 cm").
- **Order of operations**: identity/pose shot first → wardrobe edit → prop edit → location/relight → never re-generate the face after that. One change per call.
- **Relight phrase** [I]: "Keep the subject and pose exactly. Relight as [source] from [direction], [colour temperature]. Add [shadow] on [side]."

---

## 4. Realism killers and fixes

| Killer | Why | Fix |
|---|---|---|
| Plastic / waxy skin | Training data = retouched ads; beauty words; NB Pro reported plastic in Apr 2026; Seedream 5 smoother than 4.5 [I] | Ask for pores, fine lines, slight redness, peach fuzz, unretouched; remove beauty words; higher ISO; texture-restore pass at 35-60 % strength [I oakgen 2026-04-22] |
| Over-sharpening / crunchy edges | Upscalers, "ultra-detailed", HDR | No "sharp/detailed" spam; faithful upscaler; at most CAS sharpen at low strength |
| Perfect symmetry, centered pose | Default composition | Off-centre framing, head slightly turned, weight on one leg, asymmetric light |
| Lighting mismatch (subject vs room) | Refs shot in different light; composite edits | One light sentence that covers both; relight pass; match colour temperature and shadow direction; add contact shadows and floor bounce |
| Too clean location | Model tidies | List mundane clutter; wear on surfaces |
| Fake depth of field | f/1.2 on everything | Use f/2.8-5.6 for environment shots; shallow DOF only for close-ups |
| Wrong scale of person vs room | Full-body edits on wide refs | State distance and lens (35 mm, ~4 m); mention ceiling/door height |
| Glossy fabric, CG hair | "silky", "glossy" | Matte materials, creases, flyaways |
| Stylisation creep after many edits | Chained edits | Re-anchor to the original refs every 5-8 edits |

---

## 5. Post-processing

Order: (1) faithful upscale → (2) light colour match/grade → (3) lens: subtle vignette, 0.5-1 px chromatic aberration at edges, optional slight barrel distortion → (4) film grain last, matched to the stated ISO/stock → (5) export JPEG ~90 (real photos are JPEGs).

- **fal `fal-ai/post-processing`** does all of step 2-4 in one call for **$0.001**: film grain (styles modern/analog/kodak/fuji/cinematic), colour correction, chromatic aberration, vignette, parabolize (lens distortion), sharpen (basic/smart/CAS) [V].
- **Upscalers**: SeedVR2 (one-step diffusion, faithful, also video) or Topaz-style faithful enlargement keep the photo look; **Magnific-style "creative" upscalers hallucinate texture** and make skin crunchy — avoid on faces or keep creativity at minimum [I].
- Grain must be uniform and **after** upscaling; uniform grain is fine for stills but generic "realism" phone filters and HDR apps amplify the plastic look [I].
- Video: grain + slight CA in the final edit (ffmpeg `noise`, or in the NLE), applied to all clips equally so AI and real footage match.

---

## 6. Video

### 6.1 Image-to-video realism

- **Animate approved stills only**; I2V amplifies face, hand and clothing errors [I].
- **Describe motion, not content** — the model sees the image [V fal H3 guide 2026-07-30].
- **Short and slow**: 5-6 s, one camera move (slow push-in, gentle handheld, static), subject motion small. Faces fall apart on 10 s head-turns, profile turns, occlusion, fast moves [I unifab/higgsfield].
- **Face size**: medium or closer for any shot where identity matters; in wide shots the face is a few hundred pixels and smears [I].
- **Timed beats** for 10-15 s: `[0-3s] … [3-6s] …` (H3 and Kling both respond) [V fal H3; I Kling].
- **Camera language**: Kling 3.0 needs explicit shot type + one move; simple directions are more stable than fancy cinematic vocabulary [I].
- **Realism words for video**: "handheld documentary footage, natural motion blur, fine film grain, no beauty filter, real skin texture, stable face". H3 guide lists "over-smoothed skin" and "compositing seams" among things to avoid [V].
- **Negatives (Kling)**: `negative_prompt`: "morphing face, changing identity, plastic skin, smooth skin, extra fingers, warped hands, flicker, cartoon, CGI, text, watermark" [field V; content I]. `cfg_scale` default 0.5 [V].
- **Identity in video**: Kling v3 `elements` (frontal image + 1-3 extra angles, referenced as `@Element1`) keeps the face through angle changes [V param, I effect]. H3 Reference-to-Video: up to 9 images / 3 videos / 3 audio; give each a job and add a face close-up [V].

### 6.2 Start and end frames

- Kling v3 i2v has `end_image_url` [V]; H3 has a First & Last Frame endpoint [V].
- Make the end frame by **editing the start frame** (same lighting, lens, location, wardrobe; only pose/expression/camera position changed). Large differences in lighting, angle or position produce morphs or a hard cut [I Kling/Artlist].
- For a seamless loop set end = start [I].
- Keep both frames at the same resolution/aspect and from the same edit chain.

### 6.3 Kling Motion Control (v3)

Official + fal [V] ([Kling guide](https://kling.ai/quickstart/motion-control-user-guide), [fal](https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control)):
- Reference video 3-30 s, **one continuous shot, one person, no cuts, no camera move**, steady moderate motion; fast moves may shorten output.
- Character image: whole body and head visible, unoccluded, **same framing as the video** (full body ↔ full body), room to move, person >5 % of frame.
- `character_orientation`: `video` (up to 30 s; follows the video's orientation and camera; **facial element only works here**) or `image` (up to 10 s; lets you prompt camera moves).
- v3 facial consistency: add a face element with front + side + expression shots (or a short face video). A face element very different from the first-frame face degrades quality.
- Prompt controls background/atmosphere, not the motion.
- Price: $0.168/s Pro [V]; Std ~$0.126/s [I from `03-video-gen.md`].
- Tip: film the driving performance in similar light to the still; record Dani's own moves on a phone on a tripod.

---

## 7. Per-model notes (fal, 2026-10-04)

| Model | fal endpoint (assumed ids where marked) | Cost | Strengths | Weaknesses |
|---|---|---|---|---|
| **Nano Banana 2** (Gemini 3.1 Flash Image) | `fal-ai/nano-banana-2/edit` | $0.08 at 1K, $0.06 0.5K, $0.12 2K, $0.16 4K [V] | Pore-level skin, physical light, best value for identity edits, 14 refs, seed | Occasional jaw/catchlight drift [I]; safety refusals on some faces [I] |
| Nano Banana Pro | `fal-ai/nano-banana-pro/edit` [U id] | ~$0.15 [I] | Best Google face hold [I] | Apr 2026 reports of plastic/older faces [I]; 2× price |
| **Seedream 5.0 Pro (Edit)** | `fal-ai/bytedance/seedream/v5/...` [U id] | $0.0675 ≤1536², $0.135 ≤2048², +$0.0045/extra ref [I] | Cinematic light, dense detail, 10 refs, sketch edits; ties NB2 on ByteDance's own benchmark (24.02 % vs 23.95 % usable) [I] | Smoother skin, no seed, filter false positives [I] |
| **FLUX.2 [pro] edit** | `fal-ai/flux-2-pro/edit` | $0.03 first MP + $0.015/extra MP in+out [V] | Cheap, exact hex colour, LoRA ecosystem | No negative prompt; realism a step below NB2 [I] |
| Flux Kontext [max] multi | `fal-ai/flux-pro/kontext/max/multi` (in workbench) | $0.08 [V] | Surgical single edits | Older (FLUX.1), more "AI-clean" skin [I] |
| **Qwen-Image-Edit 2511** | `fal-ai/qwen-image-edit-2511` | $0.03/MP [I] | Cheap local edits, LoRA-trainable | Can re-cast faces on vague edits [I] |
| **MiniMax H3 / H3 Max** I2V | `minimax/h3-max/image-to-video` [V] | H3 Max: **$0.048/s 768p promo until 2026-10-15, then $0.08**; $0.16/s 1080p [V]. H3 standard $0.06/s 768p [V in `15-asset-economy.md`] | #1 I2V value, first+last frame, 5-15 s 2K, refs, accepts photoreal faces [I] | Long prompts can overload; face drift on long moves [I] |
| **Kling v3 Pro** I2V | `fal-ai/kling-video/v3/pro/image-to-video` | $0.112/s silent, $0.168/s audio [V] | Elements for identity, end frame, negative prompt, 3-15 s | Pricier; mid Elo on realism [I] |
| Kling v3 Motion Control | `fal-ai/kling-video/v3/pro/motion-control` | $0.168/s [V] | Real performance transfer from a phone clip | Needs clean single-person reference clip |

Most photoreal right now: **NB2 and Seedream 5 Pro are in the same tier for people**; NB2 wins on skin micro-texture and physical light, Seedream on dramatic/cinematic looks [I]. Edit leaderboards put NB Pro / NB2 just behind GPT Image (not in this pipeline) [I, leaderboard snapshot dates unclear]. For video, H3 Max is the default for realism per dollar; Kling v3 when you need elements, end frames or motion control.

---

## 8. Sources (accessed 2026-10-04)

Vendors / fal:
- Google, "How to prompt Gemini 2.5 Flash Image" (2025-08-28): https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/
- Google, Gemini app image tips (2025-08-26): https://blog.google/products/gemini/image-generation-prompting-tips/
- BFL FLUX.2 prompting guide: https://docs.bfl.ai/guides/prompting_guide_flux2.md ; photoreal use case: https://docs.bfl.ai/guides/usecases_t2i_photorealistic.md
- fal MiniMax Hailuo 3 prompting guide (2026-07-30): https://fal.ai/learn/devs/minimax-hailuo-3-prompting-guide-44-video-examples-fal
- fal model pages: https://fal.ai/models/fal-ai/nano-banana-2/edit , https://fal.ai/models/minimax/h3-max/image-to-video , https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video , https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control , https://fal.ai/models/fal-ai/flux-2-pro/edit , https://fal.ai/models/fal-ai/flux-pro/kontext/max/multi , https://fal.ai/models/fal-ai/flux-2-trainer , https://fal.ai/models/fal-ai/flux-lora-portrait-trainer , https://fal.ai/models/fal-ai/post-processing , https://fal.ai/models/fal-ai/qwen-image-edit-2511
- Kling Motion Control user guide: https://kling.ai/quickstart/motion-control-user-guide ; start/end frames: https://kling.ai/quickstart/ai-video-start-end-frames

Practitioners:
- Atlas Cloud, Seedream 5 Pro realistic portraits (2026-08-06): https://www.atlascloud.ai/blog/guides/seedream-5-pro-realistic-portraits ; Seedream 5 Pro vs NB2: https://www.atlascloud.ai/blog/tips/seedream-5-pro-vs-nano-banana-2
- Atlabs, NB2 prompting guide (2026-02-28): https://www.atlabs.ai/blog/nano-banana-2-prompting-guide
- oakgen, fix plastic skin (2026-04-22): https://oakgen.ai/blog/fix-plastic-skin-ai-portraits ; Kling motion control: https://oakgen.ai/blog/kling-motion-control-guide
- sweetprompt, reality-first prompting (2026-07-12): https://sweetprompt.com/nano-banana-pro-prompt-reality-first-prompt-engineering
- Charlie Hills, How to prompt Nano Banana pt.2 (2025-10-26): https://charliehills.substack.com/p/how-to-prompt-nano-banana-pt2
- ZeroLu awesome-nanobanana-pro (GitHub prompt library): https://github.com/ZeroLu/awesome-nanobanana-pro
- nenobanana consistency guide: https://www.nenobanana.com/blogs/nano-banana-character-consistency-12-prompts-that-actually-work--2026-guide ; laozhang NB Pro face consistency: https://blog.laozhang.ai/en/posts/nano-banana-pro-face-consistency-guide
- ImagineArt Kling 3.0 prompt guide: https://www.imagine.art/blogs/kling-3-0-prompt-guide ; magichour Kling 3.0 reference guide: https://magichour.ai/blog/kling-30-reference-guide
- Face distortion in AI video: https://unifab.ai/resource/fix-ai-video-face-distortion , https://higgsfield.ai/blog/how-to-avoid-distortions-ai-videos
- Artlist start/end frames: https://artlist.io/blog/ai-video-start-and-end-frame/
- Upscalers: https://wavespeed.ai/blog/posts/seedvr2-vs-topaz/ , https://morphed.app/blog/magnific-vs-topaz-gigapixel-vs-letsenhance
- Relight skill notes: https://mcpservers.org/agent-skills/runcomfy-com/relight
- Leaderboard snapshot: https://magichour.ai/model-leaderboard/image-editing

Not verified / gaps: Google's 2026 NB2-specific prompt guide (page not reachable); fal endpoint ids for Seedream 5 and NB Pro; fal PuLID price; Qwen/Z-Image trainer prices (reseller pages); Reddit and YouTube transcripts were not reachable through search today, so practitioner coverage relies on blogs, GitHub and one X post.
