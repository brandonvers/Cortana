/**
 * The test set for spike 0007. **No imports on purpose** — see `spikes/model.ts`.
 *
 * Two halves, built for opposite reasons.
 *
 * ## The exact-match half
 *
 * Items come in **near-duplicate pairs**: same customer, same wording, same
 * subject, differing only in an identifier. Semantically the two members of a
 * pair are indistinguishable — that is the point. An embedding places them at
 * almost the same coordinates, so a query naming one of them by its number is a
 * coin toss for vector search and trivial for a lexical index.
 *
 * Spike 0006's set had essentially none of these, which is why its verdict on
 * fusion could only speak for the half of the problem where lexical search has
 * nothing to contribute.
 *
 * If pure vector search handles these anyway, criterion 2 fails and the honest
 * answer to ADR-0010 is to delete the lexical indexes rather than reposition
 * them. The set is built so that outcome is possible, not so it is avoided.
 *
 * ## The semantic half
 *
 * Carried over from 0006 unchanged, as a regression check. A strategy that fixes
 * exact matching by breaking semantic retrieval has not helped anyone.
 */

export type Half = 'exact' | 'semantic';

export type Mechanism =
  /** The query names an identifier that appears verbatim in exactly one item. */
  | 'exact-id'
  /** The query names a person or company appearing in exactly one item. */
  | 'exact-name'
  /** The query names a date, in a corpus where several items carry dates. */
  | 'exact-date'
  /** A number — an amount, a quantity — that distinguishes near-identical items. */
  | 'exact-amount'
  /** No content word in common with the item. The vector index's territory. */
  | 'paraphrase'
  /** Different inflected forms of the same word. */
  | 'inflection'
  /** Query typed without diacritics. */
  | 'diacritics';

export type Item = { id: number; half: Half; text: string };
export type Query = { q: string; expect: number; half: Half; mechanism: Mechanism };
export type Dataset = { name: string; items: Item[]; queries: Query[] };

/**
 * Near-duplicate pairs. Read them in twos: 1/2, 3/4, 5/6 and so on. Each pair is
 * the same sentence with one token changed.
 */
const EXACT_ITEMS: Item[] = [
  {
    id: 1,
    half: 'exact',
    text: 'Számla kiállítva Kovács Autósbolt részére, sorszám 2026/0847, összeg 184 500 Ft, fizetési határidő nyolc nap.',
  },
  {
    id: 2,
    half: 'exact',
    text: 'Számla kiállítva Kovács Autósbolt részére, sorszám 2026/0874, összeg 92 300 Ft, fizetési határidő nyolc nap.',
  },
  {
    id: 3,
    half: 'exact',
    text: 'Munkalap: fékbetét- és féktárcsacsere, a jármű rendszáma ABC-123, a munka becsült ideje két óra.',
  },
  {
    id: 4,
    half: 'exact',
    text: 'Munkalap: fékbetét- és féktárcsacsere, a jármű rendszáma ABC-132, a munka becsült ideje két óra.',
  },
  {
    id: 5,
    half: 'exact',
    text: 'Alkatrész megrendelve, cikkszám 11-42-7-566-327, olajszűrő, három darab, szállítás jövő kedden.',
  },
  {
    id: 6,
    half: 'exact',
    text: 'Alkatrész megrendelve, cikkszám 11-42-7-566-372, levegőszűrő, három darab, szállítás jövő kedden.',
  },
  {
    id: 7,
    half: 'exact',
    text: 'Időpont egyeztetve Szabó Péterrel, 2026. szeptember 14., délelőtt tíz óra, a műhelyben.',
  },
  {
    id: 8,
    half: 'exact',
    text: 'Időpont egyeztetve Szabó Péterrel, 2026. szeptember 41., délelőtt tíz óra, a műhelyben.',
  },
  {
    id: 9,
    half: 'exact',
    text: 'Utalás beérkezett a céges számlára, közlemény SZLA-2026-0311, összeg 60 000 Ft.',
  },
  {
    id: 10,
    half: 'exact',
    text: 'Utalás beérkezett a céges számlára, közlemény SZLA-2026-0113, összeg 60 000 Ft.',
  },
  {
    id: 11,
    half: 'exact',
    text: 'Ügyfél elérhetősége rögzítve: Nagy Erika, telefon 06-30-555-1234, e-mail erika.nagy@example.com.',
  },
  {
    id: 12,
    half: 'exact',
    text: 'Ügyfél elérhetősége rögzítve: Nagy Erik, telefon 06-30-555-1243, e-mail erik.nagy@example.com.',
  },
  {
    id: 13,
    half: 'exact',
    text: 'Garanciajegy kiadva, azonosító GJ-77401, a javításra hat hónap garancia jár.',
  },
  {
    id: 14,
    half: 'exact',
    text: 'Garanciajegy kiadva, azonosító GJ-77410, a javításra hat hónap garancia jár.',
  },
  {
    id: 15,
    half: 'exact',
    text: 'Szerviz elvégezve, a kilométeróra állása 148 200 km, a következő ellenőrzés tizenötezer kilométer múlva.',
  },
  {
    id: 16,
    half: 'exact',
    text: 'Szerviz elvégezve, a kilométeróra állása 184 200 km, a következő ellenőrzés tizenötezer kilométer múlva.',
  },
];

const EXACT_QUERIES: Query[] = [
  {
    q: 'Mennyi volt a 2026/0847-es számla összege?',
    expect: 1,
    half: 'exact',
    mechanism: 'exact-id',
  },
  { q: 'Mi van a 2026/0874 sorszámú számlán?', expect: 2, half: 'exact', mechanism: 'exact-id' },
  {
    q: 'Melyik munkalap tartozik az ABC-132 rendszámhoz?',
    expect: 4,
    half: 'exact',
    mechanism: 'exact-id',
  },
  {
    q: 'Mit rendeltünk a 11-42-7-566-372 cikkszámon?',
    expect: 6,
    half: 'exact',
    mechanism: 'exact-id',
  },
  {
    q: 'Mit rendeltünk a 11-42-7-566-327 cikkszámon?',
    expect: 5,
    half: 'exact',
    mechanism: 'exact-id',
  },
  { q: 'Mi tartozik a GJ-77410 azonosítóhoz?', expect: 14, half: 'exact', mechanism: 'exact-id' },
  {
    q: 'Melyik utalás közleménye SZLA-2026-0311?',
    expect: 9,
    half: 'exact',
    mechanism: 'exact-id',
  },
  {
    q: 'Kinek az e-mail címe erik.nagy@example.com?',
    expect: 12,
    half: 'exact',
    mechanism: 'exact-name',
  },
  { q: 'Mi Nagy Erika telefonszáma?', expect: 11, half: 'exact', mechanism: 'exact-name' },
  {
    q: 'Mikorra van megbeszélve a 2026. szeptember 14-i időpont?',
    expect: 7,
    half: 'exact',
    mechanism: 'exact-date',
  },
  { q: 'Melyik számla volt 184 500 Ft?', expect: 1, half: 'exact', mechanism: 'exact-amount' },
  {
    q: 'Melyik szerviznél volt 184 200 km az óra?',
    expect: 16,
    half: 'exact',
    mechanism: 'exact-amount',
  },
];

/**
 * Semantic half — carried over from spike 0006 unchanged. Not re-tuned, not
 * re-selected: a regression check is only a check if it is the same test.
 */
const SEMANTIC_ITEMS: Item[] = [
  { id: 101, half: 'semantic', text: 'Kávéból a sötét pörkölésűt szeretem, tejjel, cukor nélkül.' },
  {
    id: 102,
    half: 'semantic',
    text: 'A szomszéd kutyáját Bogyónak hívják, és nagyon fél a viharoktól.',
  },
  {
    id: 103,
    half: 'semantic',
    text: 'A nyaralást szeptemberre tervezzük, mert akkor olcsóbbak a szállások és kevesebb a turista.',
  },
  {
    id: 104,
    half: 'semantic',
    text: 'A padláson tárolt dobozokban a régi egyetemi jegyzeteim vannak.',
  },
  {
    id: 105,
    half: 'semantic',
    text: 'A mosogatógépbe nem szabad fakanalat tenni, mert megrepedhet a nyele.',
  },
  {
    id: 106,
    half: 'semantic',
    text: 'Az albérlet havi bérleti díját minden hónap ötödikéig kell átutalni a tulajdonosnak.',
  },
  {
    id: 107,
    half: 'semantic',
    text: 'A jogosítványom jövő márciusban jár le, addig meg kell csináltatni az orvosi alkalmasságit.',
  },
  {
    id: 108,
    half: 'semantic',
    text: 'A kerékpárutat felújítják a folyó mellett, a munkálatok októberig tartanak.',
  },
  {
    id: 109,
    half: 'semantic',
    text: 'Az árvíztűrő tükörfúrógép a magyar nyelv klasszikus példamondata a hosszú ékezetes betűkre.',
  },
  {
    id: 110,
    half: 'semantic',
    text: 'Az útlevelem hét évig érvényes, két évvel ezelőtt hosszabbítottam meg.',
  },
  {
    id: 111,
    half: 'semantic',
    text: 'A szobanövényeimet hetente egyszer öntözöm, télen ritkábban.',
  },
  {
    id: 112,
    half: 'semantic',
    text: 'A macskám csak a halas konzervet hajlandó megenni, a csirkéset otthagyja.',
  },
];

const SEMANTIC_QUERIES: Query[] = [
  { q: 'Hogyan kérem a reggeli italomat?', expect: 101, half: 'semantic', mechanism: 'paraphrase' },
  {
    q: 'Melyik állat ijed meg a mennydörgéstől?',
    expect: 102,
    half: 'semantic',
    mechanism: 'paraphrase',
  },
  {
    q: 'Melyik hónapban utazunk pihenni?',
    expect: 103,
    half: 'semantic',
    mechanism: 'paraphrase',
  },
  {
    q: 'Hol tartom a régi tanulmányi papírjaimat?',
    expect: 104,
    half: 'semantic',
    mechanism: 'paraphrase',
  },
  {
    q: 'Mit ne rakjak a gépbe elmosogatni?',
    expect: 105,
    half: 'semantic',
    mechanism: 'paraphrase',
  },
  { q: 'Mikor kell fizetni a lakbért?', expect: 106, half: 'semantic', mechanism: 'paraphrase' },
  { q: 'Mikor jár le a jogosítvány?', expect: 107, half: 'semantic', mechanism: 'inflection' },
  {
    q: 'Meddig tartanak a kerékpárút felújítási munkái?',
    expect: 108,
    half: 'semantic',
    mechanism: 'inflection',
  },
  { q: 'arvizturo tukorfurogep', expect: 109, half: 'semantic', mechanism: 'diacritics' },
  { q: 'mikor jar le az utlevelem', expect: 110, half: 'semantic', mechanism: 'diacritics' },
  {
    q: 'Milyen gyakran locsolom a virágaimat?',
    expect: 111,
    half: 'semantic',
    mechanism: 'paraphrase',
  },
  { q: 'Mit eszik a cicám?', expect: 112, half: 'semantic', mechanism: 'paraphrase' },
];

export const DATASET: Dataset = {
  name: 'exact-match pairs + semantic regression set',
  items: [...EXACT_ITEMS, ...SEMANTIC_ITEMS],
  queries: [...EXACT_QUERIES, ...SEMANTIC_QUERIES],
};

/** A query pointing at a missing item produces a confident zero that looks real. */
export function validate(d: Dataset): string[] {
  const problems: string[] = [];
  const ids = new Set<number>();
  for (const item of d.items) {
    if (ids.has(item.id)) problems.push(`duplicate item id ${item.id}`);
    ids.add(item.id);
  }
  for (const q of d.queries) {
    if (!ids.has(q.expect)) {
      problems.push(`query "${q.q}" expects item ${q.expect}, which does not exist`);
    }
  }
  for (const half of ['exact', 'semantic'] as const) {
    const n = d.queries.filter((q) => q.half === half).length;
    if (n < 10) problems.push(`only ${n} ${half} queries: too few to separate strategies`);
  }
  return problems;
}
