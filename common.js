// GinkgoCam — code partagé entre la station maison et la vue iPhone.

// Classes YAMNet (AudioSet) qui comptent comme « c'est Ginkgo ».
// Un ballon qui tombe sort en « Thump, thud » / « Bouncing » : il n'est pas dans la liste.
export const DOG_LABELS = new Set([
  'Dog', 'Bark', 'Yip', 'Howl', 'Bow-wow', 'Growling', 'Whimper (dog)',
  'Canidae, dogs, wolves',
]);

// Traduction des sons les plus courants pour le journal.
const FR = {
  'Dog': 'Chien', 'Bark': 'Aboiement', 'Yip': 'Jappement', 'Howl': 'Hurlement',
  'Bow-wow': 'Aboiement', 'Growling': 'Grognement', 'Whimper (dog)': 'Gémissement',
  'Canidae, dogs, wolves': 'Chien', 'Speech': 'Voix', 'Conversation': 'Conversation',
  'Silence': 'Silence', 'Door': 'Porte', 'Knock': 'On frappe', 'Doorbell': 'Sonnette',
  'Ding-dong': 'Sonnette', 'Slam': 'Porte qui claque', 'Television': 'Télé',
  'Music': 'Musique', 'Vehicle': 'Véhicule', 'Car': 'Voiture', 'Siren': 'Sirène',
  'Emergency vehicle': 'Sirène', 'Thump, thud': 'Choc sourd', 'Bang': 'Bruit sec',
  'Bouncing': 'Rebond (balle ?)', 'Walk, footsteps': 'Pas', 'Cat': 'Chat',
  'Meow': 'Miaulement', 'Bird': 'Oiseau', 'Alarm': 'Alarme', 'Telephone': 'Téléphone',
  'Ringtone': 'Sonnerie', 'Crying, sobbing': 'Pleurs', 'Baby cry, infant cry': 'Bébé',
  'Glass': 'Verre', 'Shatter': 'Casse', 'Smoke detector, smoke alarm': 'Détecteur de fumée',
  'Water': 'Eau', 'Vacuum cleaner': 'Aspirateur', 'Hammer': 'Marteau',
  'Drill': 'Perceuse', 'Power tool': 'Outil électrique', 'Child speech, kid speaking': 'Enfant',
  'Shout': 'Cri', 'Yell': 'Cri', 'Animal': 'Animal', 'Domestic animals, pets': 'Animal',
  'Inside, small room': 'Bruit de pièce', 'Squeak': 'Couinement', 'Chewing, mastication': 'Mâchonnement',
  'Scratch': 'Grattement', 'Wood': 'Bois', 'Clatter': 'Fracas', 'Engine': 'Moteur',
};
export const fr = (label) => FR[label] || label;

export const DEFAULTS = {
  threshold: 0.35,       // score YAMNet mini pour compter « chien »
  minDb: -55,            // ignore les aboiements trop faibles (chien du voisin dehors)
  loudDb: -38,           // au-dessus : on note le son dans le journal même si ce n'est pas un chien
  cooldownMin: 5,        // pas plus d'une notification toutes les N minutes
  episodeGapSec: 15,     // silence qui clôt un épisode d'aboiements
  maxClipSec: 90,        // durée max d'un clip
  scheduleMode: 'hours', // 'always' | 'hours'
  days: [1, 2, 3, 4, 5], // 0 = dimanche
  start: '08:00',
  end: '19:00',
  purgeHour: 23,         // tout est effacé chaque soir à cette heure
  ntfyServer: 'https://ntfy.sh',
  turnUrl: '', turnUser: '', turnPass: '',
};

export function randId(n = 16) {
  const a = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => a[b % a.length]).join('');
}

export function iceServers(cfg) {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (cfg.turnUrl) {
    list.push({ urls: cfg.turnUrl.split(',').map((s) => s.trim()), username: cfg.turnUser, credential: cfg.turnPass });
  }
  return list;
}

// Lien d'appairage : tout est dans le fragment (#), jamais envoyé à un serveur.
export function encodePairing(obj) {
  const json = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodePairing(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(b))));
}

export const hhmm = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const hhmmss = (ts) => new Date(ts).toLocaleTimeString('fr-FR');
export function dur(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function summarize(events) {
  const eps = events.filter((e) => e.type === 'bark');
  const barkSec = eps.reduce((t, e) => t + (e.barkSec || 0), 0);
  const longest = eps.reduce((m, e) => Math.max(m, (e.end || e.start) - e.start), 0) / 1000;
  return { episodes: eps.length, barkSec, longest };
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
