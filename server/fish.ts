// Fish Audio's library of voices, browsed only: its public listing, no key and no synthesis here.
// A voice chosen from it is read through OpenRouter's Fish Audio models (tts.ts), which take the
// voice's id as `voice`.
//
//   GET https://api.fish.audio/model?title=&language=&sort_by=   (docs.fish.audio)
//   GET https://api.fish.audio/model/{id}
const BASE = 'https://api.fish.audio';
const COVERS = 'https://public-platform.r2.fish.audio/';

export type FishVoice = { id: string; title: string; description: string; cover: string; sample: string; languages: string; uses: number };

// Offline (tests) these stand in.
const FIXTURE: FishVoice[] = [
  { id: 'v-reader', title: 'The Reader', description: 'Warm, unhurried narration.', cover: '', sample: '', languages: 'en', uses: 1200 },
  { id: 'v-scholar', title: 'The Scholar', description: 'Clear and measured, for philosophy.', cover: '', sample: '', languages: 'en', uses: 800 },
];

// With nothing searched: a recommended set, most popular first, named as we name them (the library's
// titles are the uploaders'). Each is the most used voice on Fish for that person.
const RECOMMENDED: [id: string, title: string][] = [
  ['f469ca5f50434542ae4c871bba5ccc0f', 'Barack Obama'],
  ['cc1d2d26fddf487496c74a7f40c7c871', 'MrBeast'],
  ['f53bd8b485d449bca2be13938966c408', 'Vladimir Putin'],
  ['1c3154b58bf44f839c951f2e949b2835', 'Winston Churchill'],
  ['7a2da24f05b641178f7ef8bf4e2d52db', 'David Attenborough'],
  ['6819f318541549ca8dace9e26a57a2e4', 'Playboi Carti'],
  ['a2eebb368fe5486aa986281a0aedcfab', 'Future'],
  ['711cf3ed00ab441a8f54a45058047b7a', 'Verity'],
  ['df3cfdc9b9dd42e9a0f589569f598263', 'Nick Fuentes'],
  ['77d700f718f14e5dbf34ea178b90d098', 'Mike Ma'],
  ['4e4294d4315d48048e688f35a38aa962', 'Shazam Watkins'],
];

const cache = new Map<string, { at: number; voices: FishVoice[] }>();

const toVoice = (m: Record<string, any>): FishVoice => ({
  id: String(m._id), title: String(m.title ?? '').trim() || 'Untitled voice', description: String(m.description ?? '').trim(),
  cover: m.cover_image ? `${COVERS}${m.cover_image}` : '', sample: String(m.samples?.[0]?.audio ?? ''),
  languages: (m.languages ?? []).join(', '), uses: Number(m.task_count) || 0,
});

// With nothing searched: the recommended set. A search reaches the whole community library.
export async function listVoices(q: string, offline: boolean): Promise<FishVoice[]> {
  if (offline) return FIXTURE.filter((v) => !q || v.title.toLowerCase().includes(q.toLowerCase()));
  const key = q.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.voices;
  if (!key) {
    // One that Fish no longer serves is left out rather than failing the rest.
    const got = await Promise.all(RECOMMENDED.map(async ([id, title]) => {
      const res = await fetch(`${BASE}/model/${id}`).catch(() => null);
      if (!res?.ok) return null;
      return { ...toVoice(await res.json()), title };
    }));
    const voices = got.filter((v): v is FishVoice => v != null);
    if (!voices.length) throw new Error('Fish Audio could not be reached.');
    cache.set(key, { at: Date.now(), voices });
    return voices;
  }
  // A search ranks by relevance (`score`): by use, a phrase brings back the most popular voices.
  const params = new URLSearchParams({ page_size: '30', page_number: '1', language: 'en', sort_by: 'score', title: q.trim() });
  const res = await fetch(`${BASE}/model?${params}`);
  if (!res.ok) throw new Error(`Fish Audio answered ${res.status}.`);
  const body = (await res.json()) as { items?: Record<string, any>[] };
  const voices = (body.items ?? []).filter((m) => m.type !== 'svc').map(toVoice);
  cache.set(key, { at: Date.now(), voices });
  return voices;
}
