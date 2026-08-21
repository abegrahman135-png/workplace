/**
 * classifier_names.js — Gender name classifier
 * Covers: Bengali, Arabic, South Asian, English, and common regional names
 * 
 * Score: 0-100 where 100 = certainly female, 0 = certainly male, 50 = unknown
 */

let nameDb = new Map();
let nameDbLoaded = false;

export async function loadNameDb() {
  if (nameDbLoaded) return nameDb;
  try {
    const url = chrome.runtime.getURL('public/data/name_gender_db.json');
    const response = await fetch(url);
    const data = await response.json();
    for (const [name, score] of Object.entries(data)) {
      nameDb.set(name.toLowerCase(), score);
    }
  } catch (e) {
    console.warn('[classifier_names] Name DB file not found, using built-in lists only');
  }

  // ── Built-in hardcoded lists (South Asian + Arabic focus) ────────────────
  // MALE names that commonly fool classifiers — hard 0
  const hardMale = [
    // Bengali/Bangladeshi male names
    'rana','rafi','rafiq','rayan','rayhan','raihan','rubel','russel','ruhul','rukon',
    'arif','ariful','ariyan','arman','arnob','arsalan','ashraf','asif','asad','asadullah',
    'farhan','farhad','fahim','faysal','farid','faisal','fazle','faruk',
    'habib','hasan','hassan','hossain','hamid','hadi','harun','hilal',
    'ibrahim','imran','ismail','irfan','iqbal','imon',
    'jahangir','jakir','javed','jamal','jasim','jobayer',
    'kabir','kamrul','karim','khalid','khandaker','khokon',
    'limon','labib','latif','lutfor',
    'mahbub','mahmud','mahmudul','masum','masud','mizan','monir','mosharraf','moshiur',
    'nahid','nasir','nazrul','nazmul','noman','nuruzzaman','nurul',
    'omar','osman',
    'palash','parvez','pavel','pollob',
    'rabbi','rahmat','rasel','rashid','ripon','ripon','riaz','rifat','rishad',
    'sabbir','saddam','sagor','saiful','sajib','saju','sakib','salim','saqib','sarwar',
    'shahin','shakil','shamim','sharif','shohag','shohel','shuvo','siam','sirajul','sohag','sohel','sohan','suborna',
    'tahmid','tanvir','taufiq','touhid','tuhin',
    'wahid','walid',
    'zahid','zakir','zaman','ziaul',
    // Arabic/Middle East male
    'ahmed','ahmad','ali','amir','amin','anwar',
    'bilal','burhan',
    'hamza','hussain',
    'kamal','kamil',
    'malik','marwan','mohamad','mohammad','mohammed','muhamad','muhammad','munir','mustafa',
    'nasser',
    'omar','osman',
    'sami','sameer','sameer','tariq','umar','waleed','yasir','yusuf','zaid',
    // Indian male
    'aakash','aakash','abhijit','abhinav','abhishek','ajay','ajit','akash','anand','anil','arun',
    'deepak','dinesh',
    'gaurav','girish','gopal',
    'kiran','krishna','kunal',
    'manish','manish','mohan',
    'nikhil','nilesh',
    'pankaj','pradeep','pramod','praveen','priya', // priya can be male in some regions
    'rahul','raj','rajesh','rakesh','ram','ramesh','ravi','rohit',
    'sandeep','sanjay','santosh','shyam','sunil','suresh',
    'vijay','vikas','vinay','vinod','vishal',
  ];

  // FEMALE names — hard 100
  const hardFemale = [
    // Bengali/Bangladeshi female names
    'afia','afifa','afrin','afsana','afsara','ahana','aisha','aishwarya','alo','amena','amina','amira',
    'bristy','bristi',
    'chandni','chowdhury',
    'dipa','dipti','disha','dolly',
    'elma','esha',
    'fabiha','fahima','fahmida','fairuz','farida','faria','farzana','fatema','fatima','ferdousi','fouzia',
    'halima','hira','hridy',
    'irin','israt',
    'jannatul','jasmine','jinia','joti','jui','juhi',
    'kajol','keya','konika','konok','kona','koli',
    'laboni','lamia','lamiya','lata','liza','luna','lopa',
    'mahbuba','mahfuza','mahia','mahjabin','mahzabin','maisha','maium','maksuda','mamoni','manarah','manha','maria','marufa','marziya','marzina','masuma','mili','mim','mimi','mina','minha','minjara','mithu','mitu','mitu','mou','mousumi','mow','moyuri','mukti','munni',
    'nafisa','nahar','naima','nalini','nandita','nargis','nasima','nasrin','natasha','nazia','nila','nilufar','nilu','nilufar','nilupha','nira','nishat','nishi','nishita','nitu','nilupha','noor','noora',
    'omi','orchi','orna',
    'papia','parboti','piu','popi','poppy','prity','priya','priti','prithi',
    'rabeya','rafia','rahela','rajia','raka','ranu','razia','rimi','rima','ritu','riya','rojina','roksana','roma','rona','roni','rosa','rosy','roya','rukaia','rukiya','ruma','rumi','rupsana','rupa',
    'sabia','sadia','safia','sahadatu','saida','saira','saju','sakhi','sakila','salma','samia','sanjana','saona','sara','sara','sarah','seema','selina','shajeda','shanta','sharmin','sharna','sheuli','shila','shilpi','shimla','shirin','shorna','shoshi','shova','shuvra','sifat','simayet','sinthia','sneha','sofiya','sohagi','soikat','soma','sonali','soriya','suborna','subha','sumaiya','sumiaya','sumiya','sunita','sunzida','supria','supriya','suraia','suraiya','surovi','sweety','sylvia',
    'tahera','tahira','tahmina','tamanna','tamannur','tanzia','tania','taslima','tasnim','tasnima','taznin','toma','tonya','trisha','tuba','tulip','tumpa','tuni',
    'umma','ummay',
    'vaishali','vandana',
    'zakia','zarrin','zubaida',
    // Arabic female names
    'aaliyah','abeer','ahlam','aisha','alaa','aliya','aliyah','amani','amira','arwa','asma','atika',
    'basma','bushra',
    'dalal','dana','dania',
    'farah','farida','fatimah',
    'ghada','ghufran',
    'hadeel','hadya','hafsa','hala','hanaa','hana','hanan','hayfa','hayfaa',
    'ibtihal','iman',
    'jood','joory','jumanah',
    'khadija','kholood',
    'laila','layla','leila','lina','lubna','luna',
    'manal','maryam','mashael','mona','muna',
    'nada','nadia','nadine','nawal','noor','noura',
    'rahaf','raghad','randa','rasha','rawabi','reem','reham','rim','roaa','ruba',
    'saba','sahar','salma','samia','samira','sara','shaden','shahad','shaza',
    'tahani','taif',
    'wafa','wafeya',
    'yara',
    'zahia','zahra',
    // Common international female names
    'alice','alicia','amanda','amber','amelia','amy','angela','anna','annie','ashley',
    'bella','bethany','brittany',
    'chloe','claire','crystal',
    'daisy','diana','diana',
    'elena','elizabeth','ella','emily','emma','eva',
    'faith','fiona','florence',
    'grace','hannah',
    'isabella',
    'jasmine','jennifer','jessica','julia','julie',
    'karen','kate','katherine','katie',
    'laura','lauren','lily','lisa','lucy',
    'madison','maria','mary','megan','melissa','michelle',
    'natalie','nicole',
    'olivia',
    'patricia','paula',
    'rachel','rebecca','rose','ruby',
    'samantha','sandra','sarah','sophia','sophie','stephanie','susan',
    'tiffany',
    'vanessa',
    'whitney',
    'zoe',
  ];

  hardMale.forEach(n => nameDb.set(n.toLowerCase(), 5));
  hardFemale.forEach(n => nameDb.set(n.toLowerCase(), 95));
  nameDbLoaded = true;
  return nameDb;
}

export function lookupName(firstName) {
  if (!firstName) return null;
  const normalized = firstName.toLowerCase().trim();
  return nameDb.has(normalized) ? nameDb.get(normalized) : null;
}

// Suffix rules for out-of-vocabulary names
export const SUFFIX_RULES = [
  // Bengali female suffixes
  { type: 'suffix', value: 'ara',    score: 88 },
  { type: 'suffix', value: 'ata',    score: 85 },
  { type: 'suffix', value: 'una',    score: 82 },
  { type: 'suffix', value: 'ina',    score: 83 },
  { type: 'suffix', value: 'ima',    score: 84 },
  { type: 'suffix', value: 'iya',    score: 86 },
  { type: 'suffix', value: 'iya',    score: 86 },
  { type: 'suffix', value: 'ida',    score: 83 },
  { type: 'suffix', value: 'ina',    score: 82 },
  { type: 'suffix', value: 'isa',    score: 84 },
  // Arabic
  { type: 'suffix', value: 'iyat',   score: 90 },
  { type: 'suffix', value: 'een',    score: 80 },
  { type: 'prefix', value: 'umm',    score: 95 },
  // South Asian female
  { type: 'suffix', value: 'ita',    score: 85 },
  { type: 'suffix', value: 'devi',   score: 95 },
  { type: 'suffix', value: 'kumari', score: 95 },
  { type: 'suffix', value: 'mati',   score: 90 },
  // South Asian male (negative)
  { type: 'suffix', value: 'esh',    score: 8 },
  { type: 'suffix', value: 'inder',  score: 10 },
  { type: 'suffix', value: 'deep',   score: 30 }, // unisex
  { type: 'suffix', value: 'ul',     score: 20 }, // e.g. "rabiul" = male
  { type: 'suffix', value: 'ur',     score: 18 }, // e.g. "rafiqur" = male
  // Universal feminine endings
  { type: 'suffix', value: 'ella',   score: 85 },
  { type: 'suffix', value: 'ette',   score: 82 },
  { type: 'suffix', value: 'ine',    score: 78 },
  { type: 'suffix', value: 'issa',   score: 85 },
];

export function applySuffixRules(fullName) {
  if (!fullName) return null;
  const words = fullName.toLowerCase().split(/\s+/);
  for (const word of words) {
    for (const rule of SUFFIX_RULES) {
      if (rule.type === 'suffix' && word.endsWith(rule.value) && word.length > rule.value.length) {
        return rule.score;
      }
      if (rule.type === 'prefix' && word.startsWith(rule.value)) {
        return rule.score;
      }
    }
  }
  return null;
}

const NGRAM_WEIGHTS = {
  'ia': 7, 'ine': 6, 'elle': 10, 'ana': 6, 'ina': 7,
  'ita': 6, 'tte': 5, 'ssa': 5, 'lie': 5, 'ley': 4,
  'lyn': 5, 'een': 4, 'ara': 5, 'ira': 4, 'ila': 4,
  'uma': 4, 'ima': 5, 'ida': 5, 'iya': 6,
  // male n-grams
  'son': -8, 'berg': -6, 'kov': -5, 'man': -7,
  'ton': -5, 'ald': -4, 'ard': -4, 'ius': -5, 'esh': -6,
  'dul': -5, 'rul': -5, 'ful': -4, // e.g. "asadul", "nurrul", "rashedul"
};

export function applyCharNgram(fullName) {
  if (!fullName) return null;
  const normalized = fullName.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.length < 2) return null;
  let score = 50;
  for (let i = 0; i < normalized.length - 1; i++) {
    const bi = normalized.slice(i, i + 2);
    if (NGRAM_WEIGHTS[bi]) score += NGRAM_WEIGHTS[bi];
    if (i < normalized.length - 2) {
      const tri = normalized.slice(i, i + 3);
      if (NGRAM_WEIGHTS[tri]) score += NGRAM_WEIGHTS[tri];
    }
  }
  return Math.max(0, Math.min(100, score));
}

export function analyzeUsername(username) {
  if (!username) return null;
  const normalized = username.toLowerCase();
  const femaleWords = [
    'girl','woman','queen','mama','babe','lady','princess','bella','rose',
    'angel','goddess','diva','missy','chica','femme','mrs','miss','madam',
  ];
  const maleWords = [
    'guy','man','bro','king','boss','dude','mr','sir','boy','papa','father','husband','bhai',
  ];
  for (const w of femaleWords) { if (normalized.includes(w)) return 90; }
  for (const w of maleWords)   { if (normalized.includes(w)) return 8;  }
  return null;
}
