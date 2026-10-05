// English strings (G8): the fallback for every key. core/i18n.js reads this table and the Catalan / Spanish ones
// (strings-ca.js, strings-es.js); a key missing there falls back to here. {name} = a value filled in by t(key, {name}).
export default {
  // the menu bar (core/menus.js BAR) and the pages (tabs/registry.js)
  'menu.File': 'File', 'menu.Edit': 'Edit', 'menu.View': 'View', 'menu.Timeline': 'Timeline', 'menu.Generate': 'Generate', 'menu.Window': 'Window', 'menu.Help': 'Help',
  'page.timeline': 'Timeline', 'page.assets': 'Assets', 'page.review': 'Review', 'page.settings': 'Settings', 'page.stage': 'Stages',
  'sub.characters': 'Characters', 'sub.locations': 'Locations', 'sub.props': 'Props', 'sub.media': 'Media', 'sub.clips': 'Clips',
  'sub.approvals': 'Approvals', 'sub.queue': 'Queue', 'sub.takes': 'Takes', 'sub.notes': 'Notes', 'sub.compare': 'Compare', 'sub.costs': 'Costs',
  'top.openNotes': 'all open notes: {n}', 'top.noNotes': 'no open notes',
  // the seven stages (js/flow.js STAGES) and what the rail shows
  'stage.lyrics': 'Lyrics', 'stage.script': 'Script', 'stage.breakdown': 'Breakdown', 'stage.characters': 'Characters', 'stage.scenery': 'Scenery', 'stage.storyboard': 'Storyboard', 'stage.final': 'Final',
  'shown.empty': 'empty', 'shown.in_progress': 'in progress', 'shown.needs_you': 'needs you', 'shown.ready': 'ready to mark done', 'shown.done': 'done', 'shown.changed': 'done ⚠ changed since',
  'rail.next': 'next:', 'rail.allDone': 'all stages done', 'rail.round': 'Round {n}', 'rail.yourOpen': 'your open notes: {n}', 'rail.send': 'Send round to Claude',
  'rail.working': 'Claude working', 'rail.finished': 'Claude finished', 'rail.close': 'Close revision {id}',
  // the stage bar (core/stagebar.js)
  'bar.markDone': 'Mark done', 'bar.reopen': 'Reopen', 'bar.needsYou': 'Needs you', 'bar.saveVersion': 'Save version', 'bar.sendEdit': 'Send edit request',
  'bar.ask': 'Ask the agent…', 'bar.sendRound': 'Send round {n} ({k})', 'bar.roundWorking': 'Round {n}: Claude working', 'bar.closeRevision': 'Close revision {id}',
  'bar.list': 'List', 'bar.time': 'Time', 'bar.nothingBlocking': 'nothing blocking', 'bar.noAgent': 'no agent connected · Connect Claude…',
  // dialogs
  'dlg.close': 'close (Esc)', 'dlg.ok': 'OK', 'dlg.cancel': 'Cancel', 'dlg.copy': 'copy', 'dlg.copied': 'copied',
  // Settings
  'set.language': 'language', 'set.languageHint': 'the menus, the stages, the rail, the buttons and the onboarding; the rest stays in English for now',
  'set.generator': 'generator', 'set.costs': 'costs', 'set.project': 'project', 'set.view': 'view', 'set.columns': 'columns', 'set.keybindings': 'keybindings',
  'set.paired': 'paired pages', 'set.pairedHint': 'pages on another origin (the hosted app) that may reach this computer; pair one with: npx ai-videoclip-director pair',
  'set.pairedNone': 'no paired page', 'set.revoke': 'Revoke', 'set.revoked': 'revoked {id}: that page can no longer reach this computer',
  'set.pairedCol': 'origin · scope · paired · last used', 'set.scope.director': 'acts as you (never private files)', 'set.scope.read': 'read only',
  // the onboarding (core/onboarding.js)
  'ob.title': 'Welcome to the Director Workbench',
  'ob.lead': 'Direct a music video with an AI assistant: the song runs top to bottom, and every column (lyrics, script, shots, takes, notes) shares its time.',
  'ob.start': 'Three ways to start',
  'ob.song': 'Start from a song', 'ob.songDo': 'Drop the song file (mp3, wav, m4a…) and its lyrics: the length, the beats and the line timings are read on this computer.',
  'ob.lyrics': 'Lyrics only', 'ob.lyricsDo': 'Paste the poem now; add the song later, when you have it (the Lyrics stage: Add song…).',
  'ob.demo': 'Open the demo', 'ob.demoDo': 'A short synthetic project with every stage filled in: look around before you start your own.',
  'ob.connect': 'Connect Claude', 'ob.connectDo': 'Any Claude Code chat can work on the same project through the MCP server: you see every change here, live.', 'ob.connectBtn': 'Connect Claude…',
  'ob.data': 'Where your data lives', 'ob.dataDo': 'Every project is a folder of plain files on this computer. Nothing leaves it unless you approve a paid generation.',
  'ob.dataUnknown': '(the server did not say: open the page from this computer)',
  'ob.check': 'This computer', 'ob.notNow': 'Not now', 'ob.lang': 'Language',
  'ob.again': 'Help › Welcome… shows this again.',
  // the system check and the error states (core/onboarding.js, core/stale.js, app.js)
  'chk.title': 'System check', 'chk.server': 'Workbench server', 'chk.serverOk': 'running · v{v}', 'chk.serverDown': 'not answering',
  'chk.code': 'Code', 'chk.codeOk': 'up to date', 'chk.codeStale': 'stale: restart the server',
  'chk.ffmpeg': 'ffmpeg / ffprobe', 'chk.ffmpegOk': 'found', 'chk.ffmpegNo': 'not found: reading a song, waveforms, thumbnails and contact sheets need it',
  'chk.ffmpegFix': 'Install it, then restart the workbench: Windows: winget install ffmpeg · macOS: brew install ffmpeg · Linux: sudo apt install ffmpeg',
  'chk.fal': 'fal key (paid generation)', 'chk.falOk': 'found ({src})', 'chk.falNo': 'not set: optional. Without it, approved requests run as "Open in another app" (a prompt pack, $0)',
  'chk.falFix': 'To generate here: set FAL_KEY before starting the workbench, or fal_key_file in workbench.config.json (a file outside the project). Never paste the key into a chat.',
  'chk.agent': 'Claude (MCP)', 'chk.agentOk': 'connected: last write {what}', 'chk.agentNo': 'no agent has written since the server started',
  'chk.data': 'Data folder', 'chk.recheck': 'Check again', 'chk.open': 'System check…',
  'err.downTitle': 'The workbench server is not answering.', 'err.downDo': 'Start it again: npx ai-videoclip-director (or npm start in the workbench folder). This page reconnects by itself.',
  'err.back': 'The server is back.', 'err.reload': 'Reload',
  'err.stale': 'Restart the server.', 'err.staleDo': 'The workbench code changed on disk after it started ({files}): this page may ask for things it does not know yet. Restart it, then reload.',
  'err.reloadPage': 'Reload the page.', 'err.reloadDo': 'The server restarted with new code since this page loaded.',
  'err.noFfmpeg': 'ffmpeg not found.', 'err.noFfmpegDo': 'Reading a song, waveforms and thumbnails need it.', 'err.how': 'How to fix…',
  'err.loadTitle': 'Could not load project "{p}"', 'err.loadDo': 'Is the workbench server running? Start it (npx ai-videoclip-director, or npm start in the workbench folder), then retry.',
  'err.retry': 'Retry', 'err.openDemo': 'Open the demo',
  'help.welcome': 'Welcome… (start here)', 'help.health': 'System check…',
};
