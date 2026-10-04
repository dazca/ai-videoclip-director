# Free templates for characters, wardrobe, locations and props (research, 2026-10-04)

Context: SPEC v3 stage 4-5 says each character (and each location and prop) can start "via online references already
(find free templates)", from a description, from the user's own photos, or from a sketch, and is then refined with
sketch + text edits on an image model (Nano Banana 2 edit, Seedream, GPT Image 2.5 on fal.ai). The owner decision in
`WEB_SERVICE_PLAN.md` limits what we can host: azemar.eu serves static files only, stores nothing per user, and any
shared content must be a small, opt-in, read-only static catalogue. This document answers three questions: which free
sources are safe to ship or link, what we ship now (`catalog/`), and how the app browses more at runtime without a
server.

Result in one paragraph: the repo now has a **78-item starter catalogue (5.8 MB, every file CC0 1.0 or public domain)**
built from Quaternius 3D characters (rendered by us into turnarounds, poses and OpenPose skeletons), Poly Haven HDRIs
and models, Met Open Access scans of Dürer, Le Brun and old-master hand studies, and eight garment flats we drew. The
"browse online" layer should search **Openverse** straight from the user's browser (CORS `*`, no key, 20 requests/min
and 200/day per IP for anonymous use), filtered to CC0/PDM, with Poly Haven and Wikimedia Commons as extra
providers. When nothing fits, the app generates a neutral mannequin turnaround with the user's own image-model key and
the prompt templates in section 6.

## 1. What the image models need from a "template"

A template plays one of two roles, and keeping them apart solves most of the legal and quality problems:

- **Guide**: it gives layout, pose, proportions, camera angle or expression, and is not meant to show up as itself in
  the output. Examples: a grey mannequin turnaround, a walking pose, an OpenPose skeleton, a Le Brun "fright" engraving,
  a technical flat of a hoodie. Nano Banana 2 edit (up to 14 reference images per request on fal), Seedream and
  GPT Image edit all accept several reference images plus a prompt such as "Image 1 is the character, keep the face.
  Copy the pose from image 2 and the expression from image 3. Photographic, not a 3D render." A guide never has to be a
  photo of a real person, so mannequins and drawings work best and carry no likeness risk.
- **Identity**: it defines who the character is (face, body, skin, hair). The only identity sources the app should use
  are the user's own photos (marked private, never uploaded to our host), a description, or a sketch. A shipped
  catalogue should never provide identities, because a photo of a real person brings in personality rights and model
  releases that stock licences do not grant (see 2.1).

Practical tips for guides:
- Clay renders work better as pose references than bare skeletons for the instruction-following editors (Nano Banana,
  Seedream, GPT Image). These models have no ControlNet input, so they read the skeleton as a picture. OpenPose PNGs
  are still worth shipping for ControlNet-style endpoints (Flux/SDXL ControlNet on fal) and for the sketch tool's
  underlay.
- Always say the style in the prompt ("photographic, natural skin, not a mannequin"). Otherwise the clay look leaks into
  the output.
- Turnaround sheets are the best base for an identity sheet: "Redraw this turnaround as [description], same four views,
  same scale, plain light-grey background."
- Location plates are mood and geometry guides, or a literal background when the shot allows it. Props are object
  references ("the boombox from image 4 on the table").

## 2. Source evaluation

"Ship" means we may copy the file into the open-source repo and serve it from azemar.eu. "Link" means the app may only
search or link it at runtime, and the user fetches it into their own project. All checks were made on 2026-10-04.

### 2.1 Photo libraries

| Source | Licence (exact) | Ship in repo/site? | Attribution | Notes |
|---|---|---|---|---|
| Wikimedia Commons | Per file: CC0, PD, CC BY, CC BY-SA, ... | Only files marked CC0/PD | Required for BY/BY-SA, courtesy for CC0/PD | Has a separate "personality rights" warning template: the licence covers the photo, not the depicted person. Its API allows CORS with `origin=*`. |
| Met Open Access (via Commons/Openverse) | CC0 1.0 for public-domain works | Yes | Not required | 498,428 Met images are indexed in Openverse. Great for drawings, engravings, costume and fashion plates. The Met's own collection API search returned HTTP 410 on 2026-10-04, so go through Commons or Openverse. |
| Openverse | Aggregator: each item keeps its own CC licence or PDM | Only CC0/PDM items, after checking the source page | Per item; the API returns a ready `attribution` string | Openverse says it "cannot make any claims about the accuracy of license information". Re-check the landing page before shipping anything. |
| Unsplash | Unsplash License: free to "download, copy, modify, distribute"; no selling unaltered copies; **may not compile images "to replicate a similar or competing service"** | No (a bundled reference catalogue is close to a compilation) | Not required | Fine for one user picking one photo for their own project. No model releases are guaranteed. |
| Pexels | Pexels License: free, no attribution; "Don't redistribute or sell the photos ... on other stock photo or wallpaper platforms"; identifiable people may not be shown "in a bad light" | No | Not required | The "bad light" clause conflicts with fictional characters (villains, injuries). Never use a Pexels face as an identity. |
| Pixabay | Content Licence: free, no attribution; "cannot sell or distribute Content ... on a Standalone basis"; no immoral use "especially Content which features recognisable people" | No | Not required | Same issue as Pexels. |

Conclusion: the big stock-photo sites are acceptable only as a per-user, runtime choice. Even then the app should warn
that a stock photo of a person gives no right to that person's likeness, so it is to be used as a pose or wardrobe
reference only. We ship none of them.

### 2.2 Pose and figure references

| Source | Licence | Ship? | Notes |
|---|---|---|---|
| Posemaniacs, Line of Action, Quickposes, SenshiStock, ArtStation and Gumroad pose packs | Free to view, or "personal use" or paid licences; no open licence found | No (link at most) | Good for artists, but redistribution is not allowed. |
| "Character turnaround template" sheets (DeviantArt, Etsy, Gumroad, Pinterest) | Mostly "free for personal use" with no clear licence | No | We replaced them with our own CC0 renders (section 3). |
| Quaternius *Universal Animation Library* (Standard, posted on OpenGameArt 2025-04-16) | CC0 1.0 (`License.txt`) | Yes | 14.5 MB zip with one rigged mannequin and 45 animations (idle, walk, jog, sprint, dance, sit, crouch, kneel, jump, push, pick up, drive, ...). glTF/FBX. Our main pose source. |
| Quaternius *Universal Base Characters* (Standard) | CC0 1.0 (`License_Standard.txt`) | Yes | 122 MB zip. The free tier has 2 realistic bodies (Superhero male and female, underwear, bald) plus 6 hairstyles. The paid Source tier adds Regular and Teen bodies. Same naming as Unreal's mannequin, so it can be retargeted. |
| MakeHuman / MPFB 2 | Core assets (base mesh, targets, skins) are CC0 | Yes, once rendered | Best future route to real body-type variety (age, weight, height, ethnicity sliders). Needs Blender, which is not installed here, so it is left for a later pass. |
| Mixamo (Adobe) | Adobe account terms, not an open licence | No | Avoid for shipped files. |
| OpenPose / DWPose skeleton images | Images we draw from our own rig are ours (CC0). The OpenPose software itself is under a non-commercial academic licence; DWPose code is Apache-2.0. | Yes, our own drawings | We draw COCO-18 skeletons in the standard OpenPose colours ourselves. No OpenPose code is used. |
| Public-domain art (Dürer 1528, Le Brun 1698/1765, old-master hand studies) via Met Open Access | CC0 1.0 | Yes | Line-style proportion plates (several body types, front/side/back), head-construction profiles, expression heads, hands. |
| Wikimedia "svgsilh" source (358,942 items in Openverse) | CC0 silhouettes | Yes, item by item | Useful for silhouette poses through the online layer. |

### 2.3 Synthetic and AI-generated people

| Source | Licence | Verdict |
|---|---|---|
| FFHQ (NVIDIA) | CC BY-NC-SA 4.0. These are **real Flickr people**, not synthetic. | No: non-commercial, and real likenesses. |
| Microsoft Face Synthetics | Research-only licence | No. |
| Generated Photos and similar "AI face" stores | Paid commercial licences, no redistribution | No for the repo; a user may buy one for their own project. |
| thispersondoesnotexist-style sites | No clear licence; GAN outputs can resemble training subjects | No. |
| Quaternius 3D bodies (ours) | CC0, sculpted, not scanned | Yes, already shipped. |

Legal caveats to show in the app, which are not legal advice: (1) a copyright licence (CC0, Unsplash, Pexels) does not
license a person's likeness. Personality and image rights (for example Spain's LO 1/1982 and most EU laws) and the
GDPR apply to identifiable people. (2) Stock sites do not promise model releases for every photo. (3) A "friend's face"
needs that friend's consent. The app already marks user photos as private and never sends them to our host, so it
should also ask the user to confirm consent when a photo of someone else is used as an identity. (4) Outputs that look
like a real person can raise issues even if the inputs were synthetic. Keep the provenance of every reference in the
project (the `source`/`licence`/`attribution` fields) so the director can show where things came from.

### 2.4 Wardrobe

| Source | Licence | Ship? | Notes |
|---|---|---|---|
| Free fashion flat and croquis packs (Gumroad, Etsy, blogs) | "Free download" or personal use; no open licence found | No | Most free flats are Illustrator files with unclear terms. |
| Openclipart | Historically public domain/CC0 | Could not check: the site timed out on 2026-10-04 | Try again later; it used to have many clothing outlines. |
| Commons "T-shirt.webp" and similar single items | CC0 (from Pixabay vectors) | Item by item | Too sparse to build a set. |
| Met fashion plates and costume prints (via Openverse `source=met`) | CC0 | Yes | Historical costume, useful for period looks. Fetch at runtime. |
| **Our flats** (`catalog/garment/*.svg`) | CC0 (drawn for this project) | Yes | 8 front technical flats: T-shirt, button-up shirt, hoodie, blazer, dress, A-line skirt, trousers, shorts. The SVG source is shipped so the sketch tool can recolour them. |
| **Our line-art croquis** (`body/*_turnaround_line.jpg`) | CC0 | Yes | Front, 3/4, side and back croquis for drawing a look over a body. |

### 2.5 Locations

| Source | Licence | Ship? | Size and quality |
|---|---|---|---|
| Poly Haven HDRIs (997 on 2026-10-04: 301 indoor, 499 urban, 61 night, 532 nature) | CC0 1.0. "You can use our assets for any purpose ... do not need to give credit." The website itself (logos, page renders) is not CC0. | Yes (asset files only) | The tonemapped JPG of each HDRI is 4-76 MB (equirectangular). Many HDRIs include **backplates** (real perspective photos, 6-17 MB JPG each, also CC0). We extract 1024x576 perspective views instead (about 120 KB each). |
| ambientCG | CC0 1.0 (attribution appreciated) | Yes | Materials, not places. Useful later for surfaces. |
| Commons architecture photos | Mixed licences; freedom-of-panorama rules differ by country | Item by item | Use through the online layer. |

### 2.6 Props

| Source | Licence | Ship? | Notes |
|---|---|---|---|
| Poly Haven models (521: 176 props, 85 furniture, 31 electronics, 29 lighting, 5 instruments, ...) | CC0 1.0 | Yes, rendered | 1k glTF (1-10 MB each). Photographic PBR scans, ideal as product-style references. We render them on white. |
| Quaternius and Kenney packs | CC0 | Yes | Stylised low-poly, less useful for a photographic video, but good for blocking. |
| Smithsonian Open Access (images and 3D) | CC0 | Item by item | Searchable through Openverse (`smithsonian_*` sources). |

## 3. The starter catalogue (shipped)

Location: `workbench/catalog/` with `catalog.json`, `LICENSES.md` and one folder per kind. Total 5.8 MB, 105 files.

| kind | items | contents |
|---|---|---|
| body | 13 | 6 clay turnarounds (front, 3/4, side, back, A-pose): neutral, heavy, slim and child-proportion mannequins, athletic male, athletic female. 3 line-art croquis turnarounds. 4 Dürer proportion plates (slim and heavy figures, front, side and back). |
| pose | 22 | 18 mannequin poses (talking, walk, upright walk, jog, sprint, 3 dance frames, 2 sitting, crouch, kneel, jump, push, pick up, reach, driving, holding a light up), **each with a matching `*.openpose.png`**. 4 hand-study drawings (Boilly, Legros, Andrea del Sarto, Lely). |
| face-angles | 3 | Athletic male and female heads at yaw 0/45/90/135/180. Dürer head construction (front and profiles). |
| expressions | 7 | Le Brun heads (Sayer 1765 edition): desire, hatred, laughter, sadness, pain, fright, plus a Testelin/Le Brun sheet of many expressions. |
| garment | 8 | Our technical flats (JPG plus SVG source). |
| location | 12 | Perspective plates from Poly Haven HDRIs: wasteland lot, auto-shop hall, cobblestone street at night, empty warehouse, lake, metro station, misty pine forest, neon studio wall, rainforest trail, rooftop car park at night, two city streets. |
| prop | 13 | Poly Haven models on white: armchair, CRT television, boombox, rangefinder camera, ukulele, oil lantern, street lamp, cine camera, wine bottles, desk lamp, potted plant, vintage laptop, cassette player. |

`catalog.json` schema (one object per item, paths relative to `catalog/`):

```json
{ "id": "pose-walk", "kind": "pose", "title": "Walking", "tags": ["mannequin", "clay", "3d-render", "full-body", "walk"],
  "file": "pose/walk.jpg", "width": 586, "height": 1024,
  "source": "https://quaternius.com/packs/universalanimationlibrary.html", "licence": "CC0-1.0",
  "licence_url": "https://creativecommons.org/publicdomain/zero/1.0/",
  "author": "Quaternius (model and animation); render: Director Workbench",
  "attribution": "Rendered by the Director Workbench project from \"Universal Animation Library\" by Quaternius (CC0 1.0). No attribution required.",
  "control": { "openpose": "pose/walk.openpose.png", "note": "..." } }
```

Optional extra fields: `control.openpose` (pose), `vector` (garment SVG), `hdri` (location). All 78 items are
`CC0-1.0`. The schema also allows `PDM-1.0` for Public Domain Mark items, but none are shipped yet. Images are JPEG q84,
longest side 1024 px, with no EXIF or ICC metadata. OpenPose files are PNG.

How it was built (reproducible, the scripts are not committed): the Quaternius glTF files were loaded in three.js
r170 inside headless Chromium (SwiftShader). Each figure got a neutral clay material, the arms were rotated from the
T-pose into an A-pose, and body types were made by scaling the mannequin's bones (absolute scale per bone, compensated
in the child bones). Four yaw views were rendered and composed into one sheet. Poses are sampled frames of the CC0
animations. OpenPose keypoints are the projected bone origins, with the face points estimated from the head bone.
Line art is an edge filter on the silhouette plus shading. Locations are a rectilinear projection (72° horizontal FOV,
pitch -3°) of each tonemapped HDRI. Props are the Poly Haven 1k glTF files rendered from 35° yaw and 18° elevation,
then cropped square. Every crop was checked by eye. Two candidates were dropped: the artist-workshop view (it showed
third-party paintings and icons) and the Shanghai Bund view (a crowd of people).

UI suggestions for stage 4 and 5: one "Start from template" picker filtered by `kind` and `tags`, which copies the file
and its provenance into the project (`refs/<id>.jpg` + `refs/<id>.json`) so later edits keep the licence trail. Hide
the `unclothed-schematic` tag (Dürer plates) behind a toggle. When a pose is picked, attach both the clay render and
the OpenPose image to the request and let the generation adapter choose which one to send.

## 4. "Browse online": Openverse from the user's browser

Because the site has no server, the browser calls the APIs directly. Measured on 2026-10-04:

- `GET https://api.openverse.org/v1/images/?q=...` answers with `access-control-allow-origin: *`. Anonymous limits
  come back in headers: `x-ratelimit-limit-anon_burst: 20/min`, `anon_sustained: 200/day`, and thumbnails
  `anon_thumbnail: 1000/day`. Anonymous `page_size` is at most 20 (`"page_size may not exceed 20 for anonymous
  requests"`), and an anonymous search returns at most 240 results (12 pages of 20).
- The limits apply per client IP, so each user has their own quota. We must **not** register an OAuth client and embed
  its secret in a static site.
- Useful parameters: `license=cc0,pdm` (or `license_type=commercial,modification` to allow CC BY), `category=photograph|
  illustration|digitized_artwork`, `source=met,smithsonian_*,wikimedia,svgsilh,...`, `aspect_ratio=tall|wide|square`,
  `size=large`, `mature=false` (the default), plus `page`.
- Each result includes `id, title, url, thumbnail, foreign_landing_url, creator, license, license_version, license_url,
  source, provider, width, height, filesize, tags, attribution, mature, unstable__sensitivity`. The `thumbnail` is
  served by `api.openverse.org` with CORS `*`, so it can be drawn into the sketch canvas without tainting it. The full
  `url` usually points at the original host (Flickr sends CORS `*`; others may not). Fetch the full image only when
  the user picks it, and fall back to the thumbnail if CORS fails.
- Index sizes from `/v1/images/stats/`: Flickr 536M, Wikimedia 89M, Europeana 13.8M, Smithsonian NMNH 5.0M,
  rawpixel 1.3M, Met 0.5M, svgsilh 0.36M.

Proposed behaviour (vanilla JS module `core/templates/openverse.js`):
1. Search box per kind, with preset queries ("mannequin pose walking", "costume plate 1920s", "warehouse interior",
   "vintage microphone"). The default filter is `license=cc0,pdm`. A "Show CC BY" toggle switches to
   `license_type=commercial,modification` and makes the attribution string mandatory in the project.
2. Debounce typing, cache results in memory and sessionStorage, and read the rate-limit headers. When a 429 arrives,
   show "Openverse limit reached (20/min, 200/day), try again later".
3. Show `license`, `source` and `creator` on every tile. Hide results where `mature` is true or
   `unstable__sensitivity` is not empty.
4. On "Use", download the image into the user's project folder or OPFS together with a provenance JSON (`attribution`,
   `foreign_landing_url`, `license_url`, retrieval date), and add a reminder that the user should check the licence on
   the landing page (Openverse's own disclaimer).
5. People filter: for `kind=body|pose|face-angles`, add a warning banner whenever the result is a photograph ("A free
   licence does not cover the person's likeness. Use it as a pose or wardrobe guide, not as an identity."). PDM
   results include news and government photos of real public figures, for example.

Extra direct providers (also CORS `*`, no key): Poly Haven `https://api.polyhaven.com/assets?t=hdris|models&categories=...`
and `/files/<id>` (tonemapped JPG, backplates, glTF). Wikimedia Commons `api.php?...&origin=*` with
`generator=search` and `prop=imageinfo&iiprop=url|extmetadata` (filter on `LicenseShortName`). Both keep the "nothing
stored on our host" rule: the browser fetches straight into the user's project.

## 5. How each kind feeds the edit models

| kind | role | Suggested request (references in order) |
|---|---|---|
| body turnaround | layout and proportions guide | [turnaround] + description: "Create a character identity sheet with the same four views and scale as image 1: [description]. Photographic, neutral grey background, even studio light." |
| pose (clay) | pose guide | [identity sheet, pose]: "Same person as image 1, in exactly the pose of image 2. Photographic, not a mannequin." |
| pose (OpenPose) | ControlNet input | Only for ControlNet endpoints. Instruction editors get the clay image. |
| face-angles | angle guide | [identity, head sheet]: "Turn the head of image 1 to the 3/4 angle shown second in image 2." |
| expressions | expression guide | [identity, Le Brun]: "Give image 1 the facial expression of image 2 (terror, mouth open); keep identity and style." |
| garment flat | wardrobe design | [identity, flat, optional colour sketch]: "Dress the character in the garment of image 2, oversized fit, washed black cotton." |
| location | environment guide or plate | [location]: "Use image 1 as the location: same architecture and light, golden hour, no people." |
| prop | object reference | [scene, prop]: "Place the boombox of image 2 on the bench, scale realistic." |

## 6. Fallback: generate a neutral base with the user's key

When the catalogue and Openverse do not have the right base (for example a 70-year-old heavy-set man, or a
wheelchair user), the app offers a generation request. It goes through the normal approve-before-spend flow and uses
the user's fal key, never ours. Templates (`{}` = filled by the UI):

1. **Mannequin turnaround**: "Character turnaround reference sheet of a neutral artist's mannequin with {body:
   build, height, age proportions}, smooth matte light-grey surface, no face features, no clothes, no hair. Four views
   left to right: front, three-quarter, side profile, back. Same scale, feet on one baseline, relaxed A-pose, arms 30
   degrees from the body. Plain white background, soft even studio light, orthographic look, no text."
2. **Neutral person base (synthetic)**: "Turnaround sheet of a fictional {age} {gender presentation} person with {build},
   {skin tone}, {hair}, wearing plain grey fitted base layers. Four views: front, 3/4, side, back. Neutral expression.
   Photographic, studio grey background, even light, full body visible, feet on one baseline. Not a real or famous
   person." Then say "Keep the identity of image 1" in every later edit.
3. **Pose from base**: "Same figure as image 1, now {pose: e.g. sitting on a low wall, leaning forward, elbows on knees},
   camera {angle}, same lighting and background."
4. **Expression sheet**: "Expression sheet of the person in image 1, head and shoulders, 3x2 grid: neutral, joy,
   sadness, anger, fear, surprise. Same lighting, same angle, plain background."
5. **Garment flat**: "Fashion technical flat drawing of a {garment} with {details}, front view, black line art on white,
   no model, no shading, centred."
6. **Location plate**: "Empty {location} at {time of day}, {mood}, eye-level 35 mm view, no people, no text,
   photographic." Iterate with the sketch tool for layout.

Store each generated base as a project template with provenance `{"generated": true, "model": ..., "prompt": ...}` so
it can be reused in the same project. It is never uploaded to our host.

## 7. Open points

- Body variety is still narrow: 4 mannequin builds, 2 athletic bodies and the Dürer plates. The best upgrade is MPFB 2
  in Blender (CC0 core assets) rendered with the same pipeline: 10-20 bodies across age, weight and height.
- A few Poly Haven backplates could be added as genuine photo plates (6-17 MB originals, about 150 KB once resized).
- Openclipart was unreachable today. Check it again for CC0 garment outlines.
- If "common characters" are ever published (owner decision), use the same `catalog.json` format, licence fields and
  provenance rules.

## Sources (accessed 2026-10-04)

- Owner constraints: `docs/SPEC_v3_GUIDED.md` (stages 4-5), `docs/WEB_SERVICE_PLAN.md` ("Owner decision (2026-10-04)").
- Unsplash License: https://unsplash.com/license
- Pexels License: https://www.pexels.com/license/
- Pixabay Content License summary: https://pixabay.com/service/license-summary/
- Poly Haven license: https://polyhaven.com/license ; API: https://api.polyhaven.com/assets , https://api.polyhaven.com/files/wide_street_01
- ambientCG license: https://docs.ambientcg.com/license/
- Openverse API: https://api.openverse.org/v1/ ; stats: https://api.openverse.org/v1/images/stats/ ; "Made with Openverse" and the licence disclaimer: https://docs.openverse.org/api/reference/made_with_ov.html
- Quaternius Universal Animation Library: https://quaternius.com/packs/universalanimationlibrary.html , https://opengameart.org/content/universal-animation-library , https://quaternius.itch.io/universal-animation-library
- Quaternius Universal Base Characters: https://quaternius.itch.io/universal-base-characters
- MakeHuman / MPFB licence FAQ: https://static.makehumancommunity.org/mpfb/faq/can_i_sell_models.html , https://static.makehumancommunity.org/mpfb/faq/use_in_closed_source.html , https://static.makehumancommunity.org/about/license.html
- FFHQ licence (CC BY-NC-SA 4.0): https://github.com/NVlabs/ffhq-dataset ; Microsoft Face Synthetics: https://github.com/microsoft/FaceSynthetics
- Wikimedia Commons files used (Met Open Access, CC0): Dürer *Vier Bücher von menschlicher Proportion* MET DP816815-DP816819; Le Brun/Sayer *Heads Representing the Various Passions of the Soul* MET DP854025-DP854030; *The Expressions* MET 272508; *Studies of Hands* MET DP805345, DP807248, DP807715; *Study of the Forearms and Hands of a Woman* MET DP320154 (full URLs per item in `catalog/LICENSES.md`).
- fal Nano Banana 2 edit (up to 14 reference images): https://fal.ai/models/fal-ai/nano-banana-2/edit/examples , https://modelgrep.com/media/models/fal-ai/nano-banana-2/edit
- Openclipart (unreachable on 2026-10-04): https://openclipart.org/
