/**
 * names.js — Name-based gender signal.
 *
 * Fixes a real v1 bug: analyzeUsername() used substring matching against a
 * list containing 'man', so `rehmanna`, `salmanaz`, `germany_girl` and
 * `womanpower` all scored 8/100 (male). v2 tokenises on separators and
 * matches whole tokens only.
 *
 * Score convention: 100 = certainly female, 0 = certainly male, 50 = unknown.
 */

import { signal } from './evidence.js';

let dict = new Map();
let dictLoaded = false;
let loadPromise = null;

/** Curated overrides — kept from v1, these were genuinely good. */
const HARD_MALE = `
rana rafi rafiq rayan rayhan raihan rubel russel ruhul rukon arif ariful ariyan arman arnob
arsalan ashraf asif asad asadullah farhan farhad fahim faysal farid faisal fazle faruk habib
hasan hassan hossain hamid hadi harun hilal ibrahim imran ismail irfan iqbal imon jahangir
jakir javed jamal jasim jobayer kabir kamrul karim khalid khandaker khokon limon labib latif
lutfor mahbub mahmud mahmudul masum masud mizan monir mosharraf moshiur nahid nasir nazrul
nazmul noman nuruzzaman nurul omar osman palash parvez pavel pollob rabbi rahmat rasel rashid
ripon riaz rifat rishad sabbir saddam sagor saiful sajib saju sakib salim saqib sarwar shahin
shakil shamim sharif shohag shohel shuvo siam sirajul sohag sohel sohan tahmid tanvir taufiq
touhid tawhid towhid tuhin wahid walid zahid zakir zaman ziaul ahmed ahmad ahmmed ali amir amin
anwar bilal burhan syed sheikh shaikh ferdous firdous roushan rawshan joy alam saqib saquib
shukh sakib shakib mir molla mia miah sarker sardar khandker matin motin mannan hannan sobhan
zaman rahman rahaman rehman rohman mostafa moinul moin mainul nayan nayem noyon opu ovi
hamza hussain kamal kamil malik marwan mohamad mohammad mohammed muhamad muhammad munir mustafa
nasser sami sameer tariq umar waleed yasir yusuf zaid aakash abhijit abhinav abhishek ajay ajit
akash anand anil arun deepak dinesh gaurav girish gopal kiran krishna kunal manish mohan naveen
nikhil nitin pankaj pradeep prakash pramod prashant praveen rahul rajesh rajiv rakesh ramesh
ravi rohit sachin sandeep sanjay santosh saurabh shyam subhash sudhir sunil suresh vijay vikas
vikram vinay vinod vishal james john robert michael william david richard joseph thomas charles
daniel matthew anthony mark donald steven paul andrew joshua kevin brian george edward ronald
timothy jason jeffrey ryan jacob gary nicholas eric stephen jonathan larry justin scott brandon
benjamin samuel gregory alexander patrick frank raymond jack dennis jerry tyler aaron jose adam
nathan henry douglas zachary peter kyle ethan walter noah jeremy christian keith roger terry
gerald harold sean austin carl arthur lawrence dylan jesse jordan bryan billy bruce gabriel
`.trim().split(/\s+/);

const HARD_FEMALE = `
sadia sumaiya sumaya sultana shirin shefali sharmin shanta sanjida samira salma saima rumana
rubina rozina rokeya rita rimi rifa rehana rasheda rahima priya poly parvin nusrat nupur nishat
nilufa naznin nazma nasrin nargis mousumi moriom mitu misty mim mehnaz maya masuma marufa mahi
mahmuda lima laboni kulsum khadija jesmin jannat jannatul ishrat ismat irin ifat hosne hasina
farzana farhana fatema fahmida dilruba chaity bristy bonna bithi bipasha ayesha asma arifa anika
afsana afroza aklima akhi aditi abida ruma shilpi shampa shathi shabnam roksana rehnuma rakhi
purnima piya nadia mun moni monira mukta lipi laila kazi jharna jharna hena habiba fouzia dola
dipa champa bulbul bela ayla anju amena amina alia aisha khaleda taslima tania tanjila tasnim
tahmina sabina shahnaz shahana rowshon rabeya nasima nazneen jesmine hafsa fariha bushra shreya
sneha simran shruti sonia sunita swati tanvi trisha uma vaishali vandana varsha vidya anjali
anita archana asha bharti bhavna chandni deepa deepika divya gayatri geeta gita hema indira
jaya jyoti kajal kalpana kamala kavita komal lakshmi lata madhu mala mamta manju meena meera
mona nandini neelam neha nidhi nisha pooja poonam pratibha preeti radha rani rashmi rekha renu
riya ruchi sangeeta sarita savita seema shalini shanti sharda shobha shweta smita sudha sushma
usha vandana veena vinita mary patricia jennifer linda elizabeth barbara susan jessica sarah
karen nancy lisa margaret betty sandra ashley dorothy kimberly emily donna michelle carol amanda
melissa deborah stephanie rebecca laura sharon cynthia kathleen amy shirley angela helen anna
brenda pamela nicole ruth katherine samantha christine emma catherine debra virginia rachel
carolyn janet maria heather diane julie joyce victoria kelly christina joan evelyn lauren judith
olivia frances martha cheryl megan andrea hannah jacqueline ann jean alice kathryn gloria teresa
doris sara janice julia marie madison grace judy theresa beverly denise marilyn amber danielle
abigail brittany rose natalie sophia isabella charlotte mia amelia harper evelyn luna camila
gianna elena nora lily eleanor hazel violet aurora savannah audrey brooklyn bella claire skylar
lucy paisley everly anna caroline nova genesis emilia kennedy maya willow kinsley naomi aaliyah
elena sarah ariana allison gabriella alice madelyn cora ruby eva serenity autumn adeline hailey
gianna valentina isla eliana quinn nevaeh ivy sadie piper lydia alexa josephine emery julia
delilah arianna vivian kaylee sophie brielle madeline peyton rylee clara hadley melanie mackenzie
reagan adalynn liliana aubree jade katherine isabelle natalia raelynn maria athena ximena arya
leilani taylor faith rose kylie alexandra mary margaret lyla ashley amaya eliza brianna bailey
andrea khloe jasmine melody iris isabel norah annabelle valeria emerson adalyn ryleigh eden
emersyn anastasia kayla alyssa juliana charlie esther ariel cecilia valerie alina molly reese
aliyah lilly parker finley morgan sydney jordyn eloise trinity daisy kimberly lauren genevieve
sara arabella harmony elise remi teagan alexis laila myla londyn juniper jocelyn alaina matilda
`.trim().split(/\s+/);

export async function loadNameDb() {
  if (dictLoaded) return dict;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Curated lists first (they act as authoritative overrides).
    for (const n of HARD_MALE) dict.set(n, 4);
    for (const n of HARD_FEMALE) dict.set(n, 96);

    // Bulk dataset, if bundled. Never fatal if missing.
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
        const url = chrome.runtime.getURL('public/data/names.json');
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          for (const [name, score] of Object.entries(data)) {
            const k = name.toLowerCase();
            if (!dict.has(k)) dict.set(k, score); // curated wins
          }
        }
      }
    } catch (_) { /* bundled dataset optional */ }

    dictLoaded = true;
    return dict;
  })();

  return loadPromise;
}

/** Test seam. */
export function _setDict(entries) {
  dict = new Map(entries);
  dictLoaded = true;
  loadPromise = null;
}

/** Tokens that mark a MALE name but are rarely the given name itself. */
export const MALE_MARKERS = new Set([
  'syed','sayed','sayeed','sheikh','shaikh','mohammad','mohammed','muhammad','muhammed',
  'md','mohd','abu','ibn','bin','mir','mia','miah','molla','mollah','sarker','sardar',
  'khandker','khandaker','shah','hafez','hafiz','qazi','maulana','mufti','pir',
]);

/**
 * Shared family names. These say nothing about gender — "Tasnim Rahman" is a
 * woman — so a hit here must never drive the verdict on its own.
 */
export const SURNAMES = new Set([
  'rahman','rahaman','rehman','rohman','islam','hossain','hosen','ahmed','ahmad','ahmmed',
  'khan','chowdhury','choudhury','sarker','sardar','uddin','haque','hoque','alam','kabir',
  'karim','mia','miah','molla','sheikh','shaikh','biswas','das','dey','ghosh','saha','roy',
  'sharma','verma','singh','gupta','patel','kumar','reddy','nair','iyer','mondal','mandal',
  'talukder','bhuiyan','bhuyan','majumder','sikder','howlader','pramanik','malik','ansari',
  'siddique','siddiqui','akand','akanda','joarder','munshi','matbar','fakir','gazi',
]);

/** Tokens that mark a FEMALE name the same way. */
export const FEMALE_MARKERS = new Set([
  'begum','khatun','bibi','banu','nesa','nessa','akter','akhter','aktar','khanam',
  'sultana','devi','kumari','bai','umme','ummay','binte','bint','mst','most','musammat',
]);

export function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\u0980-\u09FF\u0600-\u06FF]/g, '');
}

export function lookupName(first) {
  const k = normalizeToken(first);
  if (!k) return null;
  return dict.has(k) ? { score: dict.get(k), name: k } : null;
}

export const SUFFIX_RULES = [
  { kind: 'suffix', v: 'devi',  score: 95 },
  { kind: 'suffix', v: 'iyat',  score: 90 },
  { kind: 'prefix', v: 'umm',   score: 94 },
  { kind: 'suffix', v: 'ara',   score: 86 },
  { kind: 'suffix', v: 'iya',   score: 86 },
  { kind: 'suffix', v: 'ita',   score: 84 },
  { kind: 'suffix', v: 'ima',   score: 84 },
  { kind: 'suffix', v: 'isa',   score: 83 },
  { kind: 'suffix', v: 'ina',   score: 82 },
  { kind: 'suffix', v: 'ida',   score: 82 },
  { kind: 'suffix', v: 'una',   score: 80 },
  { kind: 'suffix', v: 'ata',   score: 80 },
  { kind: 'suffix', v: 'een',   score: 74 },
  { kind: 'suffix', v: 'ullah', score: 6  },
  { kind: 'suffix', v: 'uddin', score: 5  },
  { kind: 'suffix', v: 'ur',    score: 22 },
];

export function applySuffixRules(fullName) {
  const words = String(fullName || '').toLowerCase().split(/\s+/).map(normalizeToken).filter(Boolean);
  for (const w of words) {
    for (const r of SUFFIX_RULES) {
      if (r.kind === 'suffix' && w.length > r.v.length + 1 && w.endsWith(r.v)) {
        return { score: r.score, rule: `-${r.v}` };
      }
      if (r.kind === 'prefix' && w.length > r.v.length + 1 && w.startsWith(r.v)) {
        return { score: r.score, rule: `${r.v}-` };
      }
    }
  }
  return null;
}

const NGRAMS = {
  elle: 10, ine: 6, ia: 5, ana: 6, ina: 7, ita: 6, tte: 5, ssa: 5,
  lie: 5, ley: 4, lyn: 5, ara: 5, ira: 4, ila: 4, uma: 4, ima: 5, ida: 5, iya: 6,
};

export function applyCharNgram(fullName) {
  const w = normalizeToken(String(fullName || '').split(/\s+/)[0]);
  if (w.length < 3) return null;
  let hits = 0;
  for (const [g, wt] of Object.entries(NGRAMS)) {
    if (w.endsWith(g)) hits += wt;
  }
  if (!hits) return null;
  return { score: Math.min(78, 50 + hits * 2.6) };
}

// ─── Username analysis (v1 substring bug fixed) ────────────────────────────
const FEMALE_TOKENS = new Set([
  'girl','girls','woman','women','queen','mama','mommy','babe','baby','lady','princess',
  'bella','rose','angel','goddess','diva','missy','chica','femme','mrs','miss','madam',
  'sis','sister','bhabi','apu','begum','khatun','rani','devi','beti',
]);
const MALE_TOKENS = new Set([
  'guy','guys','man','men','bro','brother','king','boss','dude','mr','sir','boy','boys',
  'papa','daddy','father','husband','bhai','vai','khan','mia','shah','uncle','sonu',
]);

/**
 * Tokenise on separators/digits so 'rehmanna' no longer matches 'man'.
 */
export function analyzeUsername(username) {
  const tokens = String(username || '')
    .toLowerCase()
    .split(/[._\-0-9]+/)
    .filter(Boolean);

  for (const t of tokens) {
    if (FEMALE_TOKENS.has(t)) return { score: 88, token: t };
    if (MALE_TOKENS.has(t)) return { score: 10, token: t };
  }
  if (tokens.some(t => MALE_MARKERS.has(t)))   return { score: 12, token: 'honorific' };
  if (tokens.some(t => FEMALE_MARKERS.has(t))) return { score: 88, token: 'honorific' };

  // Dictionary hits across ALL tokens. A username like "nafizur_rahman_iram"
  // carries male tokens the display name never shows, so collect every hit
  // and let the majority decide instead of returning on the first match.
  const hits = [];
  for (const t of tokens) {
    const hit = lookupName(t);
    if (hit) hits.push({ score: hit.score, token: t });
  }
  // Concatenated handles ("tanvirahmed", "sadiaphotography") never split on a
  // separator, so try to find a known name inside each long token.
  //
  // The match must be ANCHORED AT THE START and leave a plausible remainder.
  // An unanchored includes() re-introduces the v1 substring bug: 'rehmanna'
  // (female) contains 'rehman' (male), 'alia' contains 'ali'. Requiring the
  // handle to BEGIN with the name — people write `sadia_x`, not `xsadia` —
  // keeps the useful cases and drops the dangerous ones.
  if (!hits.length) {
    for (const t of tokens) {
      if (t.length < 7) continue;
      let best = null;
      for (const [name, score] of dict) {
        if (name.length < 5 || !t.startsWith(name)) continue;
        const rest = t.slice(name.length);
        // The remainder must look like a separate word, not the tail of a
        // longer name ('rehmanna' -> rest 'na' is too short to be a word).
        if (rest.length < 3) continue;
        if (!best || name.length > best.name.length) best = { name, score };
      }
      if (best) { hits.push({ score: best.score, token: best.name, embedded: true }); break; }
    }
  }

  if (!hits.length) return null;
  if (hits.length === 1) return { ...hits[0], viaDict: true };

  const male = hits.filter(h => h.score < 40);
  const female = hits.filter(h => h.score > 60);
  // Mixed signals (a male family name beside a female given name) are common
  // in Bengali usernames; treat them as weak rather than confidently wrong.
  if (male.length && female.length) {
    return { score: male.length > female.length ? 30 : 70, token: hits.map(h => h.token).join('+'), viaDict: true, mixed: true };
  }
  return { ...hits[0], viaDict: true };
}

/** Arabic-script given names (profiles that write their name in Arabic/Urdu). */
export const ARABIC_NAMES = {
  // male
  'محمد': 5, 'احمد': 5, 'علي': 6, 'عمر': 5, 'حسن': 6, 'حسين': 6, 'خالد': 5, 'سلمان': 5,
  'صاقب': 6, 'ساقب': 6, 'عبدالله': 4, 'ابراهيم': 5, 'يوسف': 6, 'بلال': 5, 'طارق': 5,
  'فيصل': 5, 'كريم': 6, 'رحمن': 6, 'سيد': 8, 'شيخ': 8, 'امير': 8, 'زيد': 5, 'حمزة': 5,
  // female
  'فاطمة': 95, 'عائشة': 95, 'خديجة': 95, 'مريم': 95, 'زينب': 95, 'سارة': 94, 'ليلى': 94,
  'نور': 80, 'هدى': 94, 'أمينة': 94, 'سمية': 94, 'رقية': 95, 'صفية': 94, 'حفصة': 95,
  'نادية': 94, 'سلمى': 94, 'ياسمين': 94, 'زهرة': 94, 'رانيا': 94, 'دعاء': 94,
};

/** Look a raw (un-normalised) word up in the Arabic table. */
export function lookupArabic(word) {
  const w = String(word || '').replace(/[\u064B-\u065F\u0670]/g, '').trim();
  return Object.prototype.hasOwnProperty.call(ARABIC_NAMES, w)
    ? { score: ARABIC_NAMES[w], name: w } : null;
}

/**
 * Produce every name-derived signal for a profile.
 *
 * Previously this only looked at the FIRST token of full_name. Real profiles
 * routinely put the given name second or third ("Syed Roushan Ferdous",
 * "Tawhid Ahmmed"), or write it in Arabic script, or carry the only usable
 * signal in the username ("nafizur_rahman_iram"). Those all produced ZERO
 * signal, so the profile stayed `unknown`, skipped the male gate entirely,
 * and ranked on follower counts alone — which is how obviously-male accounts
 * reached 94 in High Priority.
 *
 * Now: scan every token of the full name AND the username, in both Latin and
 * Arabic script, and weight by how decisive each hit is.
 */
export function nameSignals({ username, fullName }) {
  const out = [];
  const rawWords = String(fullName || '').trim().split(/\s+/).filter(Boolean);

  // ── Arabic-script pass ──────────────────────────────────────────────────
  for (const w of rawWords) {
    const ar = lookupArabic(w);
    if (ar) {
      out.push(signal('nameExact', ar.score, 0.95, { name: ar.name, script: 'arabic' }));
      break;
    }
  }

  // ── Latin dictionary pass over ALL name tokens ──────────────────────────
  const tokens = rawWords.map(normalizeToken).filter(Boolean);
  const hits = [];
  const markers = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Record markers, but do NOT skip the dictionary: several honorifics
    // ('syed', 'sheikh') are also dictionary entries, and treating them as
    // markers-only downgraded a decisive nameExact hit to a weak nameSuffix.
    if (MALE_MARKERS.has(t))   markers.push({ t, score: 8 });
    else if (FEMALE_MARKERS.has(t)) markers.push({ t, score: 92 });
    const hit = lookupName(t);
    if (hit) hits.push({
      ...hit, index: i,
      isMarker: MALE_MARKERS.has(t) || FEMALE_MARKERS.has(t),
      isSurname: SURNAMES.has(t),
    });
  }

  if (hits.length) {
    // A first-position hit is the given name; later positions are usually the
    // family name, which is a weaker (but still real) signal.
    // Prefer a real given-name hit over an honorific or a family name that
    // happens to be in the dictionary, then prefer the earliest position.
    const given = hits.filter(h => !h.isMarker && !h.isSurname);
    const pool = given.length ? given : hits;
    const best = pool.reduce((a, b) => (a.index <= b.index ? a : b));
    // A surname-only match is weak evidence: "… Rahman" tells us little.
    const conf = best.isSurname ? 0.4
               : best.isMarker ? 0.85
               : best.index === 0 ? 1 : 0.8;
    out.push(signal('nameExact', best.score, conf, { name: best.name, pos: best.index }));

    // Genuine disagreement between tokens (e.g. a unisex family name) should
    // reduce trust rather than be silently ignored.
    const male = hits.filter(h => h.score < 40 && !h.isSurname).length;
    const female = hits.filter(h => h.score > 60 && !h.isSurname).length;
    if (male && female) out.push(signal('nameNgram', 50, 0.4, { conflict: true }));
  } else if (markers.length) {
    // No given-name hit, but an honorific tells us a lot ("Syed …", "… Begum").
    const m = markers[0];
    out.push(signal('nameSuffix', m.score, 0.75, { marker: m.t }));
  } else if (fullName) {
    const suf = applySuffixRules(fullName);
    if (suf) out.push(signal('nameSuffix', suf.score, 0.8, { rule: suf.rule }));
    else {
      const ng = applyCharNgram(fullName);
      if (ng) out.push(signal('nameNgram', ng.score, 0.6));
    }
  }

  // Markers always contribute, even alongside a dictionary hit — "Syed" plus
  // an unknown given name is still strong evidence.
  if (hits.length && markers.length) {
    const m = markers[0];
    out.push(signal('nameSuffix', m.score, 0.5, { marker: m.t }));
  }

  // ── Username pass ───────────────────────────────────────────────────────
  const uname = analyzeUsername(username);
  if (uname) {
    // Dictionary-backed hits get their own, much stronger source so that a
    // profile whose ONLY evidence is the handle can still cross the
    // confidence floor. Mixed hits stay weak.
    const src = uname.viaDict && !uname.mixed ? 'usernameDict' : 'username';
    const conf = uname.mixed ? 0.45
               : uname.embedded ? 0.75
               : uname.viaDict ? 1 : 0.55;
    out.push(signal(src, uname.score, conf, { token: uname.token }));
  }
  return out;
}
