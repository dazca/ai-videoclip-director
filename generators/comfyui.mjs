// Local ComfyUI (D9, not built yet): a STUB that reports "not configured" so Settings > Generator can list it and the
// runner refuses it with a clear message. The plan (ROADMAP_v4 D9): ComfyUI at http://127.0.0.1:8188, one workflow JSON
// per kind (image, video, motion) with slots for the prompt, the refs and the mask; POST /prompt, poll /history/<id>,
// fetch /view?filename=…; $0 estimates (your own machine). Until then, use "Open in another app" to take a request's
// prompt pack to ComfyUI by hand.
export default {
  id: 'comfyui', label: 'Local ComfyUI (not built yet)', kinds: ['image', 'video', 'motion'],
  configured() { return { ok: false, why: 'not configured: the ComfyUI generator is a stub (ROADMAP_v4 D9); use "Open in another app" to take the prompt pack to ComfyUI' }; },
  supports() { return { ok: false, why: 'ComfyUI is not configured (stub)' }; },
  estimate() { return { model: 'comfyui', takes: 1, per_take: 0, usd: 0, tool: 'comfyui', why: 'local: $0 (not built yet)' }; },
  async submit() { throw Object.assign(new Error('ComfyUI is not configured (stub)'), { code: 501 }); },
  async poll() { return { status: 'failed', error: 'ComfyUI is not configured (stub)' }; },
  async fetch() { return []; },
};
