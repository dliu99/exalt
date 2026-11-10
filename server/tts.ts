// Text to speech through an OpenAI-compatible `/audio/speech` endpoint, OpenRouter by default.
// TTS_BASE_URL points it elsewhere (a self-hosted model, Fish Audio's own API behind a shim).
// The key stays on the server: OPENROUTER_API_KEY, never in the app.
import { FISH_MODELS, fishReady, isFish, speakFish } from './fish.ts';
export type Model = { id: string; name: string; voices: string[] };
export type Voice = { audio: Uint8Array; ext: 'mp3' | 'pcm' | 'wav'; rate?: number };

const BASE = process.env.TTS_BASE_URL ?? 'https://openrouter.ai/api/v1';
const KEY = process.env.OPENROUTER_API_KEY ?? process.env.TTS_API_KEY ?? '';
export const FAKE: Model = { id: 'exalt/silence', name: 'Silence (for testing)', voices: [] };

// The picker's models, in order: the free ones first. TTS_MODELS ("id=Name,id=Name") replaces them.
const DEFAULTS: Model[] = [
  { id: 'fish-audio/s2.1-pro-free:free', name: 'Fish Audio S2.1 Pro (free)', voices: [] },
  { id: 'heygen/heygen-voice-1-turbo:free', name: 'HeyGen Voice Turbo (free)', voices: [] },
  { id: 'google/gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash Lite TTS', voices: [] },
  { id: 'google/gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS', voices: [] },
];
// Some providers only answer in raw 16-bit PCM.
const PCM_ONLY = (model: string) => model.startsWith('heygen/');

let known: Model[] | undefined;

// The chosen models, with the voices the provider lists for each (empty: the model picks).
export async function listModels(offline: boolean): Promise<Model[]> {
  if (offline) return [FAKE];
  const pinned = (process.env.TTS_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [id, name] = s.split('='); return { id, name: name ?? id, voices: [] as string[] }; });
  const chosen = pinned.length ? pinned : DEFAULTS;
  let voices = new Map<string, string[]>();
  try {
    const res = await fetch(`${BASE}/models?output_modalities=speech`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
    if (res.ok) {
      const body = (await res.json()) as { data?: { id: string; supported_voices?: string[] | null }[] };
      voices = new Map((body.data ?? []).map((m) => [m.id, m.supported_voices ?? []]));
    }
  } catch { /* the picker still works; each model uses its own default voice */ }
  // With a Fish Audio key, its own API comes first: the reader chooses the voice from Fish's library.
  known = [...(fishReady() ? FISH_MODELS : []), ...chosen.map((m) => ({ ...m, voices: voices.get(m.id) ?? m.voices }))];
  return known;
}

export async function speak(model: string, voice: string, input: string): Promise<Voice> {
  if (model === FAKE.id) return { audio: wav(new Uint8Array(8000 * 2), 8000), ext: 'wav' };
  if (isFish(model)) return { audio: await speakFish(model, voice, input), ext: 'mp3' };
  if (!KEY) throw new Error('The server has no OPENROUTER_API_KEY.');
  // A model with a voice list needs one of them; the first is its default.
  if (!voice) voice = (known ?? await listModels(false)).find((m) => m.id === model)?.voices[0] ?? '';
  const pcm = PCM_ONLY(model);
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input, voice: voice || undefined, response_format: pcm ? 'pcm' : 'mp3' }),
  });
  if (!res.ok) throw new Error(`Speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (!pcm) return { audio, ext: 'mp3' };
  const rate = Number(/rate=(\d+)/.exec(res.headers.get('content-type') ?? '')?.[1]) || 44100;
  return { audio, ext: 'pcm', rate };
}

// MP3 frames are self-delimiting, and raw PCM is just samples, so either joins by bytes.
export const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// 16-bit mono PCM with a WAV header, so players can open it.
export function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length), head = new DataView(out.buffer);
  const str = (at: number, s: string) => [...s].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); head.setUint32(4, 36 + pcm.length, true); str(8, 'WAVEfmt ');
  head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
  head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
  str(36, 'data'); head.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
