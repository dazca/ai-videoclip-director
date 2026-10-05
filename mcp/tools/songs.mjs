// MCP tools: E7 song versions and the Suno brief (lib/ops/songs.mjs, js/songs.js). Nothing calls Suno: you write the brief, the
// director pastes it and brings the song back. Using a version (the audio, the lyric timings and every boundary move) is the
// director's, in the page (song_version_use: no tool).
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

mcp.registerTool('song_versions_get', {
  title: 'Song versions',
  description: 'Read only. The takes of the song as versions v1, v2…: source (suno | upload | import | other), audio file, length, bpm, how its lyrics line up (alignment: lrc | lines | '
    + 'offset | stretch, lines matched), the style / exclude / lyrics prompt it was made with, who added it; the current one; the saved Suno brief settings.',
  inputSchema: { project },
}, wrap((a) => op('song_versions_get', a)));

mcp.registerTool('song_version_add', {
  title: 'Add a take of the song as a version',
  description: 'Register a new take (a Suno result the director downloaded, an upload) as a candidate version. path = the audio file (absolute, inside the project, or under a '
    + 'media root; copied into audio/versions/ when elsewhere; never a PRIVATE path). source suno | upload | other; label; style / exclude / lyrics_prompt = what was pasted '
    + 'into Suno (default for suno: the current brief, suno_brief); suno {title, model, link}. How its lyrics line up with the song now, one of: lrc (timed lyrics "[mm:ss.xx] '
    + 'words": lines matched by their words), lines [{id, t0}] (measured line starts in the new take), offset_ms + scale (t\' = offset + t x scale), or nothing (stretched to '
    + 'its length). bpm / beats_per_bar if they changed. Nothing moves: it returns the plan (what would move: lyric lines, scene / shot boundaries, events, problems). '
    + 'The director previews and uses it in the page (Lyrics › Song versions…).',
  inputSchema: { project, path: z.string(), source: z.enum(['suno', 'upload', 'other']).optional(), label: z.string().optional(), style: z.string().optional(), exclude: z.string().optional(),
    lyrics_prompt: z.string().optional(), suno: z.object({ title: z.string().optional(), model: z.string().optional(), link: z.string().optional() }).optional(),
    lrc: z.string().optional(), lines: z.array(z.object({ id: z.string(), t0: z.number() })).optional(), offset_ms: z.number().optional(), scale: z.number().optional(),
    bpm: z.number().optional(), beats_per_bar: z.number().int().optional(), by },
}, wrap((a) => op('song_version_add', a)));

mcp.registerTool('song_version_plan', {
  title: 'What a song version would move',
  description: 'Read only. If the director used this version: how many lyric lines move, every scene / shot boundary and named event old -> new (the E1 re-time preview\'s rows), '
    + 'the beats moved back inside their scene, and problems (a scene or shot left without length in the new take: then it cannot be used until the script is fixed).',
  inputSchema: { project, version: z.string().describe('"v2"') },
}, wrap((a) => op('song_version_plan', a)));

mcp.registerTool('suno_brief', {
  title: 'The Suno brief',
  description: 'The text the director pastes into Suno (custom mode): STYLE (genre, tempo, key, instruments, voices, the arc; at most 1000 characters), EXCLUDE (at most 1000), '
    + 'TITLE, and the LYRICS of the Lyrics stage\'s current version with its section tags ("[Verse 1 - male, soft]", cue sections like "[Stop - the beat cuts out]" stay tags; '
    + 'at most 5000 characters), with the counts, the gates and warnings. style / exclude / title replace the saved ones for this brief; save: true stores them '
    + '(settings.json suno). Nothing calls Suno: the director pastes it and brings the song back (song_version_add).',
  inputSchema: { project, style: z.string().optional(), exclude: z.string().optional(), title: z.string().optional(), save: z.boolean().optional(), by },
}, wrap((a) => op('suno_brief', a)));
