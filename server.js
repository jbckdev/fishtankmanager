// Petit serveur local : sert l'interface et relaie les appels vers le HeliaLux SmartControl.
// Le contrôleur n'envoie pas d'en-têtes CORS et supporte mal les requêtes simultanées,
// d'où ce proxy qui sérialise tout.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT || 8080);

// --- Adresse du contrôleur : variable d'environnement HELIALUX, sinon data/config.json (réglable dans l'appli) ---
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
};
let DEVICE = process.env.HELIALUX || readConfig().controllerIp || '';
let BASE = `http://${DEVICE}`;
const validHost = (h) => typeof h === 'string' && /^[a-zA-Z0-9.-]{1,253}(:\d{1,5})?$/.test(h);

// Teste l'adresse (lecture de la liste des profils) puis l'enregistre
async function setController(ip) {
  ip = String(ip || '').trim();
  if (process.env.HELIALUX) throw new Error('Adresse imposée par la variable d\'environnement HELIALUX');
  if (!validHost(ip)) throw new Error('Adresse invalide (exemple : 192.168.1.50)');
  const res = await fetch(`http://${ip}/wpvars.js`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
  if (!res || !res.ok) throw new Error(`Aucun contrôleur HeliaLux ne répond à ${ip}`);
  DEVICE = ip;
  BASE = `http://${ip}`;
  langCache = null; // textes du contrôleur à relire
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), controllerIp: ip }, null, 2));
  return getConfig();
}
const getConfig = () => ({ controllerIp: DEVICE, fromEnv: !!process.env.HELIALUX });

// --- File d'attente : une seule requête vers le contrôleur à la fois ---
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function deviceFetch(p, opts = {}, attempt = 0) {
  if (!DEVICE) throw new Error('Adresse du contrôleur non configurée (Réglages → Contrôleur HeliaLux)');
  try {
    const res = await fetch(BASE + p, { ...opts, signal: AbortSignal.timeout(5000) });
    const buf = Buffer.from(await res.arrayBuffer());
    let text;
    // Certains fichiers sont servis pré-gzippés (avec parfois des octets en trop)
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      text = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    } else {
      text = buf.toString('utf8');
    }
    return { status: res.status, text };
  } catch (e) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 300));
      return deviceFetch(p, opts, attempt + 1);
    }
    throw e;
  }
}

const dev = {
  get: (p) => queued(() => deviceFetch(p)),
  form: (p, body) =>
    queued(() =>
      deviceFetch(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    ),
  multipart: (p, fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    return queued(() => deviceFetch(p, { method: 'POST', body: fd }));
  },
};

// Les fichiers *vars.js du contrôleur ressemblent à : a=1;b='x';c=[1,2];
function parseVars(js) {
  const out = {};
  for (const m of js.matchAll(/(\w+)\s*=\s*([^;]*);/g)) {
    let v = m[2].trim();
    if (/^'.*'$/.test(v)) v = JSON.stringify(v.slice(1, -1));
    try {
      out[m[1]] = JSON.parse(v);
    } catch {
      // Tableaux mêlant nombres et chaînes entre apostrophes : [1,'ptbtime1.ptb.de',1]
      try {
        out[m[1]] = JSON.parse(v.replace(/'([^']*)'/g, (_, s) => JSON.stringify(s)));
      } catch {
        out[m[1]] = v;
      }
    }
  }
  return out;
}

const qs = (o) => new URLSearchParams(o).toString();

// --- API ---
async function overview() {
  const wp = parseVars((await dev.get('/wpvars.js')).text);
  const st = parseVars((await dev.get('/statusvars.js')).text);
  return {
    device: DEVICE,
    lamp: st.lamp,
    profiles: wp.profiles,
    week: wp.profsel,
    active: {
      num: st.profNum,
      name: st.profile,
      times: st.times,
      ch: [st.CH1, st.CH2, st.CH3, st.CH4],
    },
  };
}

async function status() {
  const r = await dev.form('/stat', 'action=10');
  return JSON.parse(r.text);
}

async function selectProfile(n) {
  await dev.multipart('/profedit.html', { profNum: n });
}

async function readProfile(n) {
  await selectProfile(n);
  const v = parseVars((await dev.get('/profeditvars.js')).text);
  if (v.profNum !== n) throw new Error(`Le contrôleur a renvoyé le profil ${v.profNum} au lieu de ${n}`);
  return {
    num: v.profNum,
    name: v.profile,
    lamp: v.lamp,
    times: v.times,
    ch: [v.CH1, v.CH2, v.CH3, v.CH4],
    cI: v.cI,
    cM: v.cM,
  };
}

function validateProfile(p) {
  const n = p.times?.length;
  if (!n || n < 2 || n > 16) throw new Error('Entre 2 et 16 phases');
  if (p.times[0] !== 0 || p.times[n - 1] !== 1439) throw new Error('La journée doit aller de 00:00 à 23:59');
  for (let i = 1; i < n; i++) if (!(p.times[i] >= p.times[i - 1])) throw new Error('Horaires non triés');
  const arrs = [...p.ch, p.cI, p.cM];
  if (p.ch.length !== 4 || arrs.some((a) => a.length !== n)) throw new Error('Tableaux incohérents');
  const ints = (a, max) => a.every((x) => Number.isInteger(x) && x >= 0 && x <= max);
  if (!p.ch.every((a) => ints(a, 100))) throw new Error('Intensités entre 0 et 100');
  if (!ints(p.cI, 3) || !ints(p.cM, 3)) throw new Error('Nuages entre 0 et 3');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 16) throw new Error('Nom : 1 à 16 caractères');
  if (/[&=;'"\[\]]/.test(p.name)) throw new Error('Caractères interdits dans le nom');
}

async function saveProfile(n, p) {
  validateProfile(p);
  await selectProfile(n);
  const body =
    `action=30&PNAME=${p.name}&TIMES=[${p.times}]&CH1=[${p.ch[0]}]&CH2=[${p.ch[1]}]` +
    `&CH3=[${p.ch[2]}]&CH4=[${p.ch[3]}]&CINT=[${p.cI}]&CMOT=[${p.cM}]`;
  // Même encodage que l'interface d'origine (encodeURI)
  await dev.form('/pedit', encodeURI(body));
  return readProfile(n);
}

async function saveWeek(sel) {
  if (!Array.isArray(sel) || sel.length !== 7 || !sel.every((x) => Number.isInteger(x) && x >= 0 && x < 8))
    throw new Error('Semaine invalide');
  const { profiles } = await overview();
  const form = { key: 'BU' };
  sel.forEach((p, i) => (form['s' + i] = `P${p + 1} | ${profiles[p]}`));
  await dev.form('/week.html', qs(form));
  return overview();
}

// Simulation horaire / mode manuel (actions 11-15 de l'interface d'origine)
async function setStat(b) {
  const r = await dev.form(
    '/stat',
    qs({
      action: b.action,
      ch5: b.stime ?? 0,
      tswi: !!b.tswi,
      ttime: b.ttime || '01:00',
      cswi: !!b.cswi,
      ctime: b.ctime || '01:00',
    })
  );
  return JSON.parse(r.text);
}

// action 1 : couleur manuelle (page état) ; 5/20/21 : aperçu dans l'éditeur de profil
async function setColor(b) {
  const f = { action: b.action ?? 1 };
  b.ch.forEach((v, i) => (f['ch' + (i + 1)] = Math.round(v)));
  if (b.cMOT != null) f.cMOT = b.cMOT;
  if (b.cINT != null) f.cINT = b.cINT;
  const r = await dev.form('/color', qs(f));
  try {
    return JSON.parse(r.text);
  } catch {
    return { ok: true };
  }
}

// --- Réglages ---
// Le contrôleur n'a pas d'API : on rejoue le formulaire de setting.html champ par champ.
// Les mots de passe WiFi sont relus depuis setvars.js et ne quittent jamais ce serveur.

// lang.js contient des tableaux ["a","b"] ou des chaînes "a;b".split(";")
function langVar(js, name) {
  const m = js.match(new RegExp(`(?:^|[;\\s])${name}=("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\])(?:\\.split\\(("(?:[^"\\\\]|\\\\.)*")\\))?`));
  if (!m) return null;
  const v = JSON.parse(m[1]);
  return m[2] ? v.split(JSON.parse(m[2])) : v;
}

let langCache = null;
async function langData() {
  if (!langCache) {
    const js = (await dev.get('/lang.js')).text;
    langCache = {
      langs: langVar(js, 'langString'),
      lamps: langVar(js, 'lampString'),
      tz: langVar(js, 'timezoneString'),
      profEdit: langVar(js, 'profEdit'),
      maxProfe: Number(js.match(/MAX_PROFE_STR=(\d+)/)?.[1]),
    };
  }
  return langCache;
}

const readSetvars = async () => parseVars((await dev.get('/setvars.js')).text);

async function settings() {
  const s = await readSetvars();
  const d = parseVars((await dev.get('/devvars.js')).text);
  const L = await langData();
  const info = d.info || [];
  return {
    device: { type: info[0], hw: info[1], fw: info[2], ip: info[3], mac: info[4] },
    lang: L.langs[s.lang],
    lamp: L.lamps[s.lamp],
    time: s.time,
    date: s.date,
    tzone: s.tzone,
    timezones: L.tz,
    ntp: { on: !!s.NTP?.[0], server: s.NTP?.[1], ok: !!s.NTP?.[2] },
    net: {
      mode: s.mode,
      wifi: !!s.wswi,
      ssid: s.wSsid,
      dhcp: !!s.DHCP,
      ip: s.IP?.join('.'),
      mask: s.NM?.join('.'),
      gw: s.GW?.join('.'),
      apSsid: s.apSsid,
      apIp: s.AIP?.join('.'),
    },
  };
}

// Reproduit l'envoi de setting.html (ordre des champs, champs désactivés non envoyés, key=BU)
function settingsForm(s, L, ch, mask = false) {
  const f = [];
  const add = (k, v) => f.push([k, String(v)]);
  const pass = (v) => (mask ? '***' : v);
  const wifi = !!s.wswi;
  const ntpOn = ch.ntp ?? !!s.NTP[0];
  add('key', 'BU');
  add('wLang', L.langs[s.lang]);
  add('wLamp', L.lamps[s.lamp]);
  add('time', ch.time ?? s.time);
  add('date', ch.date ?? s.date);
  add('tzone', L.tz[ch.tzone ?? s.tzone]);
  add('apSsid', s.apSsid);
  add('apPass', pass(s.apPass));
  s.AIP.forEach((v, i) => add('AP' + i, v));
  if (wifi) {
    const names = Array.isArray(s.wNames) ? s.wNames : [];
    add('eWLAN', 'on');
    add('wWlan', s.mode === 'WLAN' && names.includes(s.wSsid) ? s.wSsid : L.profEdit[13 + s.lang * L.maxProfe]);
    add('wSsid', s.wSsid);
    add('wPass', pass(s.wPass));
    if (s.DHCP) add('eDHCP', 'on');
    else for (const [n, a] of [['IP', s.IP], ['NM', s.NM], ['GW', s.GW]]) a.forEach((v, i) => add(n + i, v));
    if (ntpOn) {
      add('eNTP', 'on');
      add('ntpServer', ch.ntpServer ?? s.NTP[1]);
    }
  }
  return new URLSearchParams(f).toString();
}

async function saveSettings(ch, dry) {
  const s = await readSetvars();
  const L = await langData();
  // Garde-fous : on ne touche jamais au réseau, et on refuse si la lecture semble incomplète
  if (typeof s.apPass !== 'string' || s.apPass.length < 8 || (s.wswi && (typeof s.wPass !== 'string' || s.wPass.length < 8)))
    throw new Error('Lecture des réglages réseau incomplète : enregistrement annulé par sécurité');
  if (typeof s.apSsid !== 'string' || s.apSsid.length < 4) throw new Error('SSID du point d\'accès invalide : enregistrement annulé');
  if (s.mode !== 'WLAN' && s.wswi) throw new Error('Contrôleur en mode point d\'accès : utilisez l\'interface d\'origine');
  if (!Array.isArray(s.AIP) || !Array.isArray(s.IP) || !Array.isArray(s.NTP) || !L.tz || !L.langs || !L.lamps)
    throw new Error('Réglages illisibles : enregistrement annulé');
  const c = {};
  if (ch.tzone != null) {
    if (!Number.isInteger(ch.tzone) || !L.tz[ch.tzone]) throw new Error('Fuseau invalide');
    c.tzone = ch.tzone;
  }
  if (ch.ntp != null) c.ntp = !!ch.ntp;
  if (ch.ntpServer != null) {
    if (!/^[a-zA-Z0-9.-]{3,31}$/.test(ch.ntpServer)) throw new Error('Serveur de temps invalide');
    c.ntpServer = ch.ntpServer;
  }
  if (ch.time != null) {
    if (!/^\d\d:\d\d$/.test(ch.time)) throw new Error('Heure invalide');
    c.time = ch.time;
  }
  if (ch.date != null) {
    if (!/^\d{4}-\d\d-\d\d$/.test(ch.date)) throw new Error('Date invalide');
    c.date = ch.date;
  }
  if (dry) return { body: settingsForm(s, L, c, true) };
  await dev.form('/setting.html', settingsForm(s, L, c));
  await new Promise((r) => setTimeout(r, 1500));
  return settings();
}

// --- Mon bac : fiche, population, plantes, décor, carnet d'entretien ---
// Un seul document JSON, partagé par tous les appareils (ordinateur, téléphone)
const DATA_DIR = path.join(__dirname, 'data');
const TANK_FILE = path.join(DATA_DIR, 'aquarium.json');
const uid = () => Math.random().toString(36).slice(2, 10);

// Pré-rempli d'après la photo du bac : à vérifier et corriger dans l'onglet Mon bac
function defaultTank() {
  return {
    version: 1,
    tank: {
      name: 'Mon bac', model: 'Juwel Rio 450 (à vérifier)', volume: 450, length: 151, width: 61, height: 66,
      startDate: '', substrate: 'Sable fin clair', filter: 'Filtre interne Juwel', heater: 'Chauffage 300 W', light: 'HeliaLux Spectrum 4Ch', co2: '', notes: '',
    },
    fish: [
      { id: uid(), species: 'neon', count: 20, livery: '', added: '', notes: '' },
      { id: uid(), species: 'scalaire', count: 1, livery: 'argenté', added: '', notes: '' },
      { id: uid(), species: 'scalaire', count: 1, livery: 'koi', added: '', notes: '' },
      { id: uid(), species: 'scalaire', count: 1, livery: 'marbré', added: '', notes: '' },
      { id: uid(), species: 'apisto-agassizii', count: 1, livery: '', added: '', notes: '' },
      { id: uid(), species: 'cory-sterbai', count: 6, livery: '', added: '', notes: '' },
    ],
    plants: [
      { id: uid(), name: 'Vallisneria gigantea', count: 30, zone: 'arrière', notes: '' },
      { id: uid(), name: 'Anubias barteri', count: 6, zone: 'épiphyte', notes: '' },
      { id: uid(), name: 'Fougère de Java', count: 2, zone: 'épiphyte', notes: '' },
      { id: uid(), name: 'Cryptocoryne wendtii', count: 6, zone: 'avant', notes: '' },
      { id: uid(), name: 'Rotala rotundifolia', count: 2, zone: 'arrière', notes: '' },
    ],
    decor: [
      { id: uid(), type: 'bois', name: 'Racines (3 grandes pièces)', notes: '' },
      { id: uid(), type: 'roche', name: 'Petites pierres plates', notes: '' },
    ],
    log: [],
    reminders: { water: 7, filter: 30, test: 14 },
  };
}

function readTank() {
  try {
    return JSON.parse(fs.readFileSync(TANK_FILE, 'utf8'));
  } catch {
    return defaultTank();
  }
}

function saveTank(doc) {
  const arr = (a) => Array.isArray(a);
  if (!doc || typeof doc !== 'object' || typeof doc.tank !== 'object' || !arr(doc.fish) || !arr(doc.plants) || !arr(doc.decor) || !arr(doc.log))
    throw new Error('Document invalide');
  for (const f of doc.fish) {
    if (typeof f.species !== 'string' || !Number.isInteger(f.count) || f.count < 0 || f.count > 999) throw new Error('Population invalide');
  }
  for (const e of doc.log) {
    if (!/^\d{4}-\d\d-\d\d$/.test(e.date) || typeof e.type !== 'string') throw new Error('Entrée de carnet invalide');
  }
  doc.version = 1;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Écriture atomique : fichier temporaire puis renommage
  const tmp = TANK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, TANK_FILE);
  return doc;
}

// --- HTTP ---
const MAX_BODY = 1024 * 1024;
const readBody = (req) =>
  new Promise((res, rej) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > MAX_BODY) {
        rej(new Error('Requête trop volumineuse'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        res(d ? JSON.parse(d) : {});
      } catch (e) {
        rej(e);
      }
    });
  });

const routes = {
  'GET /api/overview': () => overview(),
  'GET /api/status': () => status(),
  'POST /api/stat': (req, body) => setStat(body),
  'POST /api/color': (req, body) => setColor(body),
  'POST /api/week': (req, body) => saveWeek(body.week),
  'GET /api/settings': () => settings(),
  'POST /api/settings': (req, body, url) => saveSettings(body, url.searchParams.has('dry')),
  'GET /api/tank': () => readTank(),
  'POST /api/tank': (req, body) => saveTank(body),
  // Modèles 3D optimisés disponibles (npm run models) : la 3D garde ses formes générées pour les autres
  'GET /api/config': () => getConfig(),
  'POST /api/config': (req, body) => setController(body.controllerIp),
  'GET /api/models': () =>
    fs.existsSync(MODELS_DIR) ? fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)) : [],
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODELS_DIR = path.join(PUBLIC_DIR, 'models', 'opt');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const pm = url.pathname.match(/^\/api\/profile\/([0-7])$/);
      if (pm) {
        const n = Number(pm[1]);
        return send(200, req.method === 'POST' ? await saveProfile(n, body) : await readProfile(n));
      }
      const h = routes[`${req.method} ${url.pathname}`];
      if (!h) return send(404, { error: 'Route inconnue' });
      return send(200, await h(req, body, url));
    }
    // Fichiers statiques de public/ (sous-dossiers compris), sans pouvoir en sortir
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const fp = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!fp.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webmanifest': 'application/manifest+json',
      '.glb': 'model/gltf-binary',
    };
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message;
    console.error(req.method, url.pathname, e.message, cause || '');
    send(502, { error: (e.message || String(e)) + (cause ? ` (${cause})` : '') });
  }
});

server.listen(PORT, () => {
  console.log(`FishTankManager → http://localhost:${PORT}  (contrôleur : ${DEVICE || 'à configurer dans Réglages'})`);
});
