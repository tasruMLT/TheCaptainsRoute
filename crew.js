// Ship Crew: the people a captain signs on, what each post does, how they gain
// experience, what they call out while sailing, and the crew screen.
//
// A classic script sharing game.js's globals. It is loaded before game.js and
// only declares things here; everything runs when game.js calls it.
//
// Saved in each captain's profile (so it carries over between sessions):
//   profile.crew.assign[shipId][postId] = personId
//   profile.crew.xp[personId]           = experience
// No voyage starts until every post on the ship is filled (crewRequired).

const CREW_RANKS = ["Rookie", "Able", "Skilled", "Senior", "Master"];
const CREW_RANK_XP = [0, 150, 450, 1000, 2000]; // one run from harbour to harbour earns roughly 150-200
const CREW_DELIVERY_XP = 50;

const CREW_STYLES = {
  veteran: { label: "Old hand", note: "Starts as Able, learns more slowly", start: 200, learn: 0.85 },
  steady: { label: "Steady", note: "Has a little sea time, normal learner", start: 60, learn: 1 },
  keen: { label: "Keen", note: "Starts from nothing, learns fastest", start: 0, learn: 1.3 }
};

// Equipment bought in the Dockyard. Experience never gives these: without the
// kit on board, the crew member can't do that part of the job.
const CREW_EQUIPMENT = {
  navigator: [
    { id: "chartPlotter", does: "keeps your track on map and chart (Able); marks the way into a sighted harbour (map Able, sea Skilled)" },
    { id: "weatherStation", does: "forecasts storms (Able), whirlpools and the tsunami heading (Skilled)" }
  ],
  lookout: [{ id: "radar", does: "calls dangers from further off and shows sea monsters and submarines on the map" }],
  bosun: [{ id: "fireFighting", does: "lets the bosun (Skilled) put fires out without being told" }]
};

// Each post: what the person does, and what each rank adds.
const CREW_ROLES = {
  captain: {
    title: "Commanding Officer",
    duty: "Commands the ship: under a good captain the whole crew learns faster.",
    ranks: ["The crew learn 5% faster", "The crew learn 10% faster", "The crew learn 15% faster", "The crew learn 20% faster", "The crew learn 25% faster"]
  },
  navigator: {
    title: "Navigating Officer",
    duty: "Keeps watch on land and weather; calls the course once Harbour B is sighted.",
    ranks: ["Gives the bearing of a sighted Harbour B", "Routes into it round islands, volcanoes and ice", "Warns of land dead ahead; distance and arrival time", "Routes clear of storms, spouts, whirlpools and pirates", "Re-plans twice as often and warns earlier"]
  },
  helm: {
    title: "Helmsman",
    duty: "Holds the course: quicker rudder, less drift in wind and heavy seas.",
    ranks: ["Rudder and sea handling improved a little", "Better in wind and waves", "Quicker helm", "Hardly pushed off course", "Best handling the ship can give"]
  },
  engineer: {
    title: "Chief Engineer",
    duty: "Gets more from the engines and runs the damage repairs.",
    ranks: ["Slightly more thrust, cheaper repairs", "Tells you when repairs are due", "Repairs succeed more often", "Strong thrust, fast repairs", "Up to 10% more thrust, repairs 30% cheaper"]
  },
  lookout: {
    title: "Lookout",
    duty: "Watches the horizon and calls out dangers.",
    ranks: ["Sees further than the captain alone", "Calls the distance too", "Exact bearings; warns of land dead ahead", "Sees dangers much earlier", "Longest sight in the fleet"]
  },
  bosun: {
    title: "Bosun",
    duty: "Runs the deck: mooring lines and fire parties.",
    ranks: ["Lines handled faster, fires spread slower", "Calls out fires at once", "Fights fires unasked (needs fire kit)", "Fire parties react quicker", "Fastest lines and fire parties"]
  },
  gunner: {
    title: "Weapons Officer",
    duty: "Lays the guns: faster reload and longer reach.",
    ranks: ["Reloads a little faster", "Calls when a target bears", "Longer range", "Much faster reload", "Reload 25% faster, longest range"]
  },
  purser: {
    title: "Hotel Director",
    duty: "Looks after the passengers: bigger rewards on arrival.",
    ranks: ["+12 points per delivery", "+24 points per delivery", "+36 points per delivery", "+48 points per delivery", "+60 points per delivery"]
  },
  cargo: {
    title: "Cargo Officer",
    duty: "Stows and lands the cargo: bigger rewards on arrival.",
    ranks: ["+12 points per delivery", "+24 points per delivery", "+36 points per delivery", "+48 points per delivery", "+60 points per delivery"]
  },
  sails: {
    title: "Sail Trimmer",
    duty: "Trims for every wind: more drive off the wind, less leeway.",
    ranks: ["A little less leeway", "Calls when to bear away", "More speed with the wind astern", "Much less leeway", "Half the leeway, 10% more drive off the wind"]
  },
  airboss: {
    title: "Air Boss",
    duty: "Runs the flight deck: jets launch sooner and are replaced faster.",
    ranks: ["Jets turned round faster", "Jets sent out to meet pirates earlier", "Quicker replacement of a lost jet", "Wider air patrol", "Half the waiting time, widest patrol"]
  },
  pump: {
    title: "Pump Master",
    duty: "Keeps the cargo safe: tougher against gunfire and fire.",
    ranks: ["Fires spread slower", "Warns when the cargo is at risk", "Takes more hits before the cargo goes", "Less damage from gunfire", "Safest cargo handling"]
  },
  ice: {
    title: "Ice Pilot",
    duty: "Reads the pack ice and keeps the ship moving through it.",
    ranks: ["Faster through unbroken ice", "Better speed in ice", "Points to open water", "Much better speed in ice", "Nearly twice the speed through solid ice"]
  },
  tow: {
    title: "Tow Master",
    duty: "Runs the towing deck: a stronger, surer pull.",
    ranks: ["A stronger pull", "Calls when a ship is close enough", "Pulls heavier ships well", "Very strong pull", "Strongest tow in the harbour"]
  }
};

// The posts each ship type needs: more on the big and complicated ones.
const CREW_POSTS = {
  Sailing: ["navigator", "sails"],
  Carrack: ["navigator", "sails", "helm", "bosun", "gunner", "lookout"],
  Catamaran: ["navigator", "sails", "lookout"],
  Tug: ["helm", "engineer", "tow"],
  Hydrofoil: ["helm", "engineer", "lookout"],
  Futuristic: ["navigator", "helm", "engineer", "gunner"],
  Assault: ["navigator", "helm", "engineer", "lookout", "gunner"],
  Cargo: ["navigator", "helm", "engineer", "bosun", "cargo"],
  Icebreaker: ["navigator", "ice", "helm", "engineer", "lookout"],
  Tanker: ["navigator", "helm", "engineer", "pump", "lookout"],
  GasTanker: ["navigator", "helm", "engineer", "pump", "lookout"],
  WarTanker: ["captain", "navigator", "helm", "engineer", "pump", "gunner", "lookout"],
  Cruise: ["navigator", "helm", "engineer", "lookout", "bosun", "purser"],
  Carrier: ["navigator", "helm", "engineer", "lookout", "gunner", "bosun", "airboss"]
};

const CREW_NAVY_SHIPS = ["Assault", "Carrier", "Futuristic"];

// The people available, three for each post in each company: civilian, navy, carrack, 1943 navy.
// The portraits are AI-generated faces (assets/crew/CREDITS.md); names and histories are invented.
const CREW_PEOPLE = [
  { id: "elena", role: "navigator", name: "Elena Marquez", style: "veteran", bio: "Twenty years on ocean passages. Trusts her own plot." },
  { id: "samuel", role: "navigator", name: "Samuel Okafor", style: "steady", bio: "Ran a pilot station before going back to sea." },
  { id: "mei", role: "navigator", name: "Mei Tanaka", style: "keen", bio: "Fresh from nautical college, first in her class." },
  { id: "henrik", role: "helm", name: "Henrik Dahl", style: "veteran", bio: "Steered ferries through the fjords for a decade." },
  { id: "luca", role: "helm", name: "Luca Ferrari", style: "steady", bio: "Harbour launch coxswain with light hands." },
  { id: "amara", role: "helm", name: "Amara Ndiaye", style: "keen", bio: "Grew up handling fishing pirogues." },
  { id: "marco", role: "engineer", name: "Marco Bellini", style: "steady", bio: "Can name a fault by its sound." },
  { id: "ruby", role: "engineer", name: "Ruby Anderson", style: "veteran", bio: "Kept old diesels alive far from any yard." },
  { id: "osman", role: "engineer", name: "Osman Kaya", style: "keen", bio: "Shipyard fitter taking his first berth afloat." },
  { id: "tomas", role: "lookout", name: "Tomas Novak", style: "keen", bio: "Sharpest eyes in the recruiting office." },
  { id: "lina", role: "lookout", name: "Lina Santos", style: "steady", bio: "Former lifeguard who never stops scanning." },
  { id: "kofi", role: "lookout", name: "Kofi Mensah", style: "veteran", bio: "Spotted more reefs than the chart shows." },
  { id: "piet", role: "bosun", name: "Piet de Vries", style: "steady", bio: "Quiet, quick and good with a line." },
  { id: "ingrid", role: "bosun", name: "Ingrid Solberg", style: "veteran", bio: "Has run decks in every kind of weather." },
  { id: "angus", role: "bosun", name: "Angus McRae", style: "keen", bio: "Retrained from the fire service." },
  { id: "grace", role: "purser", name: "Grace Lin", style: "steady", bio: "Hotel manager who remembers every guest." },
  { id: "hiroshi", role: "purser", name: "Hiroshi Mori", style: "veteran", bio: "Twenty seasons of cruising, no complaints on file." },
  { id: "josephine", role: "purser", name: "Josephine Baptiste", style: "keen", bio: "Ran festivals before she ran decks." },
  { id: "rajan", role: "cargo", name: "Rajan Pillai", style: "veteran", bio: "Loads a hold so nothing ever shifts." },
  { id: "sofia", role: "cargo", name: "Sofia Park", style: "keen", bio: "Logistics graduate with a head for numbers." },
  { id: "yusuf", role: "cargo", name: "Yusuf Demir", style: "steady", bio: "Came up from the container quays." },
  { id: "alberto", role: "sails", name: "Alberto Rossi", style: "veteran", bio: "Feels a wind shift before the flag moves." },
  { id: "carmen", role: "sails", name: "Carmen Silva", style: "steady", bio: "Offshore racer who loves a broad reach." },
  { id: "keanu", role: "sails", name: "Keanu Alapai", style: "keen", bio: "Learned on outriggers off the islands." },
  { id: "maria", role: "pump", name: "Maria Costa", style: "veteran", bio: "Never lost a drop in twenty years of tankers." },
  { id: "diego", role: "pump", name: "Diego Navarro", style: "steady", bio: "Refinery operator who reads every gauge twice." },
  { id: "elias", role: "pump", name: "Elias Tesfaye", style: "keen", bio: "Chemistry student with a safety habit." },
  { id: "erik", role: "ice", name: "Erik Nordahl", style: "steady", bio: "Wintered three times on polar supply runs." },
  { id: "sean", role: "ice", name: "Sean Gallagher", style: "keen", bio: "Trawlerman from the northern grounds." },
  { id: "aud", role: "ice", name: "Aud Kristiansen", style: "veteran", bio: "Knows old ice from new by its colour." },
  { id: "joseph", role: "tow", name: "Joseph Mwangi", style: "veteran", bio: "Has berthed ships far too big for the quay." },
  { id: "hilde", role: "tow", name: "Hilde Brandt", style: "steady", bio: "River tug skipper who never snaps a rope." },
  { id: "rafael", role: "tow", name: "Rafael Ortega", style: "keen", bio: "Salvage diver learning the towing deck." },
  // The navy company: the only people who serve in the warships (CREW_NAVY_SHIPS).
  { id: "n_rui", company: "Navy", role: "navigator", name: "Lt Cdr Rui Almeida", style: "veteran", bio: "Fifteen years navigating frigates on convoy escort." },
  { id: "n_claire", company: "Navy", role: "navigator", name: "Lt Claire Donovan", style: "steady", bio: "Hydrographic officer before joining the fleet." },
  { id: "n_daniel", company: "Navy", role: "navigator", name: "Sub Lt Daniel Cho", style: "keen", bio: "Straight from the naval academy, top at navigation." },
  { id: "n_martin", company: "Navy", role: "helm", name: "CPO Martin Reeves", style: "veteran", bio: "Quartermaster in destroyers since the age of twenty." },
  { id: "n_katja", company: "Navy", role: "helm", name: "PO Katja Berg", style: "steady", bio: "Drove fast patrol boats on coastal duty." },
  { id: "n_jakub", company: "Navy", role: "helm", name: "AB Jakub Wolski", style: "keen", bio: "Fresh from basic training, with steady hands." },
  { id: "n_ernesto", company: "Navy", role: "engineer", name: "Lt Cdr Ernesto Ruiz", style: "veteran", bio: "Kept gas turbines running through long deployments." },
  { id: "n_andre", company: "Navy", role: "engineer", name: "PO Andre Baptiste", style: "steady", bio: "Taught damage control at the fleet school." },
  { id: "n_hannah", company: "Navy", role: "engineer", name: "Sub Lt Hannah Weiss", style: "keen", bio: "Naval engineering graduate on a first sea posting." },
  { id: "n_paul", company: "Navy", role: "lookout", name: "CPO Paul Mercier", style: "veteran", bio: "Years of mine-hunter watches. Misses nothing." },
  { id: "n_tane", company: "Navy", role: "lookout", name: "LS Tane Rangi", style: "steady", bio: "Sea boat crew and search and rescue lookout." },
  { id: "n_emily", company: "Navy", role: "lookout", name: "AB Emily Strand", style: "keen", bio: "Top marks in ship and aircraft recognition." },
  { id: "n_stefan", company: "Navy", role: "gunner", name: "Lt Cdr Stefan Marek", style: "veteran", bio: "Gunnery officer through three escort tours." },
  { id: "n_rosa", company: "Navy", role: "gunner", name: "PO Rosa Quispe", style: "steady", bio: "Ran the close-in gun crews on a fleet escort." },
  { id: "n_femi", company: "Navy", role: "gunner", name: "Sub Lt Femi Adeyemi", style: "keen", bio: "Fast on the fire control desk, still learning patience." },
  { id: "n_fiona", company: "Navy", role: "bosun", name: "CPO Fiona Gallagher", style: "veteran", bio: "Chief boatswain's mate in two warships." },
  { id: "n_arif", company: "Navy", role: "bosun", name: "PO Arif Santoso", style: "steady", bio: "Rigs for replenishment at sea, calm with heavy lines." },
  { id: "n_nikolai", company: "Navy", role: "bosun", name: "AB Nikolai Orlov", style: "keen", bio: "Volunteered for the fire party and the sea boat." },
  { id: "n_teresa", company: "Navy", role: "airboss", name: "Cdr Teresa Molina", style: "veteran", bio: "Flight deck officer with a thousand launches." },
  { id: "n_kenji", company: "Navy", role: "airboss", name: "Lt Cdr Kenji Watanabe", style: "steady", bio: "Air traffic controller turned deck boss." },
  { id: "n_owen", company: "Navy", role: "airboss", name: "Lt Owen Clarke", style: "keen", bio: "Naval aviator moving up to run the flight deck." },
  // The Hospitaller carrack's company, 16th century (company: "Carrack"): Maltese, Italian and Spanish.
  { id: "k_giorgio", company: "Carrack", role: "navigator", name: "Ġorġ Vella", style: "veteran", bio: "Has taken galleys from Malta to Rhodes by the lead alone." },
  { id: "k_andreas", company: "Carrack", role: "navigator", name: "Andrés de Salazar", style: "steady", bio: "Sailed the galleys of Spain. Carries an old portolan chart." },
  { id: "k_luc", company: "Carrack", role: "navigator", name: "Luca Amato", style: "keen", bio: "Taught the cross-staff by a pilot of Messina." },
  { id: "k_gaspard", company: "Carrack", role: "sails", name: "Gaspare Ferrante", style: "veteran", bio: "Thirty summers in the Order's ships. Reads a squall early." },
  { id: "k_matteo", company: "Carrack", role: "sails", name: "Mattew Żammit", style: "steady", bio: "Sailmaker's son who knows every seam aloft." },
  { id: "k_nikolas", company: "Carrack", role: "sails", name: "Nikola Buħaġiar", style: "keen", bio: "Quick up the yards, eager to command them." },
  { id: "k_salvu", company: "Carrack", role: "helm", name: "Salvu Borg", style: "veteran", bio: "Holds the whipstaff steady in any sea." },
  { id: "k_pietro", company: "Carrack", role: "helm", name: "Pietro Marino", style: "steady", bio: "Steered grain ships out of Sicily for years." },
  { id: "k_manolis", company: "Carrack", role: "helm", name: "Ċensu Farruġia", style: "keen", bio: "Fisherman's boy trusted early with the helm." },
  { id: "k_bartolomeo", company: "Carrack", role: "bosun", name: "Bartolomeo Greco", style: "veteran", bio: "A voice that carries from poop to bowsprit." },
  { id: "k_domenico", company: "Carrack", role: "bosun", name: "Duminku Falzon", style: "steady", bio: "Keeps cables coiled and fire buckets full." },
  { id: "k_joan", company: "Carrack", role: "bosun", name: "Joan Ferrer", style: "keen", bio: "Catalan deckhand who learns every knot twice." },
  { id: "k_hans", company: "Carrack", role: "gunner", name: "Ambrogio Fontana", style: "veteran", bio: "Cast and served cannon in the foundries of Milan." },
  { id: "k_thomas", company: "Carrack", role: "gunner", name: "Alonso de Vargas", style: "steady", bio: "Spanish bombardier with a careful measure of powder." },
  { id: "k_martin", company: "Carrack", role: "gunner", name: "Martín de Ibarra", style: "keen", bio: "Biscayan hand itching to lay his first gun." },
  { id: "k_caterina", company: "Carrack", role: "lookout", name: "Katarina Mifsud", style: "veteran", bio: "Watched the Maltese coast for corsairs half her life." },
  { id: "k_antonio", company: "Carrack", role: "lookout", name: "Toni Azzopardi", style: "steady", bio: "Served in a coastal watchtower before going aloft." },
  { id: "k_isabeau", company: "Carrack", role: "lookout", name: "Grazzja Ċilia", style: "keen", bio: "Fears no height and misses no sail." },
  // The wartime tanker's company (company: "WarTanker"): United States Navy men of 1943.
  { id: "w_hale", company: "WarTanker", role: "captain", name: "Cdr Warren Hale", style: "veteran", bio: "Brought tankers through the U-boat lanes. Never lost his nerve." },
  { id: "w_dorsey", company: "WarTanker", role: "captain", name: "Lt Cdr Frank Dorsey", style: "steady", bio: "Came from a fleet oiler in the Pacific. Calm under fire." },
  { id: "w_whitlock", company: "WarTanker", role: "captain", name: "Lt James Whitlock", style: "keen", bio: "First command, straight from a destroyer." },
  { id: "w_brandt", company: "WarTanker", role: "navigator", name: "Lt Cdr Howard Brandt", style: "veteran", bio: "Taught star sights at the Academy before the war." },
  { id: "w_kowalski", company: "WarTanker", role: "navigator", name: "Lt Paul Kowalski", style: "steady", bio: "Two years of convoys navigated by dead reckoning." },
  { id: "w_lum", company: "WarTanker", role: "navigator", name: "Ensign Robert Lum", style: "keen", bio: "A ninety-day officer, top of the class at chartwork." },
  { id: "w_sayre", company: "WarTanker", role: "helm", name: "CQM Elmer Sayre", style: "veteran", bio: "Has stood wheel watches since the days of coal." },
  { id: "w_carter", company: "WarTanker", role: "helm", name: "QM2c Leon Carter", style: "steady", bio: "Holds convoy station on the darkest night." },
  { id: "w_novak", company: "WarTanker", role: "helm", name: "QM3c Billy Novak", style: "keen", bio: "Fresh from boot camp at Great Lakes, with light hands." },
  { id: "w_greer", company: "WarTanker", role: "engineer", name: "Lt Walter Greer", style: "veteran", bio: "Has nursed steam engines for twenty years." },
  { id: "w_moreno", company: "WarTanker", role: "engineer", name: "CMM Sal Moreno", style: "steady", bio: "Chief machinist's mate. Mends anything with what is aboard." },
  { id: "w_parker", company: "WarTanker", role: "engineer", name: "Ensign Gene Parker", style: "keen", bio: "Left engineering college to join up in 1942." },
  { id: "w_reyes", company: "WarTanker", role: "pump", name: "CWT Joaquin Reyes", style: "veteran", bio: "Has handled fuel in fleet oilers since before the war." },
  { id: "w_russo", company: "WarTanker", role: "pump", name: "MM2c Tony Russo", style: "steady", bio: "Worked a Texas refinery before enlisting." },
  { id: "w_sullivan", company: "WarTanker", role: "pump", name: "F1c Danny Sullivan", style: "keen", bio: "Fireman learning the cargo valves, careful and quick." },
  { id: "w_boone", company: "WarTanker", role: "gunner", name: "CGM Ellis Boone", style: "veteran", bio: "Chief gunner's mate who has run gun crews on three convoys." },
  { id: "w_mazur", company: "WarTanker", role: "gunner", name: "GM2c Stan Mazur", style: "steady", bio: "Armed Guard hand who came back from the Murmansk run." },
  { id: "w_lindqvist", company: "WarTanker", role: "gunner", name: "GM3c Ray Lindqvist", style: "keen", bio: "Best eye at gunnery school, itching for a target." },
  { id: "w_doyle", company: "WarTanker", role: "lookout", name: "BM1c Pat Doyle", style: "veteran", bio: "Spotted a periscope off Hatteras and has watched hard since." },
  { id: "w_jensen", company: "WarTanker", role: "lookout", name: "SM2c Carl Jensen", style: "steady", bio: "Signalman with a sharp eye for a wake." },
  { id: "w_larsen", company: "WarTanker", role: "lookout", name: "S2c Eddie Larsen", style: "keen", bio: "Farm boy who sees a smoke plume before anyone." }
];

// A ship of another age has its own people (company above), its own names for the
// posts, and its own names for the Dockyard equipment that helps them.
const CREW_ERAS = {
  WarTanker: {
    roles: {
      navigator: { title: "Navigator", duty: "Keeps the reckoning by chart, compass and star sights; cons her into a sighted harbour." },
      helm: { title: "Quartermaster", duty: "Stands the wheel: quicker helm, holds her against wind and sea." },
      engineer: { title: "Engineering Officer", duty: "Tends the boilers and steam engine, and runs damage control." },
      pump: { title: "Cargo Pump Chief", duty: "Keeps the fuel cargo safe: tougher against gunfire and fire." },
      gunner: { title: "Armed Guard Gunnery", duty: "Commands the deck guns: faster loading and longer reach." },
      lookout: { title: "Lookout", duty: "Stands watch with binoculars for periscopes, smoke and raiders." }
    },
    kit: {
      chartPlotter: { name: "Dead reckoning tracer", does: "traces your track on the map (Able); marks the way into a sighted harbour (sea: Skilled)" },
      weatherStation: { name: "Aerographer's instruments", does: "forecasts storms (Able), whirlpools and great waves (Skilled)" },
      radar: { name: "SG surface radar", does: "calls dangers from further off, marks beasts and shapes below" },
      fireFighting: { name: "Damage control gear", does: "puts fires out" }
    }
  },
  Carrack: {
    roles: {
      navigator: { title: "Pilot", duty: "Keeps the reckoning by compass, lead and chart; pilots her into a sighted harbour." },
      sails: { title: "Sailing Master", duty: "Trims yards and sails for every wind: more drive, less leeway." },
      helm: { title: "Helmsman", duty: "Works the whipstaff: answers sooner, holds her against wind and sea." },
      bosun: {
        title: "Boatswain",
        duty: "Runs the deck: cables, boats and fire buckets.",
        ranks: ["Lines handled faster, fires spread slower", "Calls out fires at once", "Fights fires unasked (needs buckets and sand)", "Fire parties react quicker", "Fastest lines and fire parties"]
      },
      gunner: { title: "Master Gunner", duty: "Lays the cannon: quicker loading and longer reach." },
      lookout: { title: "Lookout in the Top", duty: "Watches from the fighting top and hails the deck." }
    },
    kit: {
      chartPlotter: { name: "Portolan chart", does: "pricks your track on the map (Able); marks the way into a sighted harbour (sea: Skilled)" },
      weatherStation: { name: "Weather lore", does: "foretells storms (Able), whirlpools and great waves (Skilled)" },
      radar: { name: "Masthead watch", does: "hails dangers from further off, marks beasts and shapes below" },
      fireFighting: { name: "Buckets and sand", does: "lets the boatswain (Skilled) put fires out unbidden" }
    }
  }
};

// The post as it is known aboard that kind of ship.
function crewRole(category, role) {
  return { ...CREW_ROLES[role], ...CREW_ERAS[category]?.roles[role] };
}

const CREW_UNIT_METRES = 3; // 1 game unit is about 3 m
const CREW_CARD_TIME = 5; // seconds a crew call stays on screen
const CREW_CALL_GAP = 6; // seconds between routine calls on one ship
const CREW_SPOKEN_COMPASS = { N: "north", NE: "north east", E: "east", SE: "south east", S: "south", SW: "south west", W: "west", NW: "north west" };
const CREW_RADAR_RANGE = 1000; // units: contacts the radar puts on the map

// ---------------------------------------------------------------------------
// Roster, experience
// ---------------------------------------------------------------------------

function crewData(profile) {
  if (!profile.crew) profile.crew = { assign: {}, xp: {} };
  return profile.crew;
}

function crewPerson(id) {
  return CREW_PEOPLE.find((p) => p.id === id) || null;
}

function crewPosts(category) {
  return CREW_POSTS[category] || [];
}

function crewAssigned(profile, shipId, role) {
  const person = crewPerson(crewData(profile).assign[shipId]?.[role]);
  return person && person.role === role && crewServes(person, getShipDefinition(shipId).category) ? person : null;
}

// Warships take navy people only, the carrack and the wartime tanker their own
// companies; civilians (no company) serve in all the rest.
function crewServes(person, category) {
  const company = CREW_NAVY_SHIPS.includes(category) ? "Navy" : CREW_ERAS[category] ? category : undefined;
  return person.company === company;
}

function crewXp(profile, person) {
  return crewData(profile).xp[person.id] ?? CREW_STYLES[person.style].start;
}

function crewRankFor(xp) {
  let level = 0;
  while (level < CREW_RANK_XP.length - 1 && xp >= CREW_RANK_XP[level + 1]) level += 1;
  return level;
}

function crewAssign(slot, shipId, personId) {
  const profile = getProfile(slot);
  const person = crewPerson(personId);
  const data = crewData(profile);
  if (!data.assign[shipId]) data.assign[shipId] = {};
  data.assign[shipId][person.role] = personId;
  saveProfiles();
  setUiMessage(`${person.name} signed on as ${crewRole(getShipDefinition(shipId).category, person.role).title}`);
}

function crewRelieve(slot, shipId, role) {
  const profile = getProfile(slot);
  const person = crewAssigned(profile, shipId, role);
  if (!person) return;
  delete crewData(profile).assign[shipId][role];
  saveProfiles();
  setUiMessage(`${person.name} has gone ashore (experience is kept)`);
}

// The posts on a ship that nobody holds.
function crewVacancies(profile, shipId) {
  return crewPosts(getShipDefinition(shipId).category).filter((role) => !crewAssigned(profile, shipId, role));
}

// A ship can't sail short-handed. If this one is, its crew screen opens at the
// first empty post, to come back to the ship choice; true = don't start yet.
function crewRequired(slot, shipId) {
  const vacant = crewVacancies(getProfile(slot), shipId);
  if (!vacant.length) return false;
  openCrewScreen(slot, shipId, "shipSelect");
  game.crewView.required = true;
  crewSelectPost(crewPosts(getShipDefinition(shipId).category).indexOf(vacant[0]));
  playUiError();
  return true;
}

// The person in a post on a ship that is sailing (players' ships only).
function crewOn(ship, role) {
  if (!ship || !ship.isHuman || !ship.playerSlot) return null;
  if (!crewPosts(ship.category).includes(role)) return null;
  return crewAssigned(getProfile(ship.playerSlot), ship.shipId, role);
}

// Rank 0..4 of whoever holds the post, or -1 when it is empty.
function crewLevel(ship, role) {
  const person = crewOn(ship, role);
  return person ? crewRankFor(crewXp(getProfile(ship.playerSlot), person)) : -1;
}

// How much of a post's full benefit the ship gets: 0 (nobody) .. 1 (Master).
function crewSkill(ship, role) {
  return (crewLevel(ship, role) + 1) / CREW_RANKS.length;
}

let crewUnsaved = false;
let crewSavedAt = 0;

function crewFlush() {
  if (!crewUnsaved) return;
  crewUnsaved = false;
  saveProfiles();
}

function crewGain(ship, role, amount) {
  const person = crewOn(ship, role);
  if (!person) return;
  const profile = getProfile(ship.playerSlot);
  const before = crewXp(profile, person);
  const taught = role === "captain" ? 1 : 1 + 0.25 * crewSkill(ship, "captain");
  const after = before + amount * CREW_STYLES[person.style].learn * taught;
  crewData(profile).xp[person.id] = after;
  crewUnsaved = true;
  const rank = crewRankFor(after);
  if (rank > crewRankFor(before)) {
    crewFlush();
    const to = role === "captain" ? "" : ", Captain"; // the captain does not report to himself
    crewCard(ship, role, `I've made ${CREW_RANKS[rank]}${to}. ${crewRole(ship.category, role).ranks[rank]}.`);
    playPurchaseTone();
  }
}

// ---------------------------------------------------------------------------
// Calls while sailing
// ---------------------------------------------------------------------------

// The picture-and-words card on screen (also when sound is off).
function crewCard(ship, role, text) {
  const person = crewOn(ship, role);
  if (person) ship.crewCard = { person, role, text, until: game.elapsed + CREW_CARD_TIME };
}

// A crew member speaks up. `key` + `every` stop the same thing being repeated;
// routine calls also leave CREW_CALL_GAP between each other, urgent ones don't.
function crewSay(ship, role, key, every, text, { urgent = false, spoken = text } = {}) {
  if (!crewOn(ship, role)) return false;
  if (!ship.crewCalls) ship.crewCalls = {};
  const now = game.elapsed;
  if (now - (ship.crewCalls[key] ?? -Infinity) < every) return false;
  if (!urgent && now - (ship.crewSpokeAt ?? -Infinity) < CREW_CALL_GAP) return false;
  ship.crewCalls[key] = now;
  ship.crewSpokeAt = now;
  crewCard(ship, role, text);
  const who = humanShips().length > 1 ? `Captain ${ship.playerName || ""}` : "Captain";
  speakCall(`${who}, ${spoken}`);
  return true;
}

function crewBearing(from, to) {
  return compassBearing(Math.atan2(to.y - from.y, to.x - from.x));
}

function crewCompass(bearing) {
  return COMPASS_POINTS[Math.round(bearing / 45) % 8];
}

// "045" on screen, "0 4 5" spoken, as on a bridge.
function crewDegrees(bearing) {
  return String(Math.round(bearing) % 360).padStart(3, "0");
}

function crewMetres(units) {
  return Math.max(50, Math.round((units * CREW_UNIT_METRES) / 50) * 50);
}

// A course or bearing as called aboard: degrees, or compass points in the carrack.
function crewHeading(ship, bearing) {
  if (ship.category !== "Carrack") return crewDegrees(bearing);
  return COMPASS_RHUMBS[Math.round(bearing / 11.25) % 32];
}

// The same for the voice: "0 4 5", or "north east by north".
function crewHeadingSpoken(ship, bearing) {
  if (ship.category !== "Carrack") return crewDegrees(bearing).split("").join(" ");
  const words = { N: "north", E: "east", S: "south", W: "west" };
  return crewHeading(ship, bearing).split(" ").map((part) => (part === "BY" ? "by" : [...part].map((c) => words[c]).join(" "))).join(" ");
}

// A distance: metres today, yards in the 1943 navy, cables (about 185 m) in the carrack.
function crewDistance(ship, units) {
  if (ship.category === "WarTanker") return `${Math.max(50, Math.round((units * CREW_UNIT_METRES * 1.094) / 50) * 50)} yards`;
  if (ship.category !== "Carrack") return `${crewMetres(units)} metres`;
  const cables = Math.max(1, Math.round((units * CREW_UNIT_METRES) / 185));
  return `${cables} cable${cables === 1 ? "" : "s"}`;
}

// What the lookout shouts about a danger (game.js updateLookout).
function crewLookoutText(ship, d) {
  const level = crewLevel(ship, "lookout");
  let where = directionFrom(ship, d.x, d.y);
  if (level >= 2) {
    const a = normalizeAngle(Math.atan2(d.y - ship.y, d.x - ship.x) - ship.angle);
    const side = a > 0 ? "starboard" : "port";
    const off = Math.abs((a * 180) / Math.PI);
    where = off < 12 ? "dead ahead" : off < 55 ? `on the ${side} bow` : off < 115 ? `on the ${side} beam` : off < 168 ? `on the ${side} quarter` : "dead astern";
  }
  const far = level >= 1 ? `, ${crewDistance(ship, Math.max(0, d.gap))}` : "";
  return `${d.name} ${where}${far}!`;
}

function crewLookoutRange(ship) {
  const skill = crewSkill(ship, "lookout");
  if (!skill) return LOOKOUT_RANGE;
  return LOOKOUT_RANGE + 350 * skill + (ship.owned.radar ? 250 : 0);
}

// ---------------------------------------------------------------------------
// Navigation: the course into a sighted Harbour B, and the ship's track
// ---------------------------------------------------------------------------

const CREW_ENTRANCE = 320; // along both quays: just outside the gap in the breakwaters
const CREW_TRACK_STEP = 60; // units between the points of a plotted track

function crewCourseClear(ship, a, b, avoid) {
  if (!routeLineIsClear(ship, a.x, a.y, b.x, b.y)) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  return avoid.every((o) => {
    if (Math.hypot(a.x - o.x, a.y - o.y) < o.r || Math.hypot(b.x - o.x, b.y - o.y) < o.r) return true;
    const t = clamp(((o.x - a.x) * dx + (o.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(a.x + dx * t - o.x, a.y + dy * t - o.y) >= o.r;
  });
}

// What the course should skirt besides land: ice always (unless this is the
// icebreaker), the moving dangers once the navigator is Senior.
function crewAvoidList(ship, level) {
  const avoid = [];
  if (ship.category !== "Icebreaker") for (const s of game.iceSheets) avoid.push({ x: s.x, y: s.y, r: s.r });
  if (level < 3) return avoid;
  for (const dz of dynamicDangers) {
    if (!(dz.arriveIn > 0)) avoid.push({ x: dz.x, y: dz.y, r: dz.r + 70 });
  }
  if (waterSpout.state !== "dormant") avoid.push({ x: waterSpout.x, y: waterSpout.y, r: waterSpout.r + 70 });
  if (whirlpool.state !== "dormant") avoid.push({ x: whirlpool.x, y: whirlpool.y, r: WHIRLPOOL_MAX_R + 40 });
  for (const p of [game.ai, ...game.pirateRaiders]) {
    if (p && !p.capsized) avoid.push({ x: p.x, y: p.y, r: 210 });
  }
  return avoid;
}

// Free Play: points from the ship to Harbour B. The first point is the ship itself, so
// the line stays attached to it between re-plans.
function crewPlanCourse(ship, level) {
  if (level < 1) return [ship, HarbourB];
  const entry = harbourPoint(HarbourB, CREW_ENTRANCE, CREW_ENTRANCE);
  if (dist(ship, HarbourB) < dist(entry, HarbourB) + 40) return [ship, HarbourB];
  const exit = berthedHarbour(ship) === HarbourA ? harbourPoint(HarbourA, CREW_ENTRANCE, CREW_ENTRANCE) : null;
  const from = exit || { x: ship.x, y: ship.y };
  const avoid = crewAvoidList(ship, level);
  const raw = planPirateRoute({ x: from.x, y: from.y, radius: ship.radius }, entry, avoid) || [from, entry];
  const points = [from, ...raw.slice(1)];
  // Straighten the grid route: from each corner go to the farthest point in clear sight.
  const course = exit ? [ship, exit] : [ship];
  for (let i = 0; i < points.length - 1; ) {
    let j = points.length - 1;
    while (j > i + 1 && !crewCourseClear(ship, points[i], points[j], avoid)) j -= 1;
    course.push(points[j]);
    i = j;
  }
  course.push(HarbourB);
  return course;
}

function crewCourseLength(course) {
  let length = 0;
  for (let i = 1; i < course.length; i += 1) length += dist(course[i - 1], course[i]);
  return length;
}

function crewNavigate(ship) {
  const level = crewLevel(ship, "navigator");
  // (mission waters are uncharted: no course to plot)
  if (game.mission || level < 0 || berthedHarbour(ship) === HarbourB || !harbourBInSight(ship)) {
    ship.course = null;
    return;
  }
  if (ship.course && game.elapsed < ship.courseAt) return;
  ship.courseAt = game.elapsed + (level >= 4 ? 1 : 2) * (TOUCH_UI ? 2 : 1); // phones re-plan half as often
  ship.course = crewPlanCourse(ship, level);
}

// The point to steer for now.
function crewSteerPoint(ship) {
  const c = ship.course;
  return c.length > 2 && dist(ship, c[1]) < 70 ? c[2] : c[1];
}

function crewCourseAdvice(ship) {
  const level = crewLevel(ship, "navigator");
  if (!ship.course || ship.anchored || Math.abs(ship.speed) < 25) {
    ship.offCourseSince = null;
    return;
  }
  const point = crewSteerPoint(ship);
  const turn = normalizeAngle(Math.atan2(point.y - ship.y, point.x - ship.x) - ship.angle);
  if (Math.abs(turn) < 0.5) {
    ship.offCourseSince = null;
    return;
  }
  ship.offCourseSince ??= game.elapsed;
  if (game.elapsed - ship.offCourseSince < 2.5) return;
  const bearing = crewBearing(ship, point);
  const compass = CREW_SPOKEN_COMPASS[crewCompass(bearing)];
  if (level < 1) {
    const old = ship.category === "Carrack";
    const shown = old ? crewHeading(ship, bearing) : `${crewDegrees(bearing)}, ${compass}`;
    crewSay(ship, "navigator", "course", 30, `Harbour B bears ${shown}.`, { spoken: `Harbour B bears ${old ? crewHeadingSpoken(ship, bearing) : compass}.` });
    return;
  }
  const side = turn > 0 ? "starboard" : "port";
  crewSay(ship, "navigator", "course", 14, `come to ${side}, steer ${crewHeading(ship, bearing)} for Harbour B.`, {
    spoken: `come to ${side}, steer ${crewHeadingSpoken(ship, bearing)}.`
  });
}

// Land or ice dead ahead, called by whoever is able to see it coming.
function crewCollisionWarning(ship) {
  const nav = crewLevel(ship, "navigator");
  const watch = crewLevel(ship, "lookout");
  const role = watch >= 2 ? "lookout" : nav >= 2 ? "navigator" : null;
  if (!role || ship.anchored || ship.speed < 30) return;
  const seconds = nav >= 4 || watch >= 4 ? 6 : 4;
  for (let t = 1; t <= seconds; t += 0.5) {
    const x = ship.x + Math.cos(ship.angle) * ship.speed * t;
    const y = ship.y + Math.sin(ship.angle) * ship.speed * t;
    const hz = hazards.find((h) => Math.hypot(x - h.x, y - h.y) < h.r + ship.radius + 6);
    if (!hz) continue;
    const side = normalizeAngle(Math.atan2(hz.y - ship.y, hz.x - ship.x) - ship.angle) > 0 ? "port" : "starboard";
    if (!hz.crewKey) hz.crewKey = `land${Math.random()}`;
    crewSay(ship, role, hz.crewKey, 12, `${hz.kind} dead ahead, come to ${side}!`, { urgent: true });
    return;
  }
}

function crewWeatherAdvice(ship) {
  const level = crewLevel(ship, "navigator");
  if (level < 1 || !ship.owned.weatherStation) return;
  const windFrom = crewCompass(compassBearing(Math.atan2(-game.wind.y, -game.wind.x)));
  const notice = level >= 4 ? 30 : 18;
  for (const dz of dynamicDangers) {
    if (!(dz.arriveIn > 0 && dz.arriveIn < notice)) continue;
    if (!dz.crewKey) dz.crewKey = `storm${Math.random()}`;
    crewSay(ship, "navigator", dz.crewKey, notice + 5, `storm blowing in from the ${CREW_SPOKEN_COMPASS[windFrom]} in about ${Math.ceil(dz.arriveIn)} seconds.`);
  }
  if (level < 2) return;
  if (whirlpool.state === "active" && whirlpool.age < 4) {
    crewSay(ship, "navigator", "whirlpool", 20, `a whirlpool is opening to the ${CREW_SPOKEN_COMPASS[crewCompass(crewBearing(ship, whirlpool))]}, keep clear.`);
  }
  if (tsunami.state !== "dormant" && !tsunami.passed.has(ship) && !ship.anchored && !shipFacesTsunami(ship)) {
    const bearing = compassBearing(Math.atan2(-tsunami.dirY, -tsunami.dirX));
    crewSay(ship, "navigator", "tsunami", 4, `turn into the wave, steer ${crewHeading(ship, bearing)}!`, { urgent: true, spoken: `turn into the wave, steer ${crewHeadingSpoken(ship, bearing)}!` });
  }
}

// The other posts' suggestions.
function crewAdvice(ship) {
  const key = (action) => (TOUCH_UI ? "" : ` (${keyName(game.settings.keybinds[ship.playerSlot + action])})`);
  crewCollisionWarning(ship);
  crewWeatherAdvice(ship);

  if (ship.fire) {
    const bosun = crewLevel(ship, "bosun");
    if (bosun >= 2 && ship.owned.fireFighting && ship.fire.outAt === Infinity) {
      ship.fire.outAt = natureClock + (6 - bosun);
      crewSay(ship, "bosun", "fire", 8, "fire on board, my party is on it!", { urgent: true });
    } else if (bosun >= 1 && ship.fire.outAt === Infinity) {
      const none = ship.category === "Carrack" ? "no buckets or sand" : "no fire fighting equipment";
      const text = ship.owned.fireFighting ? "fire on board, get water on it" : `fire on board and we have ${none}`;
      crewSay(ship, "bosun", "fire", 12, `${text}${ship.owned.fireFighting ? key("Fire") : ""}!`, { urgent: true, spoken: `${text}!` });
    }
  }

  if (crewLevel(ship, "engineer") >= 1 && ship.hp < ship.maxHull * 0.5 && ship.repairReserve > ship.repairRecovered) {
    const text = `hull at ${Math.round((ship.hp / ship.maxHull) * 100)} percent, I advise repairs`;
    crewSay(ship, "engineer", "repair", 30, `${text}${key("Repair")}.`, { spoken: `${text}.` });
  }

  if (crewLevel(ship, "gunner") >= 1 && ship.reload <= 0 && !safeInHarbour(ship)) {
    const target = pickAttackTarget(ship, mode === "local" ? (ship === game.player1 ? game.player2 : game.player1) : game.ai);
    if (target && !safeInHarbour(target) && dist(ship, target) <= 90 + ship.attackRangeBonus + crewGunRange(ship) &&
        gunsBear(ship, Math.abs(normalizeAngle(Math.atan2(target.y - ship.y, target.x - ship.x) - ship.angle)), 0.42)) {
      crewSay(ship, "gunner", "fireNow", 12, `target on the bow, open fire${key("Attack")}!`, { urgent: true, spoken: "target on the bow, open fire!" });
    }
  }

  if (crewLevel(ship, "pump") >= 1 && ship.hitHeat >= 2 && game.elapsed - ship.hitHeatAt < 2) {
    crewSay(ship, "pump", "cargo", 15, "we're taking hits, much more and the cargo goes up!", { urgent: true });
  }

  // The carrack's Sailing Master reports a wind that won't serve, whatever their rank.
  if (ship.category === "Carrack" && !ship.anchored && !carrackPort(ship) && carrackWind(ship).light) {
    crewSay(ship, "sails", "calm", 30, "there isn't wind enough to fill her sails, we'll make little way.", { urgent: true });
  }

  if (crewLevel(ship, "sails") >= 1 && !ship.anchored && !berthedHarbour(ship)) {
    const windFrom = Math.atan2(-game.wind.y, -game.wind.x);
    const rel = normalizeAngle(windFrom - ship.angle);
    if (Math.abs(rel) < 0.6 && Math.hypot(game.wind.x, game.wind.y) > 12) {
      const side = rel > 0 ? "port" : "starboard";
      crewSay(ship, "sails", "headwind", 30, `we're head to wind, bear away to ${side} when you can.`);
    }
  }

  if (crewLevel(ship, "ice") >= 2 && ship.ice === "solid") {
    for (const turn of [0.6, -0.6, 1.2, -1.2]) {
      const a = ship.angle + turn;
      if (iceAt(ship.x + Math.cos(a) * 110, ship.y + Math.sin(a) * 110) !== "solid") {
        crewSay(ship, "ice", "lead", 14, `easier water to ${turn > 0 ? "starboard" : "port"}.`);
        break;
      }
    }
  }

  if (crewLevel(ship, "tow") >= 1 && !ship.tow && !ship.anchored) {
    const near = seaShips().find((s) => s !== ship && !s.capsized && !s.anchored && dist(ship, s) - shipHalfLength(ship) - shipHalfLength(s) < TOW_REACH);
    if (near) {
      const text = `${shipLabel(near)} is close enough to take in tow`;
      crewSay(ship, "tow", "tow", 25, `${text}${key("Tow")}.`, { spoken: `${text}.` });
    }
  }

  crewCourseAdvice(ship);
}

// Once per simulation step while sailing: experience for work done, the
// course, and the calls.
function crewUpdate(dt) {
  for (const ship of humanShips()) {
    if (ship.capsized) continue;
    ship.crewTick = (ship.crewTick || 0) + dt;
    if (ship.crewTick < 0.5) continue;
    const step = ship.crewTick;
    ship.crewTick = 0;

    const moving = !ship.anchored && Math.abs(ship.speed) > 25;
    const extra = {
      helm: moving && sea.roughness > 0.45 ? 1.5 : 0,
      engineer: Math.abs(ship.speed) > ship.maxSpeed * 0.6 ? 0.5 : 0,
      sails: moving && Math.hypot(game.wind.x, game.wind.y) > 15 ? 1 : 0,
      ice: moving && ship.ice ? 2 : 0,
      tow: ship.tow ? 2 : 0,
      pump: pumpHose(ship) ? 1.5 : 0,
      navigator: moving && ship.offCourseSince == null ? 0.5 : 0
    };
    for (const role of crewPosts(ship.category)) {
      const earned = (moving ? 1 : 0) + (extra[role] || 0);
      if (earned > 0) crewGain(ship, role, earned * step);
    }
    crewNavigate(ship);
    if (ship.owned.chartPlotter) {
      ship.track ||= [];
      const last = ship.track[ship.track.length - 1];
      if (!last || dist(ship, last) >= CREW_TRACK_STEP) ship.track.push({ x: ship.x, y: ship.y });
    }
    crewAdvice(ship);
  }
  if (crewUnsaved && performance.now() - crewSavedAt > 5000) {
    crewSavedAt = performance.now();
    crewFlush();
  }
}

// Arriving at Harbour B: experience for everyone, and the extra points the
// Hotel Director or Cargo Officer brings in.
function crewDelivery(ship) {
  for (const role of crewPosts(ship.category)) {
    crewGain(ship, role, role === "purser" || role === "cargo" || role === "navigator" ? CREW_DELIVERY_XP * 1.6 : CREW_DELIVERY_XP);
  }
  return Math.round(60 * Math.max(crewSkill(ship, "purser"), crewSkill(ship, "cargo")));
}

function crewGunRange(ship) {
  return 16 * crewSkill(ship, "gunner");
}

// ---------------------------------------------------------------------------
// On screen while sailing
// ---------------------------------------------------------------------------

const crewImages = {};
function crewPortrait(id) {
  if (!crewImages[id]) {
    crewImages[id] = new Image();
    crewImages[id].src = `assets/crew/${id}.jpg`;
  }
  return crewImages[id];
}

function drawCrewPortrait(id, x, y, size) {
  const img = crewPortrait(id);
  ctx.fillStyle = "#1b3446";
  ctx.fillRect(x, y, size, size);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, x, y, size, size);
}

// Splits text into at most `lines` lines no wider than `width`.
function crewWrap(text, width, lines) {
  const out = [""];
  for (const word of text.split(" ")) {
    const next = out[out.length - 1] ? `${out[out.length - 1]} ${word}` : word;
    if (ctx.measureText(next).width <= width || !out[out.length - 1]) out[out.length - 1] = next;
    else if (out.length < lines) out.push(word);
    else {
      out[out.length - 1] = fitText(`${out[out.length - 1]} ${word}`, width);
      break;
    }
  }
  return out;
}

// The navigator's course drawn on the sea: needs the Chart Plotter and a
// Skilled navigator (Able draws it on the map only).
function drawCrewCourse() {
  for (const ship of humanShips()) {
    if (ship.capsized || !ship.course || !ship.owned.chartPlotter || crewLevel(ship, "navigator") < 2) continue;
    const bridge = view3d.active && game.settings.cameraView === "bridge";
    if (bridge && !bridgeFocus[ship.playerSlot]) continue; // not across the bridge fittings
    const slot = view3d.active && view3d.split ? ship.playerSlot : undefined;
    // Start clear of the ship: behind it (chase) the hull hides the sea close ahead.
    const chase = view3d.active && game.settings.cameraView === "chase";
    const nearest = bridge ? 220 : shipHalfLength(ship) + (chase ? 160 : 25);
    const spacing = 45;
    let along = spacing - ((game.elapsed * 30) % spacing); // the marks run towards the harbour
    let travelled = 0;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < ship.course.length && travelled < 900; i += 1) {
      const a = ship.course[i - 1];
      const b = ship.course[i];
      const len = dist(a, b) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      for (; along < len && travelled + along < 900; along += spacing) {
        if (travelled + along < nearest) continue;
        const x = a.x + ux * along;
        const y = a.y + uy * along;
        const tip = worldToScreen(x + ux * 8, y + uy * 8, 1, slot);
        const left = worldToScreen(x - ux * 5 - uy * 8, y - uy * 5 + ux * 8, 1, slot);
        const right = worldToScreen(x - ux * 5 + uy * 8, y - uy * 5 - ux * 8, 1, slot);
        if (!tip.visible || !left.visible || !right.visible) continue;
        ctx.globalAlpha = 0.85 * (1 - (travelled + along) / 950);
        for (const [width, color] of [[5, "rgba(0, 20, 30, 0.7)"], [2.5, ship === game.player2 ? "#ffd889" : "#7ff3d8"]]) {
          ctx.lineWidth = width;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(left.x, left.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.lineTo(right.x, right.y);
          ctx.stroke();
        }
      }
      along -= len;
      travelled += len;
    }
    ctx.restore();
  }
}

// Chart plotter and radar on the map in the corner (called by drawMiniMap).
function drawCrewChart(mmX, mmY, sx, sy) {
  ctx.save();
  for (const ship of humanShips()) {
    if (ship.capsized) continue;
    if (ship.track && crewLevel(ship, "navigator") >= 1) {
      // where she has been
      ctx.strokeStyle = ship === game.player2 ? "rgba(255, 216, 137, 0.6)" : "rgba(127, 243, 216, 0.6)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      [...ship.track, ship].forEach((p, i) => (i ? ctx.lineTo(mmX + p.x * sx, mmY + p.y * sy) : ctx.moveTo(mmX + p.x * sx, mmY + p.y * sy)));
      ctx.stroke();
    }
    if (ship.course && ship.owned.chartPlotter && crewLevel(ship, "navigator") >= 1) {
      ctx.strokeStyle = ship === game.player2 ? "#ffd889" : "#7ff3d8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ship.course.forEach((p, i) => (i ? ctx.lineTo(mmX + p.x * sx, mmY + p.y * sy) : ctx.moveTo(mmX + p.x * sx, mmY + p.y * sy)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ship.owned.radar && crewOn(ship, "lookout")) {
      for (const [list, color] of [[game.seaCreatures, "#ff6ad5"], [game.underwaterEnemies, "#ff5a4d"]]) {
        for (const e of list) {
          if (e.capsized || dist(ship, e) > CREW_RADAR_RANGE) continue;
          ctx.fillStyle = color;
          ctx.fillRect(mmX + e.x * sx - 2.5, mmY + e.y * sy - 2.5, 5, 5);
        }
      }
    }
  }
  ctx.restore();
}

// The latest crew call, with the speaker's picture; under it, from a Skilled
// navigator, how far there is to go.
function drawCrewHud() {
  const split = view3d.active && view3d.split;
  const bridge = view3d.active && game.settings.cameraView === "bridge";
  humanShips().forEach((ship, i) => {
    if (ship.capsized) return;
    const w = 340;
    const x = i === 0 ? 8 : split ? WIDTH / 2 + 8 : WIDTH - w - 8;
    let y = bridge ? 156 : 70;
    const card = ship.crewCard;
    ctx.save();
    ctx.textAlign = "left";
    if (card && game.elapsed < card.until) {
      ctx.globalAlpha = Math.min(1, card.until - game.elapsed);
      ctx.fillStyle = "rgba(7, 24, 35, 0.82)";
      ctx.fillRect(x, y, w, 64);
      ctx.strokeStyle = i === 0 ? "rgba(151, 214, 255, 0.6)" : "rgba(255, 218, 161, 0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, 64);
      drawCrewPortrait(card.person.id, x + 4, y + 4, 56);
      ctx.fillStyle = "#9ed7ff";
      ctx.font = "bold 11px Segoe UI";
      ctx.fillText(`${card.person.name}  -  ${crewRole(ship.category, card.role).title}`, x + 68, y + 15);
      ctx.fillStyle = "#f4fbff";
      ctx.font = "13px Segoe UI";
      const said = card.text.charAt(0).toUpperCase() + card.text.slice(1);
      crewWrap(said, w - 76, 2).forEach((line, n) => ctx.fillText(line, x + 68, y + 34 + n * 17));
      y += 68;
    }
    if (ship.course && crewLevel(ship, "navigator") >= 2) {
      const left = crewCourseLength(ship.course);
      const eta = left / Math.max(60, Math.abs(ship.speed));
      const far = CREW_ERAS[ship.category] ? crewDistance(ship, left) : `${((left * CREW_UNIT_METRES) / 1000).toFixed(1)} km`;
      const text = `Harbour B  ${far}  |  steer ${crewHeading(ship, crewBearing(ship, crewSteerPoint(ship)))}  |  about ${Math.round(eta)} s`;
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(7, 24, 35, 0.6)";
      ctx.fillRect(x, y, w, 22);
      ctx.fillStyle = "#bff5e6";
      ctx.font = "12px Segoe UI";
      ctx.fillText(text, x + 8, y + 15);
    }
    ctx.restore();
  });
}

// ---------------------------------------------------------------------------
// The Ship Crew screen
// ---------------------------------------------------------------------------

// game.crewView: { slot, shipId, post, pick, returnTo }
function openCrewScreen(slot = "p1", shipId = usableShipId(slot), returnTo = "menu") {
  game.crewView = { slot, shipId, post: 0, pick: 0, returnTo };
  crewShowAssigned();
  gameState = "crew";
}

function closeCrewScreen() {
  gameState = game.crewView.returnTo;
}

function crewViewPost() {
  const posts = crewPosts(getShipDefinition(game.crewView.shipId).category);
  return posts[game.crewView.post];
}

// The people who can take a post on the ship shown on the crew screen.
function crewCandidates(role) {
  const category = getShipDefinition(game.crewView.shipId).category;
  return CREW_PEOPLE.filter((p) => p.role === role && crewServes(p, category));
}

// Highlight whoever holds the selected post.
function crewShowAssigned() {
  const view = game.crewView;
  const person = crewAssigned(getProfile(view.slot), view.shipId, crewViewPost());
  view.pick = person ? crewCandidates(person.role).indexOf(person) : 0;
}

function crewSelectPost(index) {
  const count = crewPosts(getShipDefinition(game.crewView.shipId).category).length;
  game.crewView.post = (index + count) % count;
  crewShowAssigned();
}

function crewSwitchCaptain() {
  if (game.midGameChange) return; // crewing a replacement ship in mid-voyage
  const slot = game.crewView.slot === "p1" ? "p2" : "p1";
  openCrewScreen(slot, usableShipId(slot), game.crewView.returnTo);
}

function handleCrewKey(code) {
  const view = game.crewView;
  const role = crewViewPost();
  const count = crewCandidates(role).length;
  if (code === "Escape") closeCrewScreen();
  else if (code === "ArrowUp") crewSelectPost(view.post - 1);
  else if (code === "ArrowDown") crewSelectPost(view.post + 1);
  else if (code === "ArrowLeft") view.pick = (view.pick + count - 1) % count;
  else if (code === "ArrowRight") view.pick = (view.pick + 1) % count;
  else if (code === "Enter") crewAssign(view.slot, view.shipId, crewCandidates(role)[view.pick].id);
  else if (code === "Backspace") crewRelieve(view.slot, view.shipId, role);
  else if (code === "Tab") crewSwitchCaptain();
  else if (code === "KeyO" && !game.midGameChange) openShop(view.slot);
}

function drawCrewXpBar(x, y, w, xp) {
  const rank = crewRankFor(xp);
  const from = CREW_RANK_XP[rank];
  const to = CREW_RANK_XP[rank + 1];
  ctx.fillStyle = "rgba(220, 235, 245, 0.18)";
  ctx.fillRect(x, y, w, 5);
  ctx.fillStyle = "#6ce5d9";
  ctx.fillRect(x, y, w * (to ? clamp((xp - from) / (to - from), 0, 1) : 1), 5);
}

function drawCrewBox(x, y, w, h, selected) {
  ctx.fillStyle = selected ? "rgba(91, 145, 177, 0.5)" : "rgba(14, 40, 58, 0.9)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = selected ? "#ffd182" : "rgba(166, 218, 244, 0.3)";
  ctx.lineWidth = selected ? 2.5 : 1;
  ctx.strokeRect(x, y, w, h);
}

function drawCrewScreen() {
  const view = game.crewView;
  const profile = getProfile(view.slot);
  const ship = getShipDefinition(view.shipId);
  const posts = crewPosts(ship.category);
  const role = posts[view.post];
  const info = crewRole(ship.category, role);
  const holder = crewAssigned(profile, view.shipId, role);
  const filled = posts.filter((p) => crewAssigned(profile, view.shipId, p)).length;

  ctx.save();
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(6, 18, 28, 0.94)";
  ctx.fillRect(20, 16, WIDTH - 40, HEIGHT - 32);
  ctx.strokeStyle = "#d7edf9";
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 16, WIDTH - 40, HEIGHT - 32);

  const headX = TOUCH_UI ? 170 : 40; // the touch Back button sits in the top left corner
  const headW = 500 - headX; // the header's buttons start here
  ctx.fillStyle = "#f7fbff";
  ctx.font = "30px Segoe UI";
  ctx.fillText("Ship Crew", headX, 56);
  ctx.font = "17px Segoe UI";
  ctx.fillStyle = view.slot === "p1" ? "#bfe8ff" : "#ffe3c0";
  if (view.required) {
    const short = posts.length - filled;
    ctx.fillStyle = short ? "#ffb18c" : "#89d98b";
    ctx.fillText(
      short ? `${ship.name} can't sail yet: sign on ${short} more crew  (${profile.name})` : `${ship.name} is fully crewed: press Back, then set sail  (${profile.name})`,
      headX, 82, headW);
  } else {
    ctx.fillText(`${ship.name}  -  ${profile.name}  -  ${filled} of ${posts.length} posts filled`, headX, 82, headW);
  }
  ctx.font = "15px Segoe UI";
  if (!game.midGameChange) {
    drawDockButton(TOUCH_UI ? "Other captain" : "Other captain (Tab)", 512, 26, 272, 62, "rgba(24, 73, 97, 0.9)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", crewSwitchCaptain, "captains");
    drawDockButton(TOUCH_UI ? "Dockyard" : "Dockyard (O)", 794, 26, 200, 62, "rgba(27, 98, 72, 0.92)", "rgba(196, 255, 224, 0.45)", "#e7fff4", () => openShop(view.slot), "crane");
  }
  drawDockButton(TOUCH_UI ? "Back" : "Back (Esc)", 1004, 26, 162, 62, "rgba(24, 73, 97, 0.9)", "rgba(166, 218, 244, 0.5)", "#e8f6ff", closeCrewScreen, "back");

  // the posts this ship needs
  posts.forEach((p, i) => {
    const y = 98 + i * 76;
    const person = crewAssigned(profile, view.shipId, p);
    drawCrewBox(40, y, 330, 70, i === view.post);
    if (person) drawCrewPortrait(person.id, 46, y + 6, 58);
    else {
      ctx.fillStyle = "rgba(220, 235, 245, 0.08)";
      ctx.fillRect(46, y + 6, 58, 58);
      ctx.fillStyle = "#7f99aa";
      ctx.font = "28px Segoe UI";
      ctx.fillText("+", 67, y + 45);
    }
    ctx.fillStyle = "#9ed7ff";
    ctx.font = "bold 18px Segoe UI";
    ctx.fillText(crewRole(ship.category, p).title, 114, y + 24, 250);
    ctx.font = "16px Segoe UI";
    if (person) {
      const xp = crewXp(profile, person);
      ctx.fillStyle = "#f4fbff";
      ctx.fillText(`${person.name}  -  ${CREW_RANKS[crewRankFor(xp)]}`, 114, y + 46, 250);
      drawCrewXpBar(114, y + 53, 240, xp);
    } else {
      ctx.fillStyle = "#ffb18c";
      ctx.fillText("Vacant", 114, y + 46);
    }
    registerUiRect(40, y, 330, 70, () => crewSelectPost(i));
  });

  ctx.fillStyle = "#f7fbff";
  ctx.font = "bold 20px Segoe UI";
  ctx.fillText(info.title, 396, 118);
  ctx.fillStyle = "#c9dfea";
  ctx.font = "15px Segoe UI";
  ctx.fillText(info.duty, 396, 140);

  // the people who can take the post
  crewCandidates(role).forEach((person, i) => {
    const x = 396 + i * 256;
    const y = 152;
    const xp = crewXp(profile, person);
    const rank = crewRankFor(xp);
    const style = CREW_STYLES[person.style];
    const aboard = holder === person;
    drawCrewBox(x, y, 246, 340, i === view.pick);
    drawCrewPortrait(person.id, x + 51, y + 8, 144);
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4fbff";
    ctx.font = "bold 20px Segoe UI";
    ctx.fillText(person.name, x + 123, y + 174, 236);
    ctx.fillStyle = "#ffd182";
    ctx.font = "15px Segoe UI";
    ctx.fillText(`${CREW_RANKS[rank]}  |  ${style.label}`, x + 123, y + 194);
    drawCrewXpBar(x + 28, y + 202, 190, xp);
    ctx.fillStyle = "#c9dfea";
    ctx.font = "14px Segoe UI";
    crewWrap(person.bio, 232, 2).forEach((line, n) => ctx.fillText(line, x + 123, y + 225 + n * 17));
    ctx.fillStyle = "#8fb4c8";
    ctx.fillText(style.note, x + 123, y + 262, 236);
    ctx.textAlign = "left";
    registerUiRect(x, y, 246, 340, () => { view.pick = i; });
    ctx.font = "15px Segoe UI";
    drawDockButton(
      aboard ? "Relieve" : "Sign on",
      x + 14, y + 270, 218, 64,
      aboard ? "rgba(91, 73, 31, 0.92)" : "rgba(27, 98, 72, 0.92)",
      "rgba(196, 255, 224, 0.45)", "#f4fffa",
      () => {
        view.pick = i;
        if (aboard) crewRelieve(view.slot, view.shipId, role);
        else crewAssign(view.slot, view.shipId, person.id);
      }
    );
  });

  // what each rank brings, and the equipment this post can use
  const holderRank = holder ? crewRankFor(crewXp(profile, holder)) : -1;
  ctx.font = "15px Segoe UI";
  info.ranks.forEach((text, i) => {
    const y = 516 + i * 19;
    ctx.fillStyle = i === holderRank ? "#ffd182" : i < holderRank ? "#89d98b" : "#8fb4c8";
    ctx.fillText(`${CREW_RANKS[i]} (${CREW_RANK_XP[i]})`, 396, y);
    ctx.fillText(text, 500, y);
  });
  (CREW_EQUIPMENT[role] || []).forEach((kit, i) => {
    const item = SHOP_ITEMS.find((it) => it.id === kit.id);
    const fitted = !!profile.owned[kit.id];
    const y = 614 + i * 19;
    ctx.fillStyle = fitted ? "#89d98b" : "#ffb18c";
    const old = CREW_ERAS[ship.category]?.kit[kit.id];
    const buy = old ? `(Dockyard: ${item.name}, ${item.cost} pts)` : `(Dockyard, ${item.cost} pts)`;
    ctx.fillText(fitText(`${old ? old.name : item.name} ${fitted ? "(fitted)" : buy}: ${old ? old.does : kit.does}`, 760), 396, y);
  });

  ctx.fillStyle = "#ffd182";
  ctx.font = "13px Segoe UI";
  if (!TOUCH_UI) ctx.fillText("Up/Down: Post   Left/Right: Person   Enter: Sign on   Backspace: Relieve", 40, HEIGHT - 28);
  if (game.uiMessage) {
    ctx.fillStyle = "#d8f2ff";
    ctx.fillText(game.uiMessage, 40, HEIGHT - 48);
  }
  ctx.restore();
}
