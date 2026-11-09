// Text to speech through an OpenAI-compatible `/audio/speech` endpoint, OpenRouter by default.
// TTS_BASE_URL points it elsewhere (a self-hosted model, Fish Audio's own API behind a shim).
// The key stays on the server: OPENROUTER_API_KEY, never in the app.
export type Model = { id: string; name: string };
export type Voice = { audio: Uint8Array; ext: string };

const BASE = process.env.TTS_BASE_URL ?? 'https://openrouter.ai/api/v1';
const KEY = process.env.OPENROUTER_API_KEY ?? process.env.TTS_API_KEY ?? '';
export const FAKE: Model = { id: 'exalt/silence', name: 'Silence (for testing)' };

// Text-to-speech models: TTS_MODELS ("id=Name,id=Name") if set, else the provider's
// models whose output includes audio.
export async function listModels(offline: boolean): Promise<Model[]> {
  if (offline) return [FAKE];
  const pinned = (process.env.TTS_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [id, name] = s.split('='); return { id, name: name ?? id }; });
  if (pinned.length) return pinned;
  const res = await fetch(`${BASE}/models?output_modalities=audio`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
  if (!res.ok) throw new Error(`The model list answered ${res.status}`);
  const body = (await res.json()) as { data?: { id: string; name?: string; architecture?: { output_modalities?: string[] } }[] };
  return (body.data ?? [])
    .filter((m) => m.architecture?.output_modalities?.includes('audio') ?? true)
    .map((m) => ({ id: m.id, name: m.name ?? m.id }));
}

export async function speak(model: string, voice: string, input: string): Promise<Voice> {
  if (model === FAKE.id) return { audio: silence(1), ext: 'wav' };
  if (!KEY) throw new Error('The server has no OPENROUTER_API_KEY.');
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input, voice: voice || undefined, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`Speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return { audio: new Uint8Array(await res.arrayBuffer()), ext: 'mp3' };
}

// MP3 frames are self-delimiting, so a chapter's chunks play as one file when joined.
export const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

function silence(seconds: number): Uint8Array {
  const rate = 8000, samples = rate * seconds, out = new DataView(new ArrayBuffer(44 + samples * 2));
  const str = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + samples * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, samples * 2, true);
  return new Uint8Array(out.buffer);
}
