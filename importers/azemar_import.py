"""EXAMPLE importer: the owner's own music video ("azemar.exe") -> the workbench's project files (data/azemar/).

It is kept as a worked example of how a real production maps onto the file formats (song.json with word timings,
storyboard shots.json + clip uses from an EDL, entities with looks, media.json with thumbnails, costs). It only runs
with that production's private folders next to the workbench; for your own song start with importers/new_project.mjs.

Run with a Python that has numpy + soundfile:
    python importers/azemar_import.py [--no-peaks] [--no-thumbs] [--reset-state]
    AZEMAR_BASE=<folder that holds project/, resources/, character-lab/>   (default: the workbench's parent folder)

Reads project/ and resources/ (read only). Writes only under workbench/data/azemar/.
approvals.json and notes.json are created only if missing (the page and the agent edit them afterwards);
pass --reset-state to overwrite them with the initial state.
All times in the output are integer milliseconds. Media paths starting with "project/" or "resources/" are
relative to the base folder (served by serve.mjs at /media/<path>); other paths are relative to the data folder.
"""
import base64, json, os, re, subprocess, sys, datetime
from collections import Counter, OrderedDict

WB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.abspath(os.environ.get('AZEMAR_BASE') or os.path.dirname(WB))
OUT = os.path.join(os.environ.get('WORKBENCH_DATA') or os.path.join(WB, 'data'), 'azemar')
FINAL = os.path.join(BASE, 'project', 'audio', 'out', 'final')
ARGS = set(sys.argv[1:])
NOW = datetime.datetime.now().isoformat(timespec='seconds')


def P(*a): return os.path.join(BASE, *a)
def ms(s): return int(round(float(s) * 1000))
def load(p): return json.load(open(p, encoding='utf-8'))
def rel(p): return os.path.relpath(p, BASE).replace('\\', '/')


def dump(name, obj, only_if_missing=False):
    path = os.path.join(OUT, name)
    if only_if_missing and os.path.exists(path) and '--reset-state' not in ARGS:
        print('keep', name); return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    print('wrote', name, os.path.getsize(path), 'B')


# ---------------------------------------------------------------- song
sec_doc = load(os.path.join(FINAL, 'sections.json'))
grid = load(os.path.join(FINAL, 'grid.json'))
words = load(os.path.join(FINAL, 'words.json'))
events = load(os.path.join(FINAL, 'events.json'))
env = load(os.path.join(FINAL, 'envelope.json'))
shots_doc = load(P('project', 'shots.json'))
DUR = ms(shots_doc['duration'])
treat = open(P('project', 'TREATMENT.md'), encoding='utf-8').read()

# TREATMENT section 3: world/screen split and overload per section
sec_rows = {}
for row in re.findall(r'^\| ([A-Z][^|]+?) \| ([\d.]+) – ([\d.]+) \| (\d+) / (\d+) \| ([^|]*) \| ([^|]*) \|$', treat, re.M):
    nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', row[6])]
    sec_rows[round(float(row[1]), 1)] = {'world_pct': int(row[3]), 'screen_pct': int(row[4]), 'transitions': row[5].strip(),
                                         'overload': [nums[0], nums[-1]] if nums else None, 'overload_text': row[6].strip()}

sections = []
for s in sec_doc['sections']:
    r = sec_rows.get(round(s['start'], 1), {})
    sections.append({'id': s['id'], 'label': s['label'], 't0': ms(s['start']), 't1': ms(s['end']),
                     'startBar': s['startBar'], 'endBar': s['endBar'], 'energy': s['energy'], 'rms_db': s['rms_db'], **r})

lines = OrderedDict()
for w in words:
    key = f"{w['section']}/{w['line']}"
    L = lines.setdefault(key, {'id': key, 'section': w['section'], 'idx': w['line'], 'kind': w['kind'], 'words': [], 'voices': Counter()})
    L['words'].append({'w': w['word'], 't0': ms(w['start']), 't1': ms(w['end']), 'p': round(w.get('p', 1) or 0, 3)})
    L['voices'][w.get('voice') or 'none'] += 1
line_list = []
for L in lines.values():
    ws = L.pop('words'); v = L.pop('voices')
    # words monotone inside the line
    for i in range(1, len(ws)):
        ws[i]['t0'] = max(ws[i]['t0'], ws[i - 1]['t0'])
    line_list.append({**L, 'voice': v.most_common(1)[0][0], 't0': ws[0]['t0'], 't1': max(x['t1'] for x in ws),
                      'text': ' '.join(x['w'] for x in ws), 'words': ws})
line_list.sort(key=lambda l: l['t0'])

song = {
    'title': 'One More Epoch (azemar.exe)', 'duration_ms': DUR, 'bpm': grid['bpm'], 'beat_ms': grid['beat_s'] * 1000,
    'bar_ms': grid['bar_s'] * 1000, 'beats_per_bar': grid['beats_per_bar'],
    'grid': {'beats': [ms(b) for b in grid['beats']], 'downbeats': [ms(b) for b in grid['downbeats']],
             'irregular_bars': grid.get('irregular_bars', {})},
    'audio': {'mix': 'resources/song/One More Epoch (azemar.exe) (Edit).wav',
              'render': 'project/clip/renders/azemar-exe-v1.mp4',
              'stems': [{'id': k, 'label': lab, 'audio': f'resources/song/stems/One More Epoch (azemar.exe) (Edit) ({lab}).wav', 'peaks': f'peaks/{k}.json'}
                        for k, lab in [('vocals', 'Vocals'), ('backing', 'Backing Vocals'), ('bass', 'Bass'), ('drums', 'Drums')]]},
    'sections': sections, 'lines': line_list,
}
dump('song.json', song)

# events (drop the kinds other columns already show)
dump('events.json', [{'id': e['id'], 't': ms(e['t']), 'kind': e['kind'], 'note': e.get('note', '')} for e in events])

# energy curve (rms + per-stem envelopes at 24 fps, 2 decimals)
dump('energy.json', {'fps': env['fps'], 'rms': [round(x, 2) for x in env['rms']], 'onset': [round(x, 2) for x in env['onset']]})


# ---------------------------------------------------------------- script (TREATMENT section 2)
def nearest_line(t):
    return min(line_list, key=lambda l: abs(l['t0'] - t))['id']

sec2 = treat.split('## 2. Lyrics line by line')[1].split('## 3.')[0]
script = []
for m in re.finditer(r'^\| ([\d.]+)([^|]*?) \| (.*?) \| (W→S|W|S|B) \| (.*?) \|$', sec2, re.M):
    t0 = ms(m.group(1)); rest = m.group(2)
    t1m = re.search(r'–\s*([\d.]+)', rest)
    item = {'id': f's{len(script) + 1:02d}', 't0': t0, 'lyric': m.group(3).strip(), 'mode': m.group(4), 'action': m.group(5).strip(),
            'line_id': nearest_line(t0)}
    if t1m: item['t_end'] = ms(t1m.group(1))
    script.append(item)
script.sort(key=lambda s: s['t0'])
stages = [{'name': m.group(1), 't0': ms(m.group(2)), 't1': ms(m.group(3)), 'text': m.group(4)}
          for m in re.finditer(r'^\| (\d [A-Za-z ]+?) \| ([\d.]+) – ([\d.]+) \| (.*?) \|$', treat, re.M)]
dump('script.json', {'source': 'project/TREATMENT.md section 2', 'stages': stages, 'lines': script})


# ---------------------------------------------------------------- shots (storyboard) + clip uses (EDL)
STILL = {'G01': 'I1', 'G02': 'I2', 'G03': 'I3', 'G04': 'I4', 'G05': 'I5', 'G06': 'I11', 'G07': 'I7', 'G08': 'I7', 'G09': 'I10', 'G10': 'I5',
         'G11': 'I8', 'G12': 'I8', 'G13': 'I14', 'G14': 'I13', 'G15': 'I9', 'G16': 'I16', 'G17': 'I10', 'G18': 'I5', 'G19': 'I7', 'G20': 'I15', 'G21': 'I17'}
HER_CLIPS = {'G14', 'G15', 'G16', 'G21'}
LOC_OF_STILL = {'I1': 'B', 'I2': 'M', 'I17': 'M', 'I3': 'C', 'I4': 'C', 'I12': 'C', 'I13': 'C', 'I14': 'C', 'I16': 'C',
                'I5': 'D', 'I6': 'D', 'I7': 'D', 'I8': 'D', 'I9': 'D', 'I10': 'D', 'I11': 'D', 'I15': 'D'}
sec5 = treat.split('## 5.')[1].split('## 6.')[0]
def ids_in(label):
    seg = sec5.split(label)[1].split('\n- **')[0]
    out = set(re.findall(r'c\d-[a-z0-9]+(?:–[a-z0-9]+)?', seg))
    res = set()
    for x in out:
        m = re.match(r'(c\d-[a-z]+)(\d)–(\d)', x) or re.match(r'(c\d-[a-z]+\d?)([a-z])–([a-z])', x)
        if m and m.group(2).isdigit():
            res |= {f'{m.group(1)}{i}' for i in range(int(m.group(2)), int(m.group(3)) + 1)}
        elif m:
            res |= {f'{m.group(1)}{chr(c)}' for c in range(ord(m.group(2)), ord(m.group(3)) + 1)}
        else:
            res.add(x)
    return res
KIND = {}
for k in ids_in('**Stay on screen'): KIND[k] = 'screen'
for k in ids_in('**Split world/screen'): KIND[k] = 'split'
for k in ids_in('**Become world shots'): KIND[k] = 'world'

edl_path = os.path.join(OUT, '_src', 'edl.json')
edl = load(edl_path) if os.path.exists(edl_path) else []
seen = set(); uses = []
for u in sorted(edl, key=lambda u: (u['start'], u['id'])):
    k = (u['id'], round(u['start'], 3), round(u['in'], 2), u['take'])
    if k in seen: continue
    seen.add(k)
    t0, t1 = ms(u['start']), ms(u['end'])
    if t1 - t0 < 1: t1 = t0 + 448  # zero-length uses (a one-frame insert) get one beat so they stay visible
    uses.append({'id': f"{u['id']}@{t0}", 'clip': u['id'], 't0': t0, 't1': t1, 'in_ms': ms(u['in']), 'take': u['take'],
                 'label': u['label'], 'file': f"project/gen/out/{u['id']}/{u['id']}_{u['take']}.mp4",
                 'start_image': f"project/gen/out/{STILL[u['id']]}/{STILL[u['id']]}_0_0.png", 'location': LOC_OF_STILL[STILL[u['id']]],
                 'thumb': f"thumbs/use_{u['id']}_{u['take']}_{ms(u['in'])}.jpg"})


def cast_of(chars):
    ids = set()
    for c in chars:
        tag = c.split(':')[0]
        if tag.startswith('D'): ids.add('dani')
        elif tag.startswith('H'): ids.add('her')
        for m in re.finditer(r'A(\d)(?:-A(\d))?', tag):
            a, b = int(m.group(1)), int(m.group(2) or m.group(1))
            ids |= {f'avatar-a{i}' for i in range(a, b + 1)}
    return ids

shots = []
for s in shots_doc['shots']:
    t0, t1 = ms(s['t0']), ms(s['t1'])
    inside = [u for u in uses if u['t0'] < t1 and u['t1'] > t0]
    cast = cast_of(s['characters'])
    for u in inside:
        cast.add('her' if u['clip'] in HER_CLIPS else 'dani')
        if u['clip'] == 'G20': cast |= {'her', 'dani'}
    locs = sorted({u['location'] for u in inside})
    shots.append({'id': s['id'], 't0': t0, 't1': t1, 'section': s['section'], 'kind': KIND.get(s['id'], 'screen'),
                  'title': (s.get('windows') or '')[:140], 'device': s.get('device', ''), 'transition': s.get('transition', ''),
                  'note': s.get('note', ''), 'lines': [l['key'] for l in s.get('lines', [])],
                  'characters_raw': s['characters'], 'cast': sorted(cast), 'locations': locs,
                  'clips': [u['id'] for u in inside], 'render_frame_ms': (t0 + t1) // 2,
                  'thumb': f"thumbs/shot_{s['id']}.jpg", 'render': song['audio']['render']})
dump('shots.json', {'source': 'project/shots.json (storyboard) + clip EDL extracted from project/clip/xp/ch*.js',
                    'shots': shots, 'uses': uses})

# ---------------------------------------------------------------- jobs, costs
jobs = {}
for f in ['jobs_v1.json', 'jobs_v2.json']:
    d = load(P('project', 'gen', f))
    for j in (d['jobs'] if isinstance(d, dict) else d): jobs[j['id']] = j
for d in sorted(os.listdir(P('project', 'gen', 'out'))):
    jp = P('project', 'gen', 'out', d, 'job.json')
    if os.path.exists(jp) and d not in jobs: jobs[d] = load(jp)['job']
outs = {d: sorted(os.listdir(P('project', 'gen', 'out', d))) for d in os.listdir(P('project', 'gen', 'out'))}

ledger = []
for raw in open(P('project', 'LEDGER.md'), encoding='utf-8'):
    c = [x.strip() for x in raw.strip().strip('|').split('|')]
    if len(c) != 6 or not re.match(r'\d{4}-\d\d-\d\d', c[0]): continue
    usd = re.search(r'[\d.]+', c[4])
    row = {'date': c[0], 'phase': c[1], 'tool': c[2], 'items': c[3], 'usd': float(usd.group()) if usd else None, 'running': c[5]}
    jid = re.match(r'fal (\S+) via falgen', c[2])
    if jid: row['job'] = jid.group(1)
    ledger.append(row)

first_use = {}
for u in uses: first_use.setdefault(u['clip'], u['t0'])
for g, st in STILL.items():
    if g in first_use: first_use[st] = min(first_use.get(st, 10 ** 9), first_use[g])
for s in shots:
    for c in s['characters_raw']:
        for tag in re.findall(r'\b([DH]\d)\b', c): first_use.setdefault(tag, s['t0'])
    for a in s['cast']:
        if a.startswith('avatar-a'): first_use.setdefault('A' + a[-1], s['t0'])
first_use.setdefault('I12', 48814); first_use.setdefault('I6', 104336)  # stills with code parallax (TREATMENT 4)
first_use.setdefault('H0', first_use.get('G15', 0)); first_use.setdefault('H0s', first_use.get('G15', 0))
cost_items = []
for r in ledger:
    if r.get('job') and r['usd'] is not None:
        cost_items.append({'id': r['job'], 't': first_use.get(r['job'], 0), 'usd': r['usd'], 'tool': r['tool'], 'date': r['date']})
cost_items.sort(key=lambda c: c['t'])
dump('costs.json', {'cap_usd': 70, 'source': 'project/LEDGER.md',
                    'fal_total_usd': load(P('project', 'gen', 'spent.json'))['total'],
                    'pre_production': [r for r in ledger if not r.get('job')], 'items': cost_items, 'ledger': ledger})

# ---------------------------------------------------------------- entities
def img(i, take='0_0'): return f'project/gen/out/{i}/{i}_{take}.png'
def short_of(eid): return 'D' if eid == 'dani' else 'H' if eid == 'her' else eid.replace('avatar-a', 'A')
def ent(kind, eid, **kw):
    e = {'id': eid, 'kind': kind, 'status': 'approved' if kw.get('refs') else 'draft', **kw}
    if kind == 'character': e['short'] = short_of(eid)   # cast-chip label
    e['thumb'] = f'thumbs/ent_{eid}.jpg' if e.get('thumb_src') else None
    dump(f'entities/{kind}s/{eid}.json', e)
    return e

ENT = []
ENT.append(ent('character', 'dani', name='Dani', role='the lead; the man at the beige CRT',
               private_refs=['project/gen/refs/dani_full_green.png', 'project/gen/refs/dani_face.png', 'project/gen/refs/dani_heads.png'],
               refs=['character-lab/base/dani_base_front.png', 'character-lab/outputs/a_basics/fal-seedream5/fal-seedream5__heads3x3__20261004-023029__1.png',
                     'character-lab/outputs/b_variations/fal-seedream5/fal-seedream5__start_green_day__20261004-033919__1.png'],
               thumb_src=img('I7'), notes='Refs folder is PRIVATE (crops of real photos): never publish. Stage-a hero from character-lab.',
               identity='rounder face, solid build, messy curls; same person in every reference', color='#6aa9ff'))
ENT.append(ent('character', 'her', name='HER', role='his android female version; physical in the world from verse 4 (139.84)',
               refs=[img('H0'), img('H0s')], thumb_src=img('I9'), identity='cyan jaw seam, camera-ring irises', color='#ff7ab8'))
AV = {1: 'hoodie hacker (desk, green glow)', 2: 'DJ (dark bedroom, red light)', 3: 'painter (bathroom mirror)', 4: 'lab rat (corridor maze)',
      5: 'chef (espresso machine)', 6: 'office boxers (corridor)', 7: 'cosmologist (night office window)', 8: 'account picture (welcome tile, chat)'}
# storyboard A6 = office boxers (generated as still I14), A7 = cosmologist (generated as job "A6")
AV_JOB = {1: 'A1', 2: 'A2', 3: 'A3', 4: 'A4', 5: 'A5', 6: 'I14', 7: 'A6'}
for i, d in AV.items():
    j = AV_JOB.get(i); has = j in outs
    ENT.append(ent('character', f'avatar-a{i}', name=f'Avatar A{i}', role=d, refs=[img(j), img(j, '0_1')] if has else [],
                   thumb_src=img(j) if has else None, color='#c9a227', life_of='dani', job=j))
for k, lab in [('D1', 'groove loop'), ('D2', 'comic loop'), ('D3', 'celebration loop'), ('H1', 'HER groove loop')]:
    ENT.append(ent('character', k.lower(), name=f'{k} dancer', role=lab + ' (desktop-dancer kit, motion transfer)',
                   refs=[f'project/gen/out/{k}/{k}_0.mp4'] if k in outs else [], thumb_src=f'project/gen/out/{k}/{k}_0.mp4' if k in outs else None, color='#8f8f8f'))
LOCS = {'B': ('bedroom', 'his dark bedroom (a DJ controller on the shelf)', ['I1']),
        'M': ('bathroom', 'his bathroom (sink and mirror, framed over the shoulder)', ['I2', 'I17']),
        'D': ('desk', 'office desk: beige CRT and tower, ball mouse, lamp, a microchip dev board, glass office behind', ['I5', 'I7', 'I6', 'I8', 'I9', 'I10', 'I11', 'I15']),
        'C': ('corridor', 'office corridor: glass entrance, glass meeting rooms, a row of desks, an espresso machine', ['I12', 'I3', 'I4', 'I13', 'I14', 'I16'])}
for letter, (eid, desc, ims) in LOCS.items():
    ENT.append(ent('location', eid, letter=letter, name=f'{letter} · {eid}', description=desc,
                   refs=[img(i) for i in ims if i in outs], start_images=ims, thumb_src=img(ims[0])))
PROPS = [('esp32-board', 'ESP32 prototype board', 'custom unbranded PCB, ESP32 module under a plain shield, 0.96" OLED, 8 LEDs, sensor breakouts, jumper wires; boots itself at 26.875', ['I11']),
         ('espresso-machine', 'Espresso machine', 'chrome machine on a white counter in the corridor; 8 a.m. pour (15.68), her role swap (170.60)', ['I4', 'I16']),
         ('beige-crt', 'Beige CRT + tower', 'the only retro machine in a modern glass office; screens are a plain blue-grey glow, UI composited later', ['I5', 'I7']),
         ('ball-mouse', 'Ball mouse', 'match cuts mouse to cursor (34.49, 41.65)', ['I5']),
         ('office-chair', 'Office chair', 'rolls away on its own (45.232); HER sits in it from 139.84', ['I10', 'I9']),
         ('desk-lamp', 'Desk lamp', 'dims at night (93.59)', ['I8']),
         ('bathroom-mirror', 'Bathroom mirror', 'the welcome screen (10.756); the swap to HER (152.10)', ['I2', 'I17']),
         ('dj-controller', 'DJ controller', 'on the bedroom shelf; DJ avatar A2', ['I1'])]
for eid, name, desc, ims in PROPS:
    ENT.append(ent('prop', eid, name=name, description=desc, refs=[img(i) for i in ims if i in outs], thumb_src=img(ims[0])))

# ---------------------------------------------------------------- notes (Dani, pinned to line times)
notes = []
ntxt = open(P('project', 'NOTES_treatment_dani.md'), encoding='utf-8').read()
def norm(s): return re.sub(r'[^a-z0-9 ]', '', s.lower())
for m in re.finditer(r'^- "(.+?)"(?: \(BLEEP [^)]*\))? -> "(.+)"$', ntxt, re.M):
    lyric = norm(m.group(1))
    L = next((l for l in line_list if norm(l['text']).startswith(lyric[:18])), None)
    notes.append({'id': f'n{len(notes) + 1:02d}', 't': L['t0'] if L else 0, 'line_id': L['id'] if L else None, 'by': 'dani',
                  'text': m.group(2).replace('\\"', '"'), 'about': m.group(1), 'status': 'open', 'at': '2026-10-04',
                  'source': 'project/NOTES_treatment_dani.md'})
v2 = next(s for s in sections if s['id'] == 'verse2')
notes.append({'id': f'n{len(notes) + 1:02d}', 't': v2['t0'], 'line_id': None, 'by': 'dani', 'status': 'open', 'at': '2026-10-04',
              'text': 'just keep going with what you think. Short clips, rythmic, an history, etc. Pc, real world, etc.',
              'about': 'Verse 2 onwards', 'source': 'project/NOTES_treatment_dani.md'})
ans = re.search(r'## Answers.*?\n"(.+?)"\n', ntxt, re.S)
if ans:
    notes.append({'id': f'n{len(notes) + 1:02d}', 't': 0, 'line_id': None, 'by': 'dani', 'status': 'open', 'at': '2026-10-04',
                  'text': ans.group(1).replace('\n', ' '), 'about': 'answers to the director questions (whole video)',
                  'source': 'project/NOTES_treatment_dani.md'})
dump('notes.json', {'rev': 1, 'notes': notes}, only_if_missing=True)

# ---------------------------------------------------------------- approvals (generated = approved, else draft)
items = {}
def st(key, state, why): items[key] = {'state': state, 'by': 'import', 'at': NOW, 'why': why}
for s in shots: st(f'shot:{s["id"]}', 'approved', 'rendered in azemar-exe-v1.mp4')
for u in uses: st(f'use:{u["id"]}', 'approved' if os.path.exists(P(u['file'])) else 'draft', 'clip file exists' if os.path.exists(P(u['file'])) else 'no clip file')
for jid in sorted(jobs):
    st(f'job:{jid}', 'approved' if outs.get(jid) and any(not f.endswith('.json') for f in outs[jid]) else 'draft', 'generated' if outs.get(jid) else 'not generated')
for e in ENT: st(f'{e["kind"]}:{e["id"]}', e['status'], 'has generated refs' if e['status'] == 'approved' else 'no refs yet')
for s in script: st(f'script:{s["id"]}', 'draft', 'treatment v1, not yet signed off')
dump('approvals.json', {'rev': 1, 'states': ['draft', 'review', 'changes', 'approved', 'locked'], 'items': items}, only_if_missing=True)

# ---------------------------------------------------------------- index of entities for the page
dump('entities/index.json', [{'id': e['id'], 'kind': e['kind'], 'name': e['name'], 'path': f'entities/{e["kind"]}s/{e["id"]}.json'} for e in ENT])

# ---------------------------------------------------------------- thumbnails (ffmpeg)
def ff(args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y'] + args, check=False)
if '--no-thumbs' not in ARGS:
    os.makedirs(os.path.join(OUT, 'thumbs'), exist_ok=True)
    render = P(song['audio']['render'])
    for s in shots:
        o = os.path.join(OUT, s['thumb'])
        if not os.path.exists(o): ff(['-ss', f"{s['render_frame_ms'] / 1000:.3f}", '-i', render, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '6', o])
    for u in uses:
        o = os.path.join(OUT, u['thumb'])
        if not os.path.exists(o) and os.path.exists(P(u['file'])):
            ff(['-ss', f"{u['in_ms'] / 1000 + 0.2:.3f}", '-i', P(u['file']), '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '6', o])
    for e in ENT:
        if e.get('thumb_src'):
            o = os.path.join(OUT, e['thumb'])
            if not os.path.exists(o): ff(['-ss', '1.0' if e['thumb_src'].endswith('.mp4') else '0', '-i', P(e['thumb_src']), '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '5', o])
    print('thumbs', len(os.listdir(os.path.join(OUT, 'thumbs'))))

# ---------------------------------------------------------------- media index + enriched entities (SPEC v2 sections 7-9)
# Every generated file -> media.json {kind, entities, shots, take, size, duration, thumb, strip, private}. Thumbnails
# (max 240 px; sheets 600 px) and 8-frame hover-scrub strips for videos go to thumbs/m_*.jpg, s_*.jpg; thumbnails of
# PRIVATE files (crops of real photos: project/gen/refs/, character-lab/refs/) are thumbs/priv_*.jpg and are never exported.
PRIVATE_RE = re.compile(r'^(project/gen/refs/|character-lab/refs/|character-lab/base/_green_compare)')
def is_private(p): return bool(PRIVATE_RE.match(p))
VIDEO_EXT, AUDIO_EXT, IMG_EXT = ('.mp4', '.webm', '.mov'), ('.wav', '.mp3', '.m4a'), ('.png', '.jpg', '.jpeg')
probe_path = os.path.join(OUT, '_src', 'probe.json')
probe_cache = load(probe_path) if os.path.exists(probe_path) else {}

def probe(p):
    st = os.stat(P(p)); key = f'{p}|{st.st_size}|{int(st.st_mtime)}'
    if key not in probe_cache:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', P(p)],
                           capture_output=True, text=True)
        j = json.loads(r.stdout or '{}'); s0 = (j.get('streams') or [{}])[0]; d = j.get('format', {}).get('duration')
        probe_cache[key] = {'w': s0.get('width'), 'h': s0.get('height'), 'dur': float(d) if d and p.lower().endswith(VIDEO_EXT + AUDIO_EXT) else None}
    return probe_cache[key], st.st_size

cost_of = {c['id']: c['usd'] for c in cost_items}
use_by_clip_take = {}
for u in uses: use_by_clip_take.setdefault((u['clip'], u['take']), []).append(u)
shot_of_use = {uid: s['id'] for s in shots for uid in s['clips']}
def shots_of_uses(us): return sorted({shot_of_use[u['id']] for u in us if u['id'] in shot_of_use}, key=lambda i: next(s['t0'] for s in shots if s['id'] == i))
def shots_with_cast(eid): return [s['id'] for s in shots if eid in s['cast']]
def shots_with_tag(tag): return [s['id'] for s in shots if any(c.split(':')[0].upper() == tag for c in s['characters_raw'])]
CLIPS_OF_STILL = {}
for g, st_ in STILL.items(): CLIPS_OF_STILL.setdefault(st_, []).append(g)
LOC_ID = {letter: eid for letter, (eid, _d, _i) in LOCS.items()}
STILL_CAST = {'I1': ['dani'], 'I2': ['dani'], 'I3': ['dani'], 'I5': ['dani'], 'I7': ['dani'], 'I8': ['dani'], 'I10': ['dani'],
              'I14': ['dani', 'avatar-a6'], 'I9': ['her'], 'I13': ['her'], 'I16': ['her'], 'I17': ['her'], 'I15': ['dani', 'her'],
              'A1': ['dani', 'avatar-a1'], 'A2': ['dani', 'avatar-a2'], 'A3': ['dani', 'avatar-a3'], 'A4': ['dani', 'avatar-a4'],
              'A5': ['dani', 'avatar-a5'], 'A6': ['dani', 'avatar-a7'], 'H0': ['her'], 'H0s': ['her']}
LOC_OF_STILL.update({'A1': 'D', 'A2': 'B', 'A3': 'M', 'A4': 'C', 'A5': 'C', 'A6': 'D'})
PROPS_OF_STILL = {}
for eid, _n, _d, ims in PROPS:
    for i in ims: PROPS_OF_STILL.setdefault(i, []).append(eid)
for i, eid in [('I5', 'esp32-board'), ('A5', 'espresso-machine'), ('A1', 'beige-crt'), ('I10', 'beige-crt'), ('A2', 'dj-controller'), ('A3', 'bathroom-mirror')]:
    PROPS_OF_STILL.setdefault(i, []).append(eid)
DANCER_TAG = {'dani-groove': 'D1', 'dani-comic': 'D2', 'dani-celebrate': 'D3', 'her-graceful': 'H1'}
picks = set(re.findall(r'outputs/\S+\.png', open(P('character-lab', 'base', 'PICKS.md'), encoding='utf-8').read()))
PARALLAX = {'I12': [48814, 84634, 197680, 210453], 'I6': [104336]}   # stills with code parallax (TREATMENT 4)
used_stills = {STILL[g] for (g, _t) in use_by_clip_take} | {'I12', 'I6'}

MEDIA, seen_ids = [], set()
def add_media(path, kind, label, entities=(), shot_ids=(), take=None, job=None, group=None, use_ids=(), extra=None):
    if not os.path.exists(P(path)): return None
    mid = re.sub(r'[^A-Za-z0-9_-]+', '-', os.path.splitext(os.path.basename(path))[0]).strip('-')
    if kind in ('sheet', 'variation'):
        mm = re.match(r'fal-(\w+?)__(\w+?)__\d{8}-(\d{6})__(\d)', os.path.basename(path))
        if mm: mid = f'cl-{mm.group(1)}-{mm.group(2)}-{mm.group(3)}-{mm.group(4)}'
    base_id, n = mid, 2
    while mid in seen_ids: mid = f'{base_id}-{n}'; n += 1
    seen_ids.add(mid)
    pr, size = probe(path)
    priv = is_private(path)
    m = {'id': mid, 'path': path, 'kind': kind, 'label': label, 'entities': sorted(set(entities)), 'shots': list(shot_ids), 'uses': list(use_ids),
         'take': take, 'job': job, 'group': group or kind, 'size': size, 'w': pr['w'], 'h': pr['h'],
         'duration_ms': ms(pr['dur']) if pr['dur'] else None, 'private': priv,
         'status': 'private' if priv else 'used' if shot_ids else 'picked' if path.replace('character-lab/', '') in picks else 'unused',
         'cost_usd': cost_of.get(job) if job else None, **(extra or {})}
    MEDIA.append(m)
    return m

out_dir = P('project', 'gen', 'out')
for d in sorted(os.listdir(out_dir), key=lambda x: (x[0], int(re.sub(r'\D', '', x) or 0), x)):
    for f in sorted(os.listdir(os.path.join(out_dir, d))):
        if f.endswith('.json'): continue
        path = f'project/gen/out/{d}/{f}'
        if d.startswith('G'):
            take = int(re.search(r'_(\d+)\.mp4$', f).group(1)); us = use_by_clip_take.get((d, take), [])
            st_ = STILL[d]
            add_media(path, 'clip', f'{d} take {take}', STILL_CAST.get(st_, []) + [LOC_ID[LOC_OF_STILL[st_]]] + PROPS_OF_STILL.get(st_, []) + (['her'] if d in HER_CLIPS else []),
                      shots_of_uses(us), take, d, d, [u['id'] for u in us], {'start_image': img(st_)})
        elif d.startswith('I') or d.startswith('A') or d.startswith('H0'):
            take = int(re.search(r'_0_(\d)\.png$', f).group(1))
            if d.startswith('A') or d == 'I14':
                av = [e for e in STILL_CAST.get(d, []) if e.startswith('avatar')]
                sh = shots_with_cast(av[0]) if av and take == 0 else []
                kind = 'avatar'
            elif d.startswith('H0'):
                sh, kind = [], 'body'
            else:
                us = [u for g in CLIPS_OF_STILL.get(d, []) for u in uses if u['clip'] == g] if take == 0 else []
                sh = shots_of_uses(us) if d in used_stills and take == 0 else []
                if d in PARALLAX and take == 0: sh = sorted(set(sh) | {s['id'] for s in shots for t in PARALLAX[d] if s['t0'] <= t < s['t1']}, key=lambda i: next(s['t0'] for s in shots if s['id'] == i))
                kind = 'still'
            if d == 'I14' and take == 0: sh = sorted(set(sh) | set(shots_of_uses([u for u in uses if u['clip'] == 'G13'])), key=lambda i: next(s['t0'] for s in shots if s['id'] == i))
            loc = LOC_OF_STILL.get(d)
            add_media(path, kind, f'{d} take {take}', STILL_CAST.get(d, []) + ([LOC_ID[loc]] if loc else []) + PROPS_OF_STILL.get(d, []), sh, take, d, d,
                      extra={'clips': CLIPS_OF_STILL.get(d, [])})
        elif re.match(r'[DH]\d$', d):
            add_media(path, 'motion', f'{d} motion clip', ['her' if d.startswith('H') else 'dani', d.lower()], shots_with_tag(d), 0, d, d)
for f in sorted(os.listdir(P('project', 'gen', 'motion'))):
    d = f.split('_')[0]
    add_media(f'project/gen/motion/{f}', 'motion-ref', f'{d} driving video (motion source)', [d.lower()], [], None, d, d)
for f in sorted(os.listdir(P('project', 'clip', 'assets', 'dancers'))):
    stem = f.split('.')[0].replace('sheetchk_', ''); tag = DANCER_TAG.get(stem)
    ents = ['her' if stem.startswith('her') else 'dani'] + ([tag.lower()] if tag else [])
    if f.endswith('.mp4'): add_media(f'project/clip/assets/dancers/{f}', 'dancer', f'{stem} dancer sprite (alpha)', ents, shots_with_tag(tag) if tag else [], None, tag, 'dancers')
    else: add_media(f'project/clip/assets/dancers/{f}', 'contact', f'{stem} sprite check sheet', ents, [], None, tag, 'dancers')
for f in sorted(os.listdir(P('project', 'clip', 'renders'))):
    path = f'project/clip/renders/{f}'
    if f.startswith('_') or not os.path.isfile(P(path)) or f.endswith('.log'): continue
    if f.endswith('.mp4'): add_media(path, 'render', f'render {f[:-4]}', [], [s['id'] for s in shots] if f == 'azemar-exe-v1.mp4' else [], None, None, 'renders',
                                     extra={'main': f == 'azemar-exe-v1.mp4'})
    else: add_media(path, 'contact', f'contact sheet {f[:-4]}', [], [], None, None, 'renders')
for f in sorted(os.listdir(P('project', 'gen'))):
    if re.match(r'(review_|rv_|her_faces).*\.jpg$', f):
        add_media(f'project/gen/{f}', 'contact', f'review sheet {f[:-4]}', ['her'] if 'her' in f else [], [], None, None, 'reviews')
for stage, kind in [('a_basics', 'sheet'), ('b_variations', 'variation')]:
    root = P('character-lab', 'outputs', stage)
    for model in sorted(os.listdir(root)):
        if not os.path.isdir(os.path.join(root, model)) or model == 'runs': continue
        for f in sorted(os.listdir(os.path.join(root, model))):
            sub = f.split('__')[1]
            add_media(f'character-lab/outputs/{stage}/{model}/{f}', kind, f'{sub} · {model.replace("fal-", "")} #{f[-5]}', ['dani'], [], None, None, sub,
                      {'model': model.replace('fal-', ''), 'sheet': sub, 'grid': 3 if sub in ('heads3x3', 'expressions', 'expressions_match') else 0})
    if os.path.exists(os.path.join(root, 'picker.jpg')): add_media(f'character-lab/outputs/{stage}/picker.jpg', 'contact', f'character-lab {stage} picker', ['dani'], [], None, None, 'character-lab')
for f in sorted(os.listdir(P('character-lab', 'base'))):
    if f.endswith(IMG_EXT):
        add_media(f'character-lab/base/{f}', 'sheet', {'dani_base_front.png': 'base identity (frontal, Dani\'s pick)'}.get(f, f'base {f[:-4]}'), ['dani'], [], None, None,
                  'base', {'model': 'seedream5', 'sheet': 'base', 'grid': 0})
for sub in ['clean', 'crops']:
    for f in sorted(os.listdir(P('character-lab', 'refs', sub))):
        add_media(f'character-lab/refs/{sub}/{f}', 'ref', f'identity ref {sub}/{f[:-4]}', ['dani'], [], None, None, 'lab-refs')
for f in sorted(os.listdir(P('project', 'gen', 'refs'))):
    if f.endswith(IMG_EXT): add_media(f'project/gen/refs/{f}', 'ref', f'identity ref {f[:-4]}', ['her' if f.startswith('her') else 'dani'], [], None, None, 'gen-refs')
add_media(song['audio']['mix'], 'audio', 'mix (wav)', [], [], None, None, 'audio')
for s_ in song['audio']['stems']: add_media(s_['audio'], 'audio', f'stem {s_["label"]}', [], [], None, None, 'audio')

# thumbnails + strips
TH = os.path.join(OUT, 'thumbs'); os.makedirs(TH, exist_ok=True)
EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
def box(n): return f'scale={n}:{n}:force_original_aspect_ratio=decrease,{EVEN}'
for m in MEDIA:
    pre = 'priv_' if m['private'] else 'm_'
    m['thumb'] = f'thumbs/{pre}{m["id"]}.jpg'
    o, src = os.path.join(OUT, m['thumb']), P(m['path'])
    isvid, isaud = m['path'].lower().endswith(VIDEO_EXT), m['path'].lower().endswith(AUDIO_EXT)
    if isvid and m['duration_ms']:
        m['strip'] = f'thumbs/s_{m["id"]}.jpg'; m['strip_n'] = 8
    if '--no-thumbs' in ARGS: continue
    pk = 'crop=iw:ih/2:0:0,' if m['kind'] == 'dancer' else ''   # dancer sprites pack colour over alpha (top/bottom)
    if pk: m['packed_alpha'] = 'top-bottom'
    size = 600 if m['kind'] == 'sheet' else 320 if m['kind'] in ('render', 'contact') else 240
    if not os.path.exists(o):
        if isaud: ff(['-i', src, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=240x48:colors=#6aa9ff', '-frames:v', '1', '-q:v', '5', o])
        elif isvid: ff(['-ss', f'{min(1.0, (m["duration_ms"] or 0) / 2000):.2f}', '-i', src, '-frames:v', '1', '-vf', pk + box(size), '-q:v', '5', o])
        else: ff(['-i', src, '-frames:v', '1', '-vf', box(size), '-q:v', '4' if m['kind'] == 'sheet' else '5', o])
    so = os.path.join(OUT, m.get('strip') or '_')
    if m.get('strip') and not os.path.exists(so):
        dur = m['duration_ms'] / 1000
        if dur <= 20:
            ff(['-i', src, '-vf', f'{pk}fps={8 / dur:.4f},scale=-2:68,tile=8x1', '-frames:v', '1', '-q:v', '6', so])
        else:
            tmp = []
            for k in range(8):
                t = os.path.join(TH, f'_tmp{k}.jpg'); tmp.append(t)
                ff(['-ss', f'{dur * (k + 0.5) / 8:.2f}', '-i', src, '-frames:v', '1', '-vf', 'scale=-2:68', '-q:v', '6', t])
            ff(['-i', os.path.join(TH, '_tmp%d.jpg'), '-vf', 'tile=8x1', '-frames:v', '1', '-q:v', '6', so])
            for t in tmp:
                if os.path.exists(t): os.remove(t)
# HER has no head sheet: a face crop of her identity full-body (H0 take 0)
her_face = 'thumbs/face_her.jpg'
if '--no-thumbs' not in ARGS and not os.path.exists(os.path.join(OUT, her_face)):
    ff(['-i', P(img('H0')), '-frames:v', '1', '-vf', 'crop=iw*0.36:iw*0.36:iw*0.32:ih*0.035,scale=240:-2', '-q:v', '4', os.path.join(OUT, her_face)])
with open(probe_path, 'w', encoding='utf-8') as f: json.dump(probe_cache, f)
dump('media.json', {'generated': NOW, 'private_rule': 'paths under project/gen/refs/ and character-lab/refs/ are crops of real photos: local only, never exported',
                    'count': len(MEDIA), 'by_kind': dict(Counter(m['kind'] for m in MEDIA)), 'items': MEDIA})

# ---------------------------------------------------------------- enrich entity files: faces, bodies, sheets, looks, motion, locations, props
by_path = {m['path']: m for m in MEDIA}
shot_t0 = {s['id']: s['t0'] for s in shots}
def where(shot_ids): return [{'shot': i, 't': shot_t0[i]} for i in shot_ids]
def look_cost(stills, clips): return round(sum(cost_of.get(x, 0) for x in list(stills) + list(clips)), 2)
def look(lid, name, garments, colors, stills, clips=(), extra_imgs=(), extra_shots=(), **kw):
    imgs = list(extra_imgs) + [img(i) for i in stills if i in outs]
    sh = set(extra_shots)
    for g in clips: sh |= set(shots_of_uses([u for u in uses if u['clip'] == g]))
    sh = sorted(sh, key=lambda i: shot_t0[i])
    return {'id': lid, 'name': name, 'garments': garments, 'colors': colors, 'images': imgs, 'clips': list(clips), 'stills': list(stills),
            'used': where(sh), 'status': 'approved' if sh else 'draft', 'cost_usd': look_cost(stills, clips), **kw}
def lab(sheet, model='seedream5', run='023029', n=0):
    return f'character-lab/outputs/a_basics/fal-{model}/fal-{model}__{sheet}__20261004-{run}__{n}.png'
OFFICE = ['dark-navy overshirt (open)', 'white t-shirt', 'charcoal chinos', 'white sneakers', 'lanyard']
OFFICE_C = ['#1c2541', '#f2f2ee', '#3b3e44', '#ffffff']
AV_LOOK = {1: ('hoodie', 'Hoodie hacker', ['black hoodie, hood up'], ['#111111', '#2fd36a'], 'A1'),
           2: ('dj', 'DJ', ['black t-shirt', 'big closed headphones'], ['#111111', '#c0202a'], 'A2'),
           3: ('painter', 'Painter', ["paint-splattered white artist's smock", 'floppy black beret', 'paintbrush + palette'], ['#f4f1ea', '#111111', '#1f4fd1'], 'A3'),
           4: ('lab-rat', 'Lab rat', ['white lab coat', 'grey hoodie with mouse ears, hood up'], ['#f5f5f5', '#8a8d91', '#f2c230'], 'A4'),
           5: ('chef', 'Chef', ["white chef's whites", 'tall white toque', 'white cloth on the shoulder'], ['#fafafa'], 'A5'),
           6: ('office-boxers', 'Office boxers', ['dark-navy overshirt (open)', 'white t-shirt', 'light-blue polka-dot boxer shorts', 'white socks pulled up', 'white sneakers', 'lanyard'], ['#1c2541', '#9cc7f0', '#ffffff'], 'I14'),
           7: ('cosmologist', 'Cosmologist', ['brown tweed jacket with elbow patches', 'dark turtleneck', 'round wire-rimmed glasses', 'brass telescope'], ['#7a5a3a', '#1a1a1a', '#c9a227'], 'A6')}
dani_looks = [
    look('office-day', 'Office day (base look)', OFFICE, OFFICE_C, ['I5', 'I7', 'I10', 'I3', 'I8', 'I15'],
         ['G03', 'G05', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G17', 'G18', 'G19', 'G20'],
         extra_imgs=['character-lab/outputs/b_variations/fal-seedream5/fal-seedream5__start_green_day__20261004-033919__1.png',
                     'character-lab/outputs/b_variations/fal-seedream5/fal-seedream5__start_green_day__20261004-033919__0.png'],
         extra_shots=[s for t in ['D1', 'D2', 'D3'] for s in shots_with_tag(t)], base=True, note='also the dancer outfit (D1-D3 motion clips)'),
    look('sleep-tee', 'Sleep t-shirt', ['plain grey sleep t-shirt', 'messy pillow hair'], ['#8d9096'], ['I1', 'I2'], ['G01', 'G02'], variant_of='office-day'),
    look('studio-tee', 'Studio sheet (identity)', ['dark-grey t-shirt', 'dark jeans', 'white sneakers'], ['#3a3a3c', '#1f2a3a', '#ffffff'], [], [],
         extra_imgs=[lab('turnaround', n=0), lab('turnaround', n=1), lab('hero', 'nb2', n=0), lab('hero', 'nb2', n=1)], note='character-lab identity sheets; not on the timeline'),
]
for i, (lid, nm, gar, col, job) in AV_LOOK.items():
    dani_looks.append(look(lid, nm, gar, col, [job], ['G13'] if i == 6 else [], extra_shots=shots_with_cast(f'avatar-a{i}'), avatar=f'avatar-a{i}', variant_of='office-day' if i == 6 else None))
her_looks = [
    look('office-day', 'Office day (same outfit as him)', OFFICE[:4], OFFICE_C, ['H0', 'H0s', 'I9', 'I13', 'I16', 'I15'], ['G14', 'G15', 'G16', 'G20'],
         extra_shots=shots_with_tag('H1'), base=True, note='also the dancer outfit (H1)'),
    look('sleep-tee', 'Sleep t-shirt', ['plain grey sleep t-shirt'], ['#8d9096'], ['I17'], ['G21'], variant_of='office-day'),
]
def motion_of(tags):
    out_ = []
    for t in tags:
        dn = next((k for k, v in DANCER_TAG.items() if v == t), None)
        out_.append({'id': t, 'name': {'D1': 'groove', 'D2': 'comic', 'D3': 'celebration', 'H1': 'graceful groove'}[t], 'clip': f'project/gen/out/{t}/{t}_0.mp4',
                     'dancer': f'project/clip/assets/dancers/{dn}.alpha.mp4' if dn else None, 'source': f'project/gen/motion/{t}_ref.mp4', 'used': where(shots_with_tag(t)),
                     'cost_usd': cost_of.get(t)})
    return out_
E = {e['id']: e for e in ENT}
E['dani'].update(face='character-lab/base/dani_base_front.png', body=dani_looks[0]['images'][0],
                 sheets={'angles': [lab('heads3x3', n=1), lab('heads3x3', n=0), lab('heads3x3', 'nb2', n=0), lab('heads3x3', 'nb2', n=1)],
                         'expressions': [lab('expressions', n=1), lab('expressions_match', run='031434', n=0), lab('expressions', n=0), lab('expressions_match', 'nb2', '031434', 0),
                                         lab('expressions', 'nb2', n=0), lab('expressions', 'nb2', n=1), lab('expressions_match', 'nb2', '031434', 1)],
                         'turnaround': [lab('turnaround', n=0), lab('turnaround', n=1)], 'hero': [lab('hero', 'nb2', n=0), lab('hero', 'nb2', n=1)]},
                 looks=dani_looks, motion=motion_of(['D1', 'D2', 'D3']), lives=[f'avatar-a{i}' for i in range(1, 9)],
                 identity='broad, fairly round face, full cheeks; dense dark-brown tight curls; short full beard; hazel-green eyes; heavy dark eyebrows; solid average build',
                 picks='character-lab/base/PICKS.md')
E['her'].update(face=her_face, body=img('H0'), sheets={'faces': ['project/gen/her_faces.jpg'], 'full body': [img('H0'), img('H0', '0_1'), img('H0s'), img('H0s', '0_1')]},
                looks=her_looks, motion=motion_of(['H1']),
                identity='his android female version: same family face, no beard, tight curls to the jaw; cyan-lit jaw seam, camera-ring irises, temple panel line')
for i, (lid, nm, gar, col, job) in AV_LOOK.items():
    a = E[f'avatar-a{i}']; lk = next(l for l in dani_looks if l['id'] == lid)
    a.update(name=f'A{i} · {nm}', face=img(job), body=img(job), looks=[lk], look=lid, life_of='dani')
E['avatar-a8'].update(name='A8 · Account picture', looks=[], life_of='dani')
for t in ['d1', 'd2', 'd3', 'h1']:
    E[t].update(motion=motion_of([t.upper()]), life_of='her' if t == 'h1' else 'dani', face=None, body=None)
LOC_IMAGES = {'desk': [('I5', 'master', '8 a.m.'), ('I6', 'master (empty chair)', '8 a.m.'), ('I8', 'master', 'late night'), ('A1', 'master', 'night, green glow'),
                       ('I7', 'close-up by the monitor', 'day'), ('I9', 'close-up by the monitor', 'day'), ('I10', 'wide, standing', '8 a.m.'),
                       ('I11', 'macro on the board', '8 a.m.'), ('I15', 'front, two chairs', 'night'), ('A6', 'night window', 'night')],
              'corridor': [('I12', 'one-point (empty)', '8 a.m.'), ('I3', 'entrance door', '8 a.m.'), ('I13', 'one-point', 'morning'), ('I14', 'side, strolling', 'morning'),
                           ('I4', 'espresso counter', 'morning'), ('I16', 'espresso counter', 'morning'), ('A5', 'espresso counter', 'morning'), ('A4', 'meeting-room corner', 'morning')],
              'bedroom': [('I1', 'bedside, mattress height', 'night'), ('A2', 'bed end, DJ stand', 'night, red light')],
              'bathroom': [('I2', 'over the shoulder', 'early morning'), ('I17', 'over the shoulder', 'early morning'), ('A3', 'over the shoulder', 'early morning')]}
for letter, (eid, _d, ims) in LOCS.items():
    images = [{'path': img(i), 'still': i, 'angle': a, 'tod': t, 'clips': CLIPS_OF_STILL.get(i, [])} for i, a, t in LOC_IMAGES[eid] if i in outs]
    clips_here = sorted({u['clip'] for u in uses if u['location'] == letter})
    E[eid].update(establishing=images[0]['path'], images=images, angles=sorted({x['angle'] for x in images}), times=sorted({x['tod'] for x in images}),
                  clips=[{'clip': g, 'start_image': img(STILL[g]), 'used': where(shots_of_uses([u for u in uses if u['clip'] == g]))} for g in clips_here])
for eid, _n, _d, ims in PROPS:
    allims = [i for i, ps in PROPS_OF_STILL.items() if eid in ps]
    allims = ims + [i for i in allims if i not in ims]
    E[eid].update(hero=img(ims[0]), images=[{'path': img(i), 'still': i, 'clips': CLIPS_OF_STILL.get(i, [])} for i in allims if i in outs],
                  variants=[])
for e in ENT:
    e['media'] = [m['id'] for m in MEDIA if e['id'] in m['entities'] and not m['private']]
    e['private_media'] = [m['id'] for m in MEDIA if e['id'] in m['entities'] and m['private']]
    if e.get('face') and e['kind'] == 'character':
        fm = by_path.get(e['face']); e['thumb'] = fm['thumb'] if fm else e['face']
    dump(f'entities/{e["kind"]}s/{e["id"]}.json', e)
print('media', len(MEDIA), dict(Counter(m['kind'] for m in MEDIA)))

# ---------------------------------------------------------------- peaks (min/max per 5 ms, int8, base64)
if '--no-peaks' not in ARGS:
    import numpy as np, soundfile as sf
    os.makedirs(os.path.join(OUT, 'peaks'), exist_ok=True)
    srcs = [('mix', song['audio']['mix'])] + [(s['id'], s['audio']) for s in song['audio']['stems']]
    for pid, path in srcs:
        x, sr = sf.read(P(path), dtype='float32', always_2d=True)
        x = x.mean(axis=1)
        bin_ = sr * 0.005
        n = int(np.ceil(len(x) / bin_))
        edges = np.round(np.arange(n + 1) * bin_).astype(np.int64).clip(0, len(x))
        mn = np.minimum.reduceat(x, edges[:-1]); mx = np.maximum.reduceat(x, edges[:-1])
        peak = max(np.abs(mn).max(), np.abs(mx).max(), 1e-6)
        q = lambda a: np.clip(np.round(a / peak * 127), -127, 127).astype(np.int8)
        obj = {'id': pid, 'source': path, 'bin_ms': 5, 'n': int(n), 'scale': float(peak), 'encoding': 'int8 base64, value/127*scale',
               'min': base64.b64encode(q(mn).tobytes()).decode(), 'max': base64.b64encode(q(mx).tobytes()).decode()}
        dump(f'peaks/{pid}.json', obj)
print('done')
