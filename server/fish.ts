// Fish Audio's library of voices, browsed only: its public listing, no key and no synthesis here.
// A voice chosen from it is read through OpenRouter's Fish Audio models (tts.ts), which take the
// voice's id as `voice`.
//
//   GET https://api.fish.audio/model?title=&language=&sort_by=&licensed=   (docs.fish.audio)
const BASE = 'https://api.fish.audio';
const COVERS = 'https://public-platform.r2.fish.audio/';

export type FishVoice = { id: string; title: string; description: string; cover: string; sample: string; languages: string; uses: number };

// Offline (tests) these stand in.
const FIXTURE: FishVoice[] = [
  { id: 'v-reader', title: 'The Reader', description: 'Warm, unhurried narration.', cover: '', sample: '', languages: 'en', uses: 1200 },
  { id: 'v-scholar', title: 'The Scholar', description: 'Clear and measured, for philosophy.', cover: '', sample: '', languages: 'en', uses: 800 },
];

const cache = new Map<string, { at: number; voices: FishVoice[] }>();

// With nothing searched: Fish's licensed English voices (rights secured by Fish), most used first.
// A search reaches the whole community library.
export async function listVoices(q: string, offline: boolean): Promise<FishVoice[]> {
  if (offline) return FIXTURE.filter((v) => !q || v.title.toLowerCase().includes(q.toLowerCase()));
  const key = q.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.voices;
  // A search ranks by relevance (`score`): by use, a phrase brings back the most popular voices.
  const params = new URLSearchParams({ page_size: '30', page_number: '1', language: 'en', sort_by: key ? 'score' : 'task_count' });
  if (key) params.set('title', q.trim());
  else params.set('licensed', 'true');
  const res = await fetch(`${BASE}/model?${params}`);
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
