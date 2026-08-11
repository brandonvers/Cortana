/**
 * The test set for spike 0006.
 *
 * **This file has no imports on purpose** — see the note in `spikes/model.ts`.
 *
 * ## What this is, and what it is not
 *
 * Every item is a plausible memory a personal assistant would have stored, and
 * every query is a plausible way of asking for one. Both were written by the same
 * agent that wrote the harness, which makes this set **circular in one direction**:
 * it cannot tell you how the system does on real material, because the queries
 * know what the items say.
 *
 * It is included anyway, and committed, for two reasons a private set cannot
 * serve:
 *
 * 1. **Reproducibility.** `spikes/README.md` says a result only means something if
 *    someone else can re-run it. A model comparison decided on data nobody else
 *    can see is a claim, not a measurement.
 * 2. **Mechanism coverage.** Real material contains whatever it happens to
 *    contain. This set is constructed so that each retrieval failure mode is
 *    exercised deliberately and can be reported separately — an aggregate recall
 *    number hides which half of the index is doing the work.
 *
 * The authoritative number for choosing a default model comes from a private set
 * of real material, passed with `DATASET=/path/to/file.json`. Both numbers go in
 * the report.
 *
 * ## Why Hungarian
 *
 * It stands in for the whole class of languages the SQLite FTS5 stemmer does not
 * cover: agglutinative, heavily suffixed, compounding, with diacritics that people
 * routinely omit when typing. [Spike 0002](../../docs/spikes/0002-sqlite-vec-fts5-multilingual.md)
 * proved lexical search fails on such languages; this one asks whether the
 * embedding half actually rescues it, and by how much.
 *
 * **English is here as a control, not as a target.** The gap between a model's
 * English score and its Hungarian score is the quantity
 * [ADR-0012](../../docs/adr/0012-local-embeddings.md) is worried about: an
 * English-first model does not fail on other languages, it quietly gets worse.
 * Measuring only Hungarian would show a low number with nothing to compare it to.
 *
 * A contributor who speaks another morphologically rich language — Finnish,
 * Turkish, Estonian, Tamil — adding a set in the same shape would make this
 * materially better. The shape is deliberately trivial to extend.
 */

/** What each query is designed to break. Reported separately, never averaged away. */
export type Mechanism =
  /** Query and item use different inflected forms of the same word. */
  | 'inflection'
  /** The item's word is a compound containing the query's word. */
  | 'compound'
  /**
   * No content word in common — the vector index is what should bridge these.
   * "Should", not "must": a dry run with random vectors still scored well over
   * half of them, because the trigram index matches short substrings and
   * Hungarian words that mean related things often share a stem fragment
   * (`bérleti` / `lakbért`). Treat this row as the vector index's best
   * opportunity, not as its exclusive territory.
   */
  | 'paraphrase'
  /** Query typed without diacritics, as people actually type. */
  | 'diacritics'
  /** Possessive or colloquial form against the stored one. */
  | 'possessive'
  /** Other items share vocabulary with the query; only one is right. */
  | 'distractor'
  /**
   * The item is longer than a short model's context window, and the queried
   * fact sits in its last sentence.
   *
   * Added after the first run, which was won by a 512-token model on a set where
   * every item was one sentence. That is not a comparison, it is a pitch the
   * winner was allowed to choose. A model that truncates at 512 tokens does not
   * error — it embeds the first part and silently loses the rest, which is the
   * exact failure ADR-0012 exists to prevent.
   */
  | 'truncation';

export type Item = { id: number; lang: 'hu' | 'en'; text: string };
export type Query = { q: string; expect: number; lang: 'hu' | 'en'; mechanism: Mechanism };
export type Dataset = { name: string; items: Item[]; queries: Query[] };

/**
 * Hungarian memory items. Generic household and personal-admin material on
 * purpose: the framework's core knows no domain, so neither does its test set.
 *
 * Several items deliberately share vocabulary — three concern paying for
 * something, two concern a document expiring, three concern an animal being fed
 * or kept. Without those, a retrieval test measures little: any index looks
 * excellent when every item is about a different subject.
 */
const HU_ITEMS: Item[] = [
  {
    id: 1,
    lang: 'hu',
    text: 'A fogorvosi időpont csütörtökön délután háromkor van a belvárosi rendelőben.',
  },
  {
    id: 2,
    lang: 'hu',
    text: 'Az albérlet havi bérleti díját minden hónap ötödikéig kell átutalni a tulajdonosnak.',
  },
  {
    id: 3,
    lang: 'hu',
    text: 'A nagymamám születésnapja november tizenkettedikén van, mindig virágot szoktam vinni neki.',
  },
  {
    id: 4,
    lang: 'hu',
    text: 'A biciklim hátsó gumija defektes, a szerviz azt mondta, hogy a belsőt is cserélni kell.',
  },
  {
    id: 5,
    lang: 'hu',
    text: 'A jogosítványom jövő márciusban jár le, addig meg kell csináltatni az orvosi alkalmasságit.',
  },
  { id: 6, lang: 'hu', text: 'Kávéból a sötét pörkölésűt szeretem, tejjel, cukor nélkül.' },
  { id: 7, lang: 'hu', text: 'A szomszéd kutyáját Bogyónak hívják, és nagyon fél a viharoktól.' },
  {
    id: 8,
    lang: 'hu',
    text: 'A gépjárműadót két részletben kell befizetni, március tizenötödikéig és szeptember tizenötödikéig.',
  },
  {
    id: 9,
    lang: 'hu',
    text: 'A nyaralást szeptemberre tervezzük, mert akkor olcsóbbak a szállások és kevesebb a turista.',
  },
  {
    id: 10,
    lang: 'hu',
    text: 'Az edzőterembe hétfőn és szerdán szoktam járni, általában este hétkor.',
  },
  {
    id: 11,
    lang: 'hu',
    text: 'A laptopom akkumulátora másfél óra alatt lemerül, ha nincs bedugva a töltő.',
  },
  {
    id: 12,
    lang: 'hu',
    text: 'A kutyaeledelt nagy kiszerelésben éri meg venni, a kisebb zacskó másfélszer drágább kilónként.',
  },
  {
    id: 13,
    lang: 'hu',
    text: 'A repülőjegyet mindig kézipoggyásszal foglalom, mert a feladott bőrönd sokat drágít.',
  },
  {
    id: 14,
    lang: 'hu',
    text: 'A vízórát évente egyszer kell leolvasni és bediktálni a szolgáltatónak.',
  },
  {
    id: 15,
    lang: 'hu',
    text: 'Az árvíztűrő tükörfúrógép a magyar nyelv klasszikus példamondata a hosszú ékezetes betűkre.',
  },
  {
    id: 16,
    lang: 'hu',
    text: 'A szemüvegem lencséjén karcolás van, az optikus szerint nem javítható, cserélni kell.',
  },
  { id: 17, lang: 'hu', text: 'A húgom Szegeden tanul jogot, a második évét kezdi szeptemberben.' },
  {
    id: 18,
    lang: 'hu',
    text: 'A mosogatógépbe nem szabad fakanalat tenni, mert megrepedhet a nyele.',
  },
  {
    id: 19,
    lang: 'hu',
    text: 'A telefonszámlát átutalással fizetem, de a csoportos beszedés olcsóbb lenne.',
  },
  { id: 20, lang: 'hu', text: 'A szobanövényeimet hetente egyszer öntözöm, télen ritkábban.' },
  {
    id: 21,
    lang: 'hu',
    text: 'A kerékpárutat felújítják a folyó mellett, a munkálatok októberig tartanak.',
  },
  {
    id: 22,
    lang: 'hu',
    text: 'A fűnyírót minden tavasszal meg kell élezni, különben szakítja a füvet.',
  },
  {
    id: 23,
    lang: 'hu',
    text: 'Az útlevelem hét évig érvényes, két évvel ezelőtt hosszabbítottam meg.',
  },
  {
    id: 24,
    lang: 'hu',
    text: 'A macskám csak a halas konzervet hajlandó megenni, a csirkéset otthagyja.',
  },
  { id: 25, lang: 'hu', text: 'A padláson tárolt dobozokban a régi egyetemi jegyzeteim vannak.' },
  {
    id: 26,
    lang: 'hu',
    text: 'A kenyeret a sarki pékségben veszem, mert ott reggel hatkor már friss.',
  },
];

const HU_QUERIES: Query[] = [
  // Inflection — the form differs, the word is the same. FTS5 has no Hungarian
  // stemmer, so `unicode61` cannot match these and only the trigram index or the
  // vector index can.
  { q: 'Mikor jár le a jogosítvány?', expect: 5, lang: 'hu', mechanism: 'inflection' },
  {
    q: 'Meddig tartanak a kerékpárút felújítási munkái?',
    expect: 21,
    lang: 'hu',
    mechanism: 'inflection',
  },
  {
    q: 'Mennyibe kerül a kutyaeledel nagyobb kiszerelésben?',
    expect: 12,
    lang: 'hu',
    mechanism: 'inflection',
  },
  { q: 'Hol van a fogorvos rendelője?', expect: 1, lang: 'hu', mechanism: 'inflection' },
  { q: 'Mit csinálok a fűnyíróval?', expect: 22, lang: 'hu', mechanism: 'inflection' },

  // Compound — Hungarian glues words together, so the query's word is a
  // substring of the item's. Trigram should get these; unicode61 should not.
  { q: 'Mennyi az adó a járművem után?', expect: 8, lang: 'hu', mechanism: 'compound' },
  { q: 'Hol veszek friss péksüteményt reggel?', expect: 26, lang: 'hu', mechanism: 'compound' },
  { q: 'Mikor kell leolvasni az órát a víznél?', expect: 14, lang: 'hu', mechanism: 'compound' },
  { q: 'Hány órakor van edzés?', expect: 10, lang: 'hu', mechanism: 'compound' },

  // Paraphrase — no content word in common with the item. Lexical search cannot
  // succeed here by construction; if the fused result finds these, the vector
  // index is the reason.
  { q: 'Hogyan kérem a reggeli italomat?', expect: 6, lang: 'hu', mechanism: 'paraphrase' },
  { q: 'Melyik állat ijed meg a mennydörgéstől?', expect: 7, lang: 'hu', mechanism: 'paraphrase' },
  {
    q: 'Hol tartom a régi tanulmányi papírjaimat?',
    expect: 25,
    lang: 'hu',
    mechanism: 'paraphrase',
  },
  { q: 'Melyik hónapban utazunk pihenni?', expect: 9, lang: 'hu', mechanism: 'paraphrase' },
  { q: 'Hol tanul a testvérem?', expect: 17, lang: 'hu', mechanism: 'paraphrase' },
  { q: 'Mikor kell fizetni a lakbért?', expect: 2, lang: 'hu', mechanism: 'paraphrase' },
  { q: 'Milyen gyakran locsolom a virágaimat?', expect: 20, lang: 'hu', mechanism: 'paraphrase' },
  { q: 'Miért nem viszek nagy csomagot a gépre?', expect: 13, lang: 'hu', mechanism: 'paraphrase' },

  // Diacritics — typed the way people type on a phone. `remove_diacritics 2`
  // exists for exactly this, and it is the one lexical mechanism expected to work
  // on Hungarian.
  { q: 'arvizturo tukorfurogep', expect: 15, lang: 'hu', mechanism: 'diacritics' },
  { q: 'mikor jar le az utlevelem', expect: 23, lang: 'hu', mechanism: 'diacritics' },
  { q: 'meddig birja a laptop akkumulatora', expect: 11, lang: 'hu', mechanism: 'diacritics' },
  { q: 'mit nem szabad a mosogatogepbe tenni', expect: 18, lang: 'hu', mechanism: 'diacritics' },

  // Possessive and colloquial — the stored form and the spoken form differ.
  { q: 'Mikor van a nagyi szülinapja?', expect: 3, lang: 'hu', mechanism: 'possessive' },
  { q: 'Mit eszik a cicám?', expect: 24, lang: 'hu', mechanism: 'possessive' },
  { q: 'Mi baja a bringámnak?', expect: 4, lang: 'hu', mechanism: 'possessive' },

  // Distractors — every one of these has at least one wrong item that shares
  // vocabulary with the query. These are where precision is decided, and where a
  // model that merely detects the topic stops being good enough.
  { q: 'Melyik dokumentumom jár le tavasszal?', expect: 5, lang: 'hu', mechanism: 'distractor' },
  { q: 'Mit fizetek átutalással?', expect: 19, lang: 'hu', mechanism: 'distractor' },
  { q: 'Melyik kisállatnak veszek konzervet?', expect: 24, lang: 'hu', mechanism: 'distractor' },
  { q: 'Mi a baj a szemüvegemmel?', expect: 16, lang: 'hu', mechanism: 'distractor' },
];

/**
 * Long items, with the queried fact deliberately in the **last sentence**.
 *
 * Every one of these is longer than 512 tokens in Hungarian, which tokenises
 * poorly — a model with a short context window embeds the opening and never sees
 * the ending. Nothing warns you: the vector comes back the right shape, the
 * query returns results, and the right memory is simply never among them.
 *
 * These exist because the first run of this spike was won by a 512-token model
 * on a set of one-sentence items. The test set had decided the winner.
 */
const LONG_ITEMS: Item[] = [
  {
    id: 201,
    lang: 'hu',
    text: [
      'Feljegyzés a lakásfelújításról. A tervezés még tavasszal elkezdődött, amikor kiderült, hogy a fürdőszoba csempézése alatt a vakolat több helyen elázott, és a javítás nem oldható meg egy egyszerű átfestéssel.',
      'Az első mesterember, aki kijött felmérni, azt mondta, hogy a teljes falfelületet le kell verni a csempével együtt, mert a nedvesség bejutott a fal szerkezetébe, és ha csak a látható részt javítjuk, néhány hónapon belül újra megjelenik a penész.',
      'A második vállalkozó ennél óvatosabb volt, és javasolta, hogy először szárítsuk ki a falat, mielőtt bármilyen bontásba kezdenénk, mert lehet, hogy a probléma forrása nem a fürdőszobában van, hanem a szomszédos konyhában futó vízvezetékben.',
      'Ezt követően felkerestünk egy harmadik szakembert is, aki nedvességmérővel végigmérte a falakat, és megerősítette, hogy a konyha felőli oldal határozottan nedvesebb, tehát a vezetéket mindenképpen meg kell nézni, mielőtt bármit visszaépítenénk.',
      'A költségekről is beszéltünk hosszan, mert a három ajánlat között jelentős eltérés volt, és nem volt azonnal világos, hogy a különbség a munka minőségéből, az anyagok árából, vagy egyszerűen az eltérő ütemezésből adódik-e.',
      'Az anyagbeszerzést végül úgy oldottuk meg, hogy a csempét és a ragasztót magunk vettük meg egy nagykereskedésben, a munkadíjat pedig külön állapodtuk meg, ami összességében olcsóbbnak bizonyult, mint a teljes körű ajánlatok bármelyike.',
      'Az ütemezés miatt a munka végül két szakaszra bomlott, mert a szárítás önmagában közel három hetet vett igénybe, és addig a fürdőszobát nem lehetett rendeltetésszerűen használni.',
      'Volt egy vita arról is, hogy érdemes-e egyúttal a padlófűtést is kiépíteni, mivel a padló amúgy is felbontásra kerül, és később már sokkal drágább lenne visszatérni rá.',
      'Végül a döntés az lett, hogy a padlófűtés kimarad, mert a rendszer átalakítása a kazánt is érintené, és arra idén nincs keret.',
      'A lényeg, amit meg kell jegyezni: a felújítás alatti időszakra a biztosító külön lakhatási támogatást fizet, de csak akkor, ha a kárbejelentés a bontás megkezdése előtt megtörtént.',
    ].join(' '),
  },
  {
    id: 202,
    lang: 'hu',
    text: [
      'Összefoglaló az autó szervizeléséről és a hozzá tartozó ügyintézésről. A kocsi január óta furcsa hangot adott indításkor, főleg hideg időben, és eleinte azt hittük, hogy az akkumulátor gyengült le a tél miatt.',
      'A szerviz először valóban az akkumulátort mérte meg, és az eredmény határértéken volt, tehát nem lehetett egyértelműen kizárni, de nem is magyarázta meg teljesen a jelenséget.',
      'A második alkalommal az önindítót vizsgálták meg, és kiderült, hogy a bendix fogaskerék kopott, ami pontosan azt a csikorgó hangot okozza, amit hallottunk, de a csere nem sürgős, amíg a motor elindul.',
      'Szóba került a vezérműszíj is, mert a szervizkönyv szerint a csere esedékessé vált volna a következő tízezer kilométeren belül, és ha az önindítót amúgy is szétszedik, akkor a két munka részben összevonható.',
      'Az árajánlat ezért két változatban készült el, egy szűkebbre szabott javítással és egy teljesebb csomaggal, amelyben a szíj, a vízpumpa és a feszítőgörgő is benne van.',
      'A tulajdonos hosszan mérlegelte, hogy megéri-e a nagyobb csomag, tekintve hogy az autó életkora és futásteljesítménye alapján a következő két évben amúgy is számítani lehet további javításokra.',
      'Külön téma volt a biztosítás, mert az évfordulós felmondási határidő éppen a szerviz idejére esett, és ha akkor nem történik intézkedés, a szerződés automatikusan meghosszabbodik a régi díjjal.',
      'A gumicseréről is beszéltünk, mivel a nyári gumik profilmélysége már a törvényi határ közelében járt, és a nyaralásra tervezett hosszabb út előtt ez kockázatos lett volna.',
      'A szerviz azt javasolta, hogy a gumikat a javítással egy időben cseréljük, mert így a kerekek levételéért nem számolnak fel külön munkadíjat.',
      'Amit fontos megjegyezni: a szerviz a garanciát csak akkor vállalja a javításra, ha a következő ellenőrzés hatvan napon belül megtörténik.',
    ].join(' '),
  },
  {
    id: 203,
    lang: 'hu',
    text: [
      'Jegyzet a költözésről és az ahhoz kapcsolódó teendőkről. Az új lakás átvétele eredetileg a hónap elejére volt kitűzve, de a korábbi bérlő kérte a határidő eltolását, mert az ő új lakhatása csúszott.',
      'Ez az egész ütemtervet felborította, mert a bútorszállítást már lefoglaltuk, és a cég a lemondásért díjat számol fel, ha az a szállítás előtt kevesebb mint egy héttel történik.',
      'A dobozolást szerencsére korábban elkezdtük, így a ruhák és a könyvek nagy része már be volt csomagolva, de a konyhai eszközök még mindig használatban voltak, azokat nem lehetett előre elpakolni.',
      'Az internetszolgáltatóval külön kellett egyeztetni, mert az átköltöztetés nem automatikus, és az új címen csak akkor tudják aktiválni a szolgáltatást, ha a régi címen már lezárták.',
      'A közüzemi mérőórák átírása is külön ügyintézést igényelt, mindegyik szolgáltatónál másképp, és az egyiknél személyes megjelenés is kellett, amit nehéz volt beilleszteni a munkaidőbe.',
      'A régi lakásban maradt néhány beépített bútor, amelyekről meg kellett állapodni a tulajdonossal, hogy ott maradnak-e vagy elvisszük őket, mert a szerződés erről nem rendelkezett egyértelműen.',
      'A takarítást végül külön cégre bíztuk, mert az átadás feltétele a tiszta állapot volt, és a költözés napján erre már nem maradt volna energia.',
      'A postai átirányítást is meg kellett igényelni, mert több hivatalos levél érkezik még a régi címre, és ezek egy részének határideje van.',
      'A kulcsok átadásáról jegyzőkönyvet készítettünk, amelyben rögzítettük a mérőórák állását és a lakás állapotát, fényképekkel együtt.',
      'A legfontosabb, ami könnyen elfelejtődik: a kaució visszafizetésére a tulajdonosnak harminc napja van az átadás-átvételi jegyzőkönyv aláírásától számítva.',
    ].join(' '),
  },
];

const LONG_QUERIES: Query[] = [
  { q: 'Meddig kell visszafizetni a kauciót?', expect: 203, lang: 'hu', mechanism: 'truncation' },
  {
    q: 'Mi a feltétele a szerviz garanciájának?',
    expect: 202,
    lang: 'hu',
    mechanism: 'truncation',
  },
  {
    q: 'Mikor kell bejelenteni a kárt a biztosítónak?',
    expect: 201,
    lang: 'hu',
    mechanism: 'truncation',
  },
];

/**
 * English control. Same shapes, same distractor pressure, minus the two
 * mechanisms English does not have. The number that matters is not this set's
 * score but its **distance** from the Hungarian one.
 */
const EN_ITEMS: Item[] = [
  {
    id: 101,
    lang: 'en',
    text: 'The dentist appointment is on Thursday afternoon at three, at the clinic downtown.',
  },
  {
    id: 102,
    lang: 'en',
    text: 'Rent has to be transferred to the landlord by the fifth of every month.',
  },
  {
    id: 103,
    lang: 'en',
    text: "My grandmother's birthday is the twelfth of November, and I always bring her flowers.",
  },
  {
    id: 104,
    lang: 'en',
    text: 'The rear tyre on my bike is flat, and the shop says the inner tube needs replacing too.',
  },
  {
    id: 105,
    lang: 'en',
    text: 'My driving licence expires next March, so the medical certificate has to be renewed before then.',
  },
  { id: 106, lang: 'en', text: 'I take my coffee dark roast, with milk and no sugar.' },
  {
    id: 107,
    lang: 'en',
    text: "The neighbour's dog is called Bogyó and is terrified of thunderstorms.",
  },
  {
    id: 108,
    lang: 'en',
    text: 'Vehicle tax is paid in two instalments, by the fifteenth of March and the fifteenth of September.',
  },
  {
    id: 109,
    lang: 'en',
    text: 'We are planning the holiday for September, when accommodation is cheaper and there are fewer tourists.',
  },
  {
    id: 110,
    lang: 'en',
    text: 'I go to the gym on Mondays and Wednesdays, usually at seven in the evening.',
  },
  {
    id: 111,
    lang: 'en',
    text: 'The laptop battery runs down in about ninety minutes if the charger is not plugged in.',
  },
  {
    id: 112,
    lang: 'en',
    text: 'The cat will only eat the fish tins and leaves the chicken ones untouched.',
  },
];

const EN_QUERIES: Query[] = [
  { q: 'How do I take my morning drink?', expect: 106, lang: 'en', mechanism: 'paraphrase' },
  { q: 'Which animal is scared of thunder?', expect: 107, lang: 'en', mechanism: 'paraphrase' },
  {
    q: 'Which month are we travelling to relax?',
    expect: 109,
    lang: 'en',
    mechanism: 'paraphrase',
  },
  {
    q: 'How long does the computer last unplugged?',
    expect: 111,
    lang: 'en',
    mechanism: 'paraphrase',
  },
  { q: 'When does my licence expire?', expect: 105, lang: 'en', mechanism: 'inflection' },
  { q: 'When is the tooth doctor visit?', expect: 101, lang: 'en', mechanism: 'inflection' },
  { q: 'When do I work out?', expect: 110, lang: 'en', mechanism: 'inflection' },
  { q: "What is wrong with my bicycle's wheel?", expect: 104, lang: 'en', mechanism: 'inflection' },
  {
    q: 'Which document of mine expires in spring?',
    expect: 105,
    lang: 'en',
    mechanism: 'distractor',
  },
  {
    q: 'What do I pay by bank transfer each month?',
    expect: 102,
    lang: 'en',
    mechanism: 'distractor',
  },
  { q: 'Which pet do I buy tins for?', expect: 112, lang: 'en', mechanism: 'distractor' },
  { q: 'When is the tax due?', expect: 108, lang: 'en', mechanism: 'distractor' },
];

export const PUBLIC_DATASET: Dataset = {
  name: 'public (hu + long + en control)',
  items: [...HU_ITEMS, ...LONG_ITEMS, ...EN_ITEMS],
  queries: [...HU_QUERIES, ...LONG_QUERIES, ...EN_QUERIES],
};

/**
 * Validates a dataset before anything is measured against it.
 *
 * A test set with a query pointing at a missing item produces a confident zero
 * that looks like a model failure. This is cheap and it runs on the private set
 * too, which is the one nobody has proofread.
 */
export function validate(d: Dataset): string[] {
  const problems: string[] = [];
  const ids = new Set<number>();
  for (const item of d.items) {
    if (ids.has(item.id)) problems.push(`duplicate item id ${item.id}`);
    ids.add(item.id);
    if (!item.text.trim()) problems.push(`item ${item.id} is empty`);
  }
  for (const q of d.queries) {
    if (!ids.has(q.expect))
      problems.push(`query "${q.q}" expects item ${q.expect}, which does not exist`);
    if (!q.q.trim()) problems.push(`empty query expecting item ${q.expect}`);
  }
  if (d.queries.length < 20) {
    problems.push(`only ${d.queries.length} queries: too few to separate models from noise`);
  }
  return problems;
}
