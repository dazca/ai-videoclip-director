// Playback of the mix with an <audio> element (streams the WAV with Range requests: no 100 MB decode),
// a rAF clock that drives the playhead, section loop, and an optional floating player of the rendered MP4.
import { store, mediaUrl } from './store.js';

export class Player {
  constructor(tl) {
    this.tl = tl;
    this.audio = new Audio(); this.audio.preload = 'auto';
    this.t = 0; this.playing = false; this.video = null;
    this.setSource();
    // at the song end the media can end before the rAF loop sees t >= loop.t1: wrap a loop here instead of stopping
    this.audio.addEventListener('ended', () => {
      const L = this.tl.loop;
      if (!L || !this.playing) return this.pause();
      this.audio.currentTime = L.t0 / 1000; this.t = L.t0;
      this.audio.play().catch(() => this.pause()); this.syncVideo(true);
    });
  }
  // (re)point the audio at the song's mix; a data reload keeps the element (and playback) unless the mix changed
  setSource() {
    const src = store.song.audio?.mix ? mediaUrl(store.song.audio.mix) : '';
    if (src === this.src) return;
    this.pause(); this.src = src;
    if (src) this.audio.src = src; else this.audio.removeAttribute('src');
  }
  time() { return this.playing ? this.audio.currentTime * 1000 : this.t; }
  async play() {
    if (this.playing) return;
    this.audio.currentTime = this.t / 1000;
    try { await this.audio.play(); } catch (e) { console.warn(e); return; }
    this.playing = true; this.syncVideo(true);
    const loop = () => {
      if (!this.playing) return;
      let t = this.audio.currentTime * 1000;
      const L = this.tl.loop;
      if (L && (t >= L.t1 || t < L.t0 - 50)) { this.audio.currentTime = L.t0 / 1000; t = L.t0; this.syncVideo(true); }
      this.t = t; this.tl.tickPlaying(t); this.syncVideo(false);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    document.dispatchEvent(new CustomEvent('wb:play', { detail: true }));
  }
  pause() {
    if (!this.playing) return;
    this.t = this.audio.currentTime * 1000; this.audio.pause(); this.playing = false; cancelAnimationFrame(this.raf);
    this.video?.pause();
    document.dispatchEvent(new CustomEvent('wb:play', { detail: false }));
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this.pause(); this.audio.removeAttribute('src'); this.src = null; this.video?.remove(); }
  seek(ms) {
    this.t = Math.max(0, Math.min(store.song.duration_ms, Math.round(ms)));
    if (this.playing) this.audio.currentTime = this.t / 1000;
    this.syncVideo(true);
  }
  toggleVideo() {
    if (this.video) { this.video.remove(); this.video = null; return; }
    const v = document.createElement('video');
    v.className = 'floatvid'; v.muted = true; v.playsInline = true; v.src = mediaUrl(store.song.audio.render);
    v.title = 'rendered video, synced to the playhead (V to close)';
    document.body.appendChild(v); this.video = v; this.syncVideo(true);
  }
  syncVideo(force) {
    const v = this.video; if (!v) return;
    const t = this.time() / 1000;
    if (force || Math.abs(v.currentTime - t) > 0.12) v.currentTime = t;
    if (this.playing && v.paused) v.play().catch(() => {});
    if (!this.playing && !v.paused) v.pause();
  }
}
