// Build data/demo/: a 20 s SYNTHETIC music video project (everything generated here with ffmpeg: a tone track, a
// test-pattern "render", three fractal / cellular-automaton "clips", placeholder stills; made-up lyrics). CC0: no
// third-party media, no real people. Lets anyone try the workbench and the MCP tools without the owner's data.
//   node tools/make_demo.mjs            (needs ffmpeg + ffprobe on PATH; replaces data/demo/)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from '../lib/store.mjs';
import { newProject } from '../importers/new_project.mjs';

const ID = 'demo', TMP = path.join(S.WB_DIR, 'data', '.demo-src');
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
const ff = (...args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('ffmpeg ' + args.join(' ') + '\n' + r.stderr); };

// ---------------------------------------------------------------- the song: 120 bpm, intro 0-4 s, verse 4-12, chorus 12-18, outro 18-20
const f = 'if(lt(mod(t,8),2),220,if(lt(mod(t,8),4),174.61,if(lt(mod(t,8),6),261.63,196)))';
const oct = 'if(between(t,12,18),2,1)';
const pad = `0.16*sin(2*PI*${f}*${oct}*t)+0.07*sin(2*PI*${f}*${oct}*1.5*t)`;
const kick = 'if(between(t,4,18),0.7*exp(-25*mod(t,0.5))*sin(2*PI*55*mod(t,0.5)*(1+3*exp(-40*mod(t,0.5)))),0)';
const hat = 'if(between(t,12,18),0.08*exp(-90*mod(t+0.25,0.5))*(2*random(0)-1),0)';
const song = path.join(TMP, 'demo-song.mp3');
ff('-filter_complex', `aevalsrc='${pad}+${kick}+${hat}':s=44100:d=20,afade=t=in:d=1,afade=t=out:st=18.5:d=1.5`, '-c:a', 'libmp3lame', '-b:a', '96k', song);
// the "render": a moving test pattern with the song
const render = path.join(TMP, 'demo-v1.mp4');
ff('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=20', '-i', song, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', render);

const lyrics = `[Intro]
[00:01.00] Tone on, lights low
[Verse]
[00:04.00] A square of colour on the wall
[00:06.00] It hums the note it heard at all
[00:08.00] The grid keeps time, the bars line up
[00:10.00] One more beat to fill the cup
[Chorus]
[00:12.00] Sing it in sine, sing it in square
[00:14.00] Every frame is waiting there
[00:16.00] Sing it in sine, sing it in square
[Outro]
[00:18.20] Tone off
`;
fs.writeFileSync(path.join(TMP, 'demo-lyrics.lrc'), lyrics);
console.log(newProject(ID, { song, lyrics, title: 'Demo: Test Tone (synthetic)', bpm: 120, cap: 10, render, force: true }));
const D = S.projDir(ID), J = (f) => S.readJSON(path.join(D, f)), W = (f, v) => S.writeJSON(path.join(D, f), v);

// ---------------------------------------------------------------- sections: exact bounds + treatment numbers
const s = J('song.json');
const SEC = { intro: [0, 4000, 1, 0, '0', 'test card fades up from black'], verse: [4000, 12000, 3, 60, '2 → 4', 'cut on the downbeat into the fractal wall'],
  chorus: [12000, 18000, 5, 80, '6 → 8', 'octave up: every bar cuts'], outro: [18000, 20000, 1, 0, '1 → 0', 'fade to the test card'] };
s.duration_ms = 20000;
s.sections = s.sections.map(x => { const [t0, t1, energy, world, ol, tr] = SEC[x.id]; return { ...x, t0, t1, energy, world_pct: world, screen_pct: 100 - world, overload: ol.split(' → ').map(Number).concat(ol.includes('→') ? [] : [Number(ol)]).slice(0, 2), overload_text: ol, transitions: tr }; });
for (const l of s.lines) { l.voice = l.section === 'chorus' ? 'both' : 'male'; l.words.forEach(w => { w.p = 0.9; }); }
s.lines.find(l => l.id === 'intro/0').kind = 'system';
W('song.json', s);
W('events.json', [...J('events.json'), { id: 'drop_chorus', t: 12000, kind: 'drop', note: 'chorus: octave up, hats in' }, { id: 'stop_outro', t: 18000, kind: 'stop', note: 'kick stops' }].sort((a, b) => a.t - b.t));

// ---------------------------------------------------------------- generated media (synthetic) into data/demo/media/
const M = (k, n) => { fs.mkdirSync(path.join(D, 'media', k), { recursive: true }); return path.join(D, 'media', k, n); };
ff('-f', 'lavfi', '-i', 'mandelbrot=s=256x144:r=24', '-t', '3', '-c:v', 'libx264', '-crf', '32', '-pix_fmt', 'yuv420p', M('clip', 'C1_0.mp4'));
ff('-f', 'lavfi', '-i', 'mandelbrot=s=256x144:r=24:start_scale=1.5', '-t', '3', '-vf', 'hue=h=140', '-c:v', 'libx264', '-crf', '32', '-pix_fmt', 'yuv420p', M('clip', 'C1_1.mp4'));
ff('-f', 'lavfi', '-i', 'life=s=256x144:mold=10:r=24:ratio=0.1:death_color=#C83232:life_color=#00ff00', '-t', '3', '-c:v', 'libx264', '-crf', '32', '-pix_fmt', 'yuv420p', M('clip', 'C2_0.mp4'));
ff('-f', 'lavfi', '-i', 'cellauto=s=256x144:rule=110:r=24', '-t', '3', '-c:v', 'libx264', '-crf', '32', '-pix_fmt', 'yuv420p', M('clip', 'C3_0.mp4'));
ff('-f', 'lavfi', '-i', 'gradients=s=480x270:c0=0x223355:c1=0xff8844:x0=0:y0=0:x1=480:y1=270:speed=0', '-frames:v', '1', '-q:v', '4', M('still', 'I1.jpg'));
ff('-f', 'lavfi', '-i', 'gradients=s=270x480:c0=0xff8844:c1=0x334455:c2=0xffd0a0:n=3:speed=0', '-frames:v', '1', '-q:v', '4', M('still', 'ada_body.jpg'));
ff('-f', 'lavfi', '-i', 'mandelbrot=s=240x240:start_scale=0.4:start_x=-0.75', '-frames:v', '1', '-q:v', '4', M('still', 'ada_face.jpg'));
ff('-f', 'lavfi', '-i', 'mandelbrot=s=240x240:start_scale=0.25:start_x=-0.1:start_y=0.85', '-frames:v', '1', '-vf', 'hue=h=120', '-q:v', '4', M('still', 'bo_face.jpg'));
ff('-f', 'lavfi', '-i', 'gradients=s=270x480:c0=0x2a7f62:c1=0x0b1d2a:c2=0x9be3c4:n=3:speed=0', '-frames:v', '1', '-q:v', '4', M('still', 'bo_body.jpg'));
ff('-f', 'lavfi', '-i', 'testsrc2=s=480x270', '-frames:v', '1', '-q:v', '4', M('still', 'studio.jpg'));
ff('-f', 'lavfi', '-i', 'smptehdbars=s=480x270', '-frames:v', '1', '-q:v', '4', M('still', 'tone_generator.jpg'));

// ---------------------------------------------------------------- storyboard: shots + clip uses
const uses = [
  { id: 'C1@4000', clip: 'C1', t0: 4000, t1: 8000, in_ms: 0, take: 0, label: 'the fractal wall breathes' },
  { id: 'C2@8000', clip: 'C2', t0: 8000, t1: 12000, in_ms: 500, take: 0, label: 'cells keep the grid' },
  { id: 'C3@12000', clip: 'C3', t0: 12000, t1: 15000, in_ms: 0, take: 0, label: 'rule 110 rain' },
  { id: 'C1@15000', clip: 'C1', t0: 15000, t1: 18000, in_ms: 500, take: 1, label: 'the wall, green take' },
].map(u => ({ ...u, file: `media/clip/${u.clip}_${u.take}.mp4`, start_image: 'media/still/I1.jpg', location: 'S', thumb: `thumbs/use_${u.clip}_${u.take}_${u.in_ms}.jpg` }));
const shots = [
  ['s1-intro', 0, 4000, 'intro', 'screen', 'test card fades up; the tone starts', [], ['S'], [], ['intro/0']],
  ['s2-wall', 4000, 8000, 'verse', 'world', 'Ada faces the fractal wall', ['ada'], ['S'], ['C1@4000'], ['verse/0', 'verse/1']],
  ['s3-grid', 8000, 12000, 'verse', 'split', 'the grid keeps time; Bo counts bars on the tone generator', ['bo'], ['S'], ['C2@8000'], ['verse/2', 'verse/3']],
  ['s4-chorus', 12000, 18000, 'chorus', 'world', 'both sing; cuts on every bar', ['ada', 'bo'], ['S'], ['C3@12000', 'C1@15000'], ['chorus/0', 'chorus/1', 'chorus/2']],
  ['s5-outro', 18000, 20000, 'outro', 'screen', 'tone off: back to the test card', [], ['S'], [], ['outro/0']],
].map(([id, t0, t1, section, kind, title, cast, locations, clips, lines]) => ({ id, t0, t1, section, kind, title, cast, locations, clips, lines,
  render_frame_ms: Math.round((t0 + t1) / 2), thumb: `thumbs/shot_${id}.jpg`, render: 'render/demo-v1.mp4' }));
fs.mkdirSync(path.join(D, 'thumbs'), { recursive: true });
for (const x of shots) ff('-ss', (x.render_frame_ms / 1000).toFixed(3), '-i', path.join(D, 'render', 'demo-v1.mp4'), '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '6', path.join(D, x.thumb));
for (const u of uses) ff('-ss', ((u.in_ms + 200) / 1000).toFixed(3), '-i', path.join(D, u.file), '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '6', path.join(D, u.thumb));
W('shots.json', { source: 'tools/make_demo.mjs (synthetic)', shots, uses });

W('script.json', { stages: [{ name: 'Test card', t0: 0, t1: 4000, text: 'Only the screen.' }, { name: 'The wall', t0: 4000, t1: 18000, text: 'The world appears behind the test card.' }, { name: 'Off', t0: 18000, t1: 20000, text: 'Back to the screen.' }],
  lines: s.lines.map((l, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, t0: l.t0, lyric: l.text, mode: l.section === 'verse' ? 'W' : l.section === 'chorus' ? 'W→S' : 'S', action: shots.find(x => x.t0 <= l.t0 && l.t0 < x.t1)?.title || '', line_id: l.id })) });

// ---------------------------------------------------------------- media index (thumbnails + scrub strips via the same code the MCP media_add uses)
const used = (clip, take) => uses.filter(u => u.clip === clip && u.take === take);
const add = (p, kind, label, extra = {}) => S.ops.media_add(ID, { path: p, kind, label, ...extra }).media;
add('render/demo-v1.mp4', 'render', 'render demo-v1', { shots: shots.map(x => x.id), status: 'used' });
add('audio/demo-song.mp3', 'audio', 'mix (synthetic tone track)', { status: 'used' });
for (const [c, t, ents] of [['C1', 0, ['ada', 'studio']], ['C1', 1, ['ada', 'studio']], ['C2', 0, ['bo', 'studio']], ['C3', 0, ['ada', 'bo', 'studio']]]) {
  const us = used(c, t);
  add(`media/clip/${c}_${t}.mp4`, 'clip', `${c} take ${t}`, { job: c, take: t, entities: ents, uses: us.map(u => u.id), shots: shots.filter(x => x.clips.some(k => us.some(u => u.id === k))).map(x => x.id), status: us.length ? 'used' : 'unused', cost_usd: 0 });
}
add('media/still/I1.jpg', 'still', 'I1 start image', { job: 'I1', take: 0, entities: ['studio'], shots: ['s2-wall', 's3-grid', 's4-chorus'], status: 'used', cost_usd: 0 });
for (const [f, e, l] of [['ada_face', 'ada', 'Ada face (placeholder)'], ['ada_body', 'ada', 'Ada body (placeholder)'], ['bo_face', 'bo', 'Bo face (placeholder)'], ['bo_body', 'bo', 'Bo body (placeholder)'], ['studio', 'studio', 'studio establishing (test pattern)'], ['tone_generator', 'tone-generator', 'tone generator hero (colour bars)']])
  add(`media/still/${f}.jpg`, 'still', l, { entities: [e], status: 'picked', cost_usd: 0 });

// ---------------------------------------------------------------- entities (placeholders: no real people)
const where = (id) => shots.filter(x => x.cast.includes(id)).map(x => ({ shot: x.id, t: x.t0 }));
S.ops.entity_upsert(ID, { kind: 'character', id: 'ada', name: 'Ada', thumb_src: 'media/still/ada_face.jpg', fields: { short: 'A', color: '#ff8844', status: 'approved', role: 'the lead (a placeholder figure made of gradients)',
  face: 'media/still/ada_face.jpg', body: 'media/still/ada_body.jpg', refs: ['media/still/ada_face.jpg', 'media/still/ada_body.jpg'] },
  look: { id: 'base', name: 'Orange gradient (base look)', base: true, garments: ['orange hoodie', 'dark jeans'], colors: ['#ff8844', '#223355'], images: ['media/still/ada_body.jpg', 'media/still/ada_face.jpg'], clips: ['C1', 'C3'], used: where('ada'), status: 'approved', cost_usd: 0 } });
S.ops.entity_upsert(ID, { kind: 'character', id: 'bo', name: 'Bo', thumb_src: 'media/still/bo_face.jpg', fields: { short: 'B', color: '#2a7f62', status: 'draft', role: 'counts the bars (placeholder)',
  face: 'media/still/bo_face.jpg', body: 'media/still/bo_body.jpg', refs: ['media/still/bo_face.jpg', 'media/still/bo_body.jpg'] },
  look: { id: 'base', name: 'Green gradient (base look)', base: true, garments: ['green overalls'], colors: ['#2a7f62'], images: ['media/still/bo_body.jpg'], clips: ['C2', 'C3'], used: where('bo'), status: 'draft', cost_usd: 0 } });
S.ops.entity_upsert(ID, { kind: 'location', id: 'studio', name: 'S · studio', thumb_src: 'media/still/studio.jpg', fields: { letter: 'S', status: 'approved', description: 'a room that is a test pattern',
  refs: ['media/still/studio.jpg', 'media/still/I1.jpg'], establishing: 'media/still/studio.jpg', images: [{ path: 'media/still/studio.jpg', still: null, angle: 'wide', tod: 'day', clips: [] }, { path: 'media/still/I1.jpg', still: 'I1', angle: 'wall', tod: 'dusk', clips: ['C1', 'C2', 'C3'] }], angles: ['wide', 'wall'], times: ['day', 'dusk'], clips: ['C1', 'C2', 'C3'] } });
S.ops.entity_upsert(ID, { kind: 'prop', id: 'tone-generator', name: 'Tone generator', thumb_src: 'media/still/tone_generator.jpg', fields: { status: 'draft', description: 'the box that makes the song',
  refs: ['media/still/tone_generator.jpg'], hero: 'media/still/tone_generator.jpg', images: [{ path: 'media/still/tone_generator.jpg', still: null, clips: [] }], variants: [] } });

// ---------------------------------------------------------------- review state: approvals, notes, one draft request, costs
const now = '2026-10-04T12:00:00';
W('approvals.json', { rev: 1, states: ['draft', 'review', 'changes', 'approved', 'locked'], items: {
  'shot:s1-intro': { state: 'approved', by: 'director', at: now }, 'shot:s2-wall': { state: 'approved', by: 'director', at: now },
  'shot:s3-grid': { state: 'changes', by: 'director', at: now, comment: 'Bo should be on the beat, not before it' }, 'shot:s4-chorus': { state: 'review', by: 'agent', at: now },
  'use:C1@4000': { state: 'approved', by: 'director', at: now }, 'character:ada': { state: 'approved', by: 'director', at: now } } });
W('notes.json', { rev: 1, notes: [
  { id: 'n01', t: 4000, line_id: 'verse/0', by: 'director', text: 'the wall should appear exactly on the downbeat', status: 'open', at: now },
  { id: 'n02', t: 12000, line_id: 'chorus/0', by: 'director', text: 'more colour in the chorus; try a warmer take of C3', status: 'open', at: now } ] });
W('requests.json', { rev: 1, items: [{ id: 'rdemo01', kind: 'new-variant', target: 'use:C3@12000', prompt: 'C3 again with a warm palette (orange on dark blue), same motion', refs: ['media/clip/C3_0.mp4', 'media/still/I1.jpg'], est_cost: 0.4, status: 'draft', by: 'director', at: now, log: [{ at: now, by: 'director', status: 'draft' }] }] });
W('costs.json', { cap_usd: 10, source: 'synthetic demo: every file was made with ffmpeg for $0', items: [
  { id: 'C1', t: 4000, usd: 0, tool: 'ffmpeg mandelbrot (synthetic)', date: '2026-10-04' }, { id: 'C2', t: 8000, usd: 0, tool: 'ffmpeg life (synthetic)', date: '2026-10-04' },
  { id: 'C3', t: 12000, usd: 0, tool: 'ffmpeg cellauto (synthetic)', date: '2026-10-04' }], pre_production: [], ledger: [] });
W('project.json', { title: 'Demo: Test Tone (synthetic)', created: now, license: 'CC0-1.0 (all media synthetic, generated by tools/make_demo.mjs)' });
fs.rmSync(TMP, { recursive: true, force: true });
const size = S.walk(D).reduce((n, f) => n + fs.statSync(path.join(D, f)).size, 0);
console.log(`data/demo ready: ${shots.length} shots, ${uses.length} clip uses, ${J('media.json').items.length} media, ${(size / 1024).toFixed(0)} KB`);
