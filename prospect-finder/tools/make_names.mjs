/**
 * make_names.mjs — build public/data/names.json
 *
 * Emits a flat { name: score } map, 0 = male … 100 = female.
 *
 * Expanded for the South-Asian / Bengali / Arabic name space, because the
 * original build let obviously-male profiles (Syed Roushan Ferdous, Tawhid
 * Ahmmed, Faisal Alam Joy, Salman Saqib) score 87-94 with an "Unknown"
 * verdict — none of their name tokens were in the dictionary.
 *
 *   node tools/make_names.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data');

const MALE = `
rana rafi rafiq rafique rayan rayhan raihan rubel russel ruhul rukon arif ariful ariyan arman
arnob arsalan ashraf asif asad asadullah farhan farhad fahim fahad faysal farid faisal fazle
faruk faruque habib hasan hassan hossain hosen hussain husain hamid hadi harun haroon hilal
ibrahim imran ismail irfan iqbal imon jahangir jakir zakir javed jamal jasim jobayer kabir
kamrul karim khalid khandaker khokon limon labib latif lutfor mahbub mahbubur mahmud mahmudul
masum masud mizan mizanur monir moniruzzaman mosharraf moshiur nahid nasir nazrul nazmul noman
nuruzzaman nurul omar osman palash parvez parvej pavel pollob rabbi rahmat rasel rashid ripon
riaz rifat rishad sabbir saddam sagor saiful sajib saju sakib salim saqib sarwar shahin shakil
shamim sharif shohag shohel shuvo siam sirajul sohag sohel sohan tahmid tanvir taufiq touhid
tawhid towhid tuhin wahid walid zahid zaman ziaul ahmed ahmad ali amir amin anwar bilal burhan
hamza kamal kamil malik marwan mohamad mohammad mohammed muhamad muhammad munir mustafa nasser
sami sameer tariq umar waleed yasir yusuf zaid zubair zoheb shakib shafiq shafique shamsul
siddique siddiqui sultan tanjil tanzil tareq tarek toufique wasim yaseen younus yunus zahirul
zahir zia ziaur akram alamgir anisur anis ashik ashiq atiq atiqur aminul azad azizul aziz badal
bappi bashir belal biplob dulal emran enam faridul firoz forhad gias giasuddin golam gias hafiz
hafizur helal hridoy idris iftekhar ikram imtiaz inam jewel jony joy juwel kaiser kayes khairul
liton mainul majid mamun manik masudur mehedi milon minhaj mintu mizba mofiz mohsin mokbul
motaleb mridul mukul murad musa mustafiz nadim nayeem nayem nazim nizam noor nuru obaidul opu
pappu piash polash provat rabiul rafid raju rakib ramin rasel rased rezaul riad ridoy rijon
rimon riyad robiul rocky rony ruman sadman safiq sagar sahed said sajjad salauddin saleh salman
samir sanjid santo sarwer sazzad selim shafin shahadat shahed shaheen shahjahan shahriar shakawat
shamsu shanto sharier shawon shibbir shipon shohidul shorif shuvra sifat sohanur solaiman sourav
subrata sujon sumon sunny swapan tamim tanim tanmoy tapan tarik tasin tawfiq tipu tofazzal turjo
ujjal utpal wahiduzzaman zahangir zakaria zaman zayan zubayer syed sheikh mir mia molla sarker
sardar munna raihanul redwan reza rezwan robin rohan romel roni sabuj sadi sadiq safwan sahil
sajid sakif samiul sanaullah shadman shafayet shaon shariar shihab shipu shourav shuvo simanto
sujan tahsin taj tamjid tanjid tanjim tawsif tazwar tomal touhidul uzzal
abdul abdur abdus abul abed adnan afzal ajmal akbar akhtaruzzaman alauddin aminur
nafiz nafizur nafis naf rahman rahaman rehman rohman mizanur moshiur habibur hafizur khalilur
lutfur matiur mokhlesur mostafizur motiur mujibur nazmul obaidur rafiqul rashidul saidur
shafiqul shahidul shamsur sirajul tofazzal wahidur ziaur akhtar ashraful jamil kamruzzaman
mahfuz mahfuzur maksud manzur masudul mehdi minhazul monzur nayeemur nizamul noorul rezaul
rokonuzzaman ruhul saifur salahuddin sanaul shafiul shahabuddin shamsuddin sharifur tanveer
tanzeel tauhid wasiur zahirul zakariya zulfiqar
aakash abhijit abhinav abhishek ajay ajit akash anand anil arun deepak dinesh gaurav girish
gopal kiran krishna kunal manish mohan naveen nikhil nitin pankaj pradeep prakash pramod
prashant praveen rahul rajesh rajiv rakesh ramesh ravi rohit sachin sandeep sanjay santosh
saurabh shyam subhash sudhir sunil suresh vijay vikas vikram vinay vinod vishal amit ankit
arjun ashok bharat chetan dev dhruv gagan harsh hemant jatin karan lalit manoj mayank mukesh
neeraj nilesh om parth piyush rajat rakshit sagar sameep sarthak shashank shubham siddharth
tarun tushar udit varun vivek yash yogesh
james john robert michael william david richard joseph thomas charles daniel matthew anthony
mark donald steven paul andrew joshua kevin brian george edward ronald timothy jason jeffrey
ryan jacob gary nicholas eric stephen jonathan larry justin scott brandon benjamin samuel
gregory alexander patrick frank raymond jack dennis jerry tyler aaron jose adam nathan henry
douglas zachary peter kyle ethan walter noah jeremy christian keith roger terry gerald harold
sean austin carl arthur lawrence dylan jesse bryan billy bruce gabriel logan alan juan wayne
roy ralph randy eugene vincent russell louis philip johnny bobby mason caleb hunter isaac

alfi jawad mohaimen zayan zayed zarif zubair zunaid junaid nabil nafiul naimul nazmus
nazif niloy nirjhor ovick pial pratik prantik protik raad raef rafid raiyan rakib rakibul
rashed redwan rezaul rezwan riadh riyad ruhan saad sadman safwan sagar sahil saikat sajid
samin sanjid sarim shadman shahriar shaon shariar shawon shihab shoumik shourav shourov
shuvro sifat siraj sneho sourav souvik subhro sudip sujoy suman supto swapnil syfullah
tahmid taimur talha tamim tanjim tanzim tasin taqi tausif tawsif tazwar tomal tonmoy toufiq
turjo utsho utsob wasi wasif yeasin yeasir zawad zihad ziko arafat arnab aritra ashfaq ashik
asheq atif avijit ayan azmain badhon bijoy bishal chirag debasish dipto durjoy emon eshan
fahad fardin fardeen farhan fuad galib hridoy imtiaz inan irtiza ishmam ishtiaq jubayer
kaushik kayes labib mahin mahir maruf mashrur mehedi mehrab minhaj mrinal mubin mueed
`.trim().split(/\s+/);

const FEMALE = `
sadia sumaiya sumaya sultana shirin shefali sharmin shanta sanjida samira salma saima rumana
rubina rozina rokeya rita rimi rifa rehana rasheda rahima priya poly parvin nusrat nupur nishat
nilufa naznin nazma nasrin nargis mousumi moriom mitu misty mim mehnaz maya masuma marufa mahi
mahmuda lima laboni kulsum khadija jesmin jannat jannatul ishrat ismat irin ifat hosne hasina
farzana farhana fatema fahmida dilruba chaity bristy bonna bithi bipasha ayesha asma arifa anika
afsana afroza aklima akhi aditi abida ruma shilpi shampa shathi shabnam roksana rehnuma rakhi
purnima piya nadia mun moni monira mukta lipi laila kazi jharna hena habiba fouzia dola dipa
champa bela ayla anju amena amina alia aisha khaleda taslima tania tanjila tasnim tahmina sabina
shahnaz shahana rowshon rabeya nasima nazneen jesmine hafsa fariha bushra tisha tanha tama
sumona sneha snigdha shirina shormi shorna shreya shuchi sinthia sonia sraboni srabonti suchi
sumi suraiya susmita swarna tabassum tahiya tanisha tanzila tarin tithi tonima tuli urmi urmila
mim mimi mira mishu mou moumita moushumi munia munmun nabila nafisa naima nandita nawrin
nazifa nazia neha nila nipa nira nishi nitu nowrin nudrat oishi orpita ovi pinky pori prima
proma pushpita rafia rahnuma raisa rashika reshma richi rifah risha ritu roksana rubaiya rumi
rupa sabiha sadiya safa safia sagorika sahana saidah samia sanjana sara sarah sathi sayma
shahida shamima shanjida sharmila shathi shayla sheuly shohana shormila shuvra sifat silvia
simu sirajum sohana sonali sraboni sudipta sumaita sumiya suraya susmita tafsia tahsina tamanna
tanjina tanzia tarannum tasfia tasnia tazrian tithi tuba tuli umme urmi zannat zarin zerin
zinia ziniya nabiha nusaiba maliha maisha mahira mahmuda marzia meherun mehjabin mehrin
sneha shruti simran sonia sunita swati tanvi trisha uma vaishali vandana varsha vidya anjali
anita archana asha bharti bhavna chandni deepa deepika divya gayatri geeta gita hema indira
jaya jyoti kajal kalpana kamala kavita komal lakshmi lata madhu mala mamta manju meena meera
mona nandini neelam neha nidhi nisha pooja poonam pratibha preeti radha rani rashmi rekha renu
riya ruchi sangeeta sarita savita seema shalini shanti sharda shobha shweta smita sudha sushma
usha veena vinita aarti bhavya ishita kritika mahima nikita pallavi ritika sakshi shreya tanya
mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa margaret
betty sandra ashley dorothy kimberly emily donna michelle carol amanda melissa deborah stephanie
rebecca laura sharon cynthia kathleen amy shirley angela helen anna brenda pamela nicole ruth
katherine samantha christine emma catherine debra virginia rachel carolyn janet maria heather
diane julie joyce victoria kelly christina joan evelyn lauren judith olivia frances martha
cheryl megan andrea hannah jacqueline ann jean alice kathryn gloria teresa doris sara janice
julia marie madison grace judy theresa beverly denise marilyn amber danielle abigail brittany
rose natalie sophia isabella charlotte mia amelia harper luna camila gianna elena nora lily
eleanor hazel violet aurora savannah audrey brooklyn bella claire skylar lucy paisley everly
caroline nova genesis emilia kennedy willow kinsley naomi aaliyah ariana allison gabriella
madelyn cora ruby eva serenity autumn adeline hailey valentina isla eliana quinn nevaeh ivy
sadie piper lydia alexa josephine emery delilah arianna vivian kaylee sophie brielle madeline
peyton rylee clara hadley melanie mackenzie reagan adalynn liliana aubree jade isabelle natalia
raelynn athena ximena arya leilani taylor faith kylie alexandra lyla amaya eliza brianna bailey
khloe jasmine melody iris isabel norah annabelle valeria emerson adalyn ryleigh eden emersyn
anastasia kayla alyssa juliana charlie esther ariel cecilia valerie alina molly reese aliyah
lilly parker finley morgan sydney jordyn eloise trinity daisy genevieve arabella harmony elise
remi teagan alexis laila myla londyn juniper jocelyn alaina matilda

madhobi madhabi muskaan muskan afreeda afrida afrin afreen salsabil sumona shormi sharmi
tasfia tasfiya tahiya tahia raisa rayisa nawar nawal noshin nowshin nazifa nazia naima
tanisha tanzila tamanna tahsina samiha samira sanjana sadiya saniya shanjida shreoshi
rithika rithi rupa runa rupali ruponti nusaiba nuzhat nuzhaat orpita oishi oishee ipshita
prova probha proma promi punam pritilata puja pujaa rakhi ridhi riddhi rimjhim ritu rupsa
sneha snigdha sohana sonali sraboni srabonti subarna suchona sudipta sumona suraiya susmita
swarna tamalika tanha tanima tithi tuli tulika urmi urmila jarin jarina jhilik jui juthi
kakoli kanika kaniz keya khushi kona koyel labonno lamia lubna maisha maliha marzia mehjabin
mehrin meherin mim mimi mishu moumita mrittika mumu munmun nabila nafisa nahar naila nandita
nabanita neela nila nipa nirjhara ontora ananya anindita anwesha aparna apurba arpita atia
ayeasha ayshi barsha bidisha bijoya bipa bornali chaiti chandrima chumki debolina dipannita
dola dristi elora eshita esha fahmida faiza farhat fariya fatiha fiha gargi hasnat hridi
ishika ishrar jannati jerin jesia jinia joyeeta
`.trim().split(/\s+/);

/**
 * Family names shared by both genders. "Tasnim Rahman" is a woman; scoring
 * `rahman` as male made the surname outvote the given name. These carry no
 * gender information, so they must not appear in the dictionary at all.
 */
const UNISEX_SURNAMES = new Set(`
rahman rahaman rehman rohman islam hossain hosen ahmed ahmad ahmmed khan chowdhury choudhury
sarker sardar uddin haque hoque alam kabir karim mia miah molla biswas das dey ghosh saha roy
sharma verma singh gupta patel kumar reddy nair iyer mondal mandal talukder bhuiyan bhuyan
majumder sikder howlader pramanik malik ansari siddique siddiqui akand akanda joarder munshi
`.trim().split(/\s+/));

const map = {};
for (const n of MALE) map[n.toLowerCase()] = 6;
for (const n of FEMALE) map[n.toLowerCase()] = 94;

// Conflicts: a token in both lists is genuinely unisex -> drop it rather than
// let list order decide. Better to emit no signal than a wrong one.
const conflicts = MALE.filter(n => FEMALE.includes(n));
for (const c of conflicts) delete map[c.toLowerCase()];

// Unisex family names carry no signal — remove them.
let removedSurnames = 0;
for (const sn of UNISEX_SURNAMES) {
  if (map[sn] !== undefined) { delete map[sn]; removedSurnames++; }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'names.json'), JSON.stringify(map));

const m = Object.values(map).filter(v => v < 50).length;
const f = Object.values(map).filter(v => v > 50).length;
console.log(`names.json -> ${Object.keys(map).length} entries (${m} male, ${f} female)`);
if (conflicts.length) console.log(`dropped ${conflicts.length} unisex conflicts: ${conflicts.join(', ')}`);
console.log(`dropped ${removedSurnames} unisex family names`);
