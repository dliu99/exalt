// Fish Audio's own API (docs.fish.audio): its library of voices, and speech in any of them.
//
//   GET  https://api.fish.audio/model?title=&language=&sort_by=   the voices, public ones without a key
//   POST https://api.fish.audio/v1/tts  {text, reference_id}       MP3 in that voice; header `model`
//
// FISH_API_KEY stays on the server. Without one the voices still list, and speaking says why not.
const BASE = 'https://api.fish.audio';
const KEY = process.env.FISH_API_KEY ?? '';
const COVERS = 'https://public-platform.r2.fish.audio/';

export type FishVoice = { id: string; title: string; description: string; cover: string; sample: string; languages: string; uses: number };

// The models a book can be read in through Fish directly: the reader picks the voice.
export const FISH_MODELS = [
  { id: 'fish/s2.1-pro', name: 'Fish Audio S2.1 Pro', voices: [] as string[] },
  { id: 'fish/s2.1-pro-free', name: 'Fish Audio S2.1 Pro (free)', voices: [] as string[] },
];
export const isFish = (model: string) => model.startsWith('fish/');
export const fishReady = () => KEY !== '';

// Offline (tests) these stand in. Online the list is Fish's licensed English voices (rights secured
// by Fish, so no impersonations), most used first.
const FIXTURE: FishVoice[] = [
  { id: 'v-reader', title: 'The Reader', description: 'Warm, unhurried narration.', cover: '', sample: '', languages: 'en', uses: 1200 },
  { id: 'v-scholar', title: 'The Scholar', description: 'Clear and measured, for philosophy.', cover: '', sample: '', languages: 'en', uses: 800 },
];

const cache = new Map<string, { at: number; voices: FishVoice[] }>();

export async function listVoices(q: string, offline: boolean): Promise<FishVoice[]> {
  if (offline) return FIXTURE.filter((v) => !q || v.title.toLowerCase().includes(q.toLowerCase()));
  const key = q.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.voices;
  const params = new URLSearchParams({ page_size: '30', page_number: '1', sort_by: 'task_count', language: 'en', licensed: 'true' });
  if (key) params.set('title', q.trim());
  const res = await fetch(`${BASE}/model?${params}`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
  if (!res.ok) throw new Error(`Fish Audio answered ${res.status}.`);
  const body = (await res.json()) as { items?: Record<string, any>[] };
  const voices = (body.items ?? []).filter((m) => m.type !== 'svc').map((m): FishVoice => ({
    id: String(m._id), title: String(m.title ?? '').trim() || 'Untitled voice', description: String(m.description ?? '').trim(),
    cover: m.cover_image ? `${COVERS}${m.cover_image}` : '', sample: String(m.samples?.[0]?.audio ?? ''),
    languages: (m.languages ?? []).join(', '), uses: Number(m.task_count) || 0,
  }));
  cache.set(key, { at: Date.now(), voices });
  return voices;
}

export async function speakFish(model: string, voice: string, text: string): Promise<Uint8Array> {
  if (!KEY) throw new Error('The server has no FISH_API_KEY.');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/v1/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', model: model.slice('fish/'.length) },
      body: JSON.stringify({ text, reference_id: voice || undefined, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal' }),
    });
    // Concurrency is shared across the account and a 429 carries no Retry-After: back off and try again.
    if ((res.status === 429 || res.status === 503) && attempt < 4) { await Bun.sleep(1000 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error(`Fish Audio failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
