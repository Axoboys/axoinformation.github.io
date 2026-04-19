// ============================================================
// AxoClicker — Service Worker (background farming)
// Tourne en arrière-plan même quand la page est fermée.
// Calcule les cookies gagnés depuis la dernière sauvegarde
// et met à jour Firebase directement.
// ============================================================

const SW_VERSION = '1.0.0';
const FIREBASE_BASE = 'https://firestore.googleapis.com/v1/projects/axoclicker-24a88/databases/(default)/documents';
const API_KEY       = 'AIzaSyAODYOz_M_CAr4ReMZzhMi71qU_DASgBls';

// Intervalle de calcul en background (toutes les 60s)
const BG_INTERVAL_MS = 60 * 1000;
// Max 2h de gain offline (même règle que le système offline)
const MAX_OFFLINE_MS = 2 * 60 * 60 * 1000;

// ── Firestore REST helpers ────────────────────────────────────
async function fsGet(collection, docId) {
  try {
    const url = `${FIREBASE_BASE}/${collection}/${docId}?key=${API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    return firestoreToObj(data.fields || {});
  } catch(e) { return null; }
}

async function fsSet(collection, docId, obj) {
  try {
    const url = `${FIREBASE_BASE}/${collection}/${docId}?key=${API_KEY}`;
    const body = JSON.stringify({ fields: objToFirestore(obj) });
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return r.ok;
  } catch(e) { return false; }
}

// Convert Firestore field format → plain JS object
function firestoreToObj(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = firestoreValue(v);
  }
  return out;
}

function firestoreValue(v) {
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue  !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue    !== undefined) return null;
  if (v.mapValue     !== undefined) return firestoreToObj(v.mapValue.fields || {});
  if (v.arrayValue   !== undefined) return (v.arrayValue.values || []).map(firestoreValue);
  return null;
}

// Convert plain JS object → Firestore field format
function objToFirestore(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')        return { booleanValue: v };
  if (typeof v === 'string')         return { stringValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: objToFirestore(v) } };
  return { stringValue: String(v) };
}

// ── CPS calculation (mirrors clicker.html logic) ─────────────
function computeCpsFromSave(save) {
  const buildings = save.buildings || {};
  const upgrades  = save.upgrades  || {};
  const rebirths  = save.rebirths  || 0;

  // Building base CPS (must match BUILDINGS in clicker.html)
  const BUILDING_CPS = {
    cursor:15, grandma:2, farm:5, mine:8, factory:25, bank:80,
    temple:300, wizard:1200, ship:5000, lab:20000, portal:80000,
    dragon:300000, heaven:1e6, antimatter:4e6, prism:1.5e7,
    chancemaker:6e7, fractal:2.5e8, javascript:1e9, idleverse:4e9, cortex:1.5e10
  };

  // Building multipliers from upgrades (effect:'building')
  const bldMult = {};
  for (const bid of Object.keys(BUILDING_CPS)) bldMult[bid] = 1;

  // Upgrade effects (must match UPGRADES in clicker.html)
  let clickMult = 1, globalMult = 1;
  const UPGRADE_EFFECTS = {
    // global
    glob1:{effect:'global',mult:1.5}, glob2:{effect:'global',mult:1.5},
    glob3:{effect:'global',mult:2},   glob4:{effect:'global',mult:2},
    axo1:{effect:'global',mult:1.3},  axo2:{effect:'global',mult:1.3},
    axo3:{effect:'global',mult:1.5},
    // buildings
    cur1:{effect:'building',bid:'cursor',mult:2},   cur2:{effect:'building',bid:'cursor',mult:2},
    gma1:{effect:'building',bid:'grandma',mult:2},  gma2:{effect:'building',bid:'grandma',mult:2}, gma3:{effect:'building',bid:'grandma',mult:2},
    frm1:{effect:'building',bid:'farm',mult:2},     frm2:{effect:'building',bid:'farm',mult:2},
    min1:{effect:'building',bid:'mine',mult:2},     min2:{effect:'building',bid:'mine',mult:2},
    fct1:{effect:'building',bid:'factory',mult:2},  fct2:{effect:'building',bid:'factory',mult:2},
    bnk1:{effect:'building',bid:'bank',mult:2},     bnk2:{effect:'building',bid:'bank',mult:2},
    tmp1:{effect:'building',bid:'temple',mult:2},   tmp2:{effect:'building',bid:'temple',mult:2},
    wzd1:{effect:'building',bid:'wizard',mult:2},   wzd2:{effect:'building',bid:'wizard',mult:2},
    shp1:{effect:'building',bid:'ship',mult:2},     shp2:{effect:'building',bid:'ship',mult:2},
    lab1:{effect:'building',bid:'lab',mult:2},      lab2:{effect:'building',bid:'lab',mult:2},
    prt1:{effect:'building',bid:'portal',mult:2},   prt2:{effect:'building',bid:'portal',mult:2},
    drg1:{effect:'building',bid:'dragon',mult:2},   drg2:{effect:'building',bid:'dragon',mult:2},
    hvn1:{effect:'building',bid:'heaven',mult:2},   hvn2:{effect:'building',bid:'heaven',mult:2},
    atm1:{effect:'building',bid:'antimatter',mult:2},atm2:{effect:'building',bid:'antimatter',mult:2},
    prm1:{effect:'building',bid:'prism',mult:2},    prm2:{effect:'building',bid:'prism',mult:2},
    clk1:{effect:'building',bid:'chancemaker',mult:2},clk2:{effect:'building',bid:'chancemaker',mult:2},
    frc1:{effect:'building',bid:'fractal',mult:2},  frc2:{effect:'building',bid:'fractal',mult:2},
    js1:{effect:'building',bid:'javascript',mult:2},js2:{effect:'building',bid:'javascript',mult:2},
    idl1:{effect:'building',bid:'idleverse',mult:2},idl2:{effect:'building',bid:'idleverse',mult:2},
    ctx1:{effect:'building',bid:'cortex',mult:2},   ctx2:{effect:'building',bid:'cortex',mult:2},
  };

  for (const [id, u] of Object.entries(UPGRADE_EFFECTS)) {
    if (!upgrades[id]) continue;
    if (u.effect === 'global')   globalMult     *= u.mult;
    if (u.effect === 'building') bldMult[u.bid]  = (bldMult[u.bid]||1) * u.mult;
  }

  // Rebirth shop bonuses
  const rebirthShop = save.rebirthShop || {};
  let rebirthGlobalBonus = 1;
  const REBIRTH_GLOBAL = { rb_boost1:1.2, rb_boost2:1.4, rb_boost3:1.6 };
  for (const [id, val] of Object.entries(REBIRTH_GLOBAL)) {
    if (rebirthShop[id]) rebirthGlobalBonus *= val;
  }

  // Golden shop CPS boost
  const goldenShop = save.goldenShop || {};
  let gcCpsBoost = 1;
  const GC_CPS = { gs_cps1:1.25, gs_cps2:1.50, gs_cps3:2.00 };
  for (const [id, val] of Object.entries(GC_CPS)) {
    if (goldenShop[id]) gcCpsBoost *= val;
  }

  // Compute raw CPS
  let cps = 0;
  for (const [bid, baseCps] of Object.entries(BUILDING_CPS)) {
    cps += (buildings[bid] || 0) * baseCps * (bldMult[bid] || 1);
  }

  const rebirthBonus = 1 + rebirths * 0.2;
  return cps * globalMult * rebirthBonus * rebirthGlobalBonus * gcCpsBoost;
}

// ── Background farming tick ───────────────────────────────────
async function farmTick(userKey) {
  if (!userKey) return;

  const save = await fsGet('saves', userKey);
  if (!save || !save.lastSave) return;

  const now     = Date.now();
  const elapsed = now - save.lastSave;

  // Moins de 30s → pas la peine
  if (elapsed < 30000) return;

  const cps = computeCpsFromSave(save);
  if (cps <= 0) return;

  // Plafond 2h
  const effectiveSec = Math.min(elapsed, MAX_OFFLINE_MS) / 1000;
  const earned = Math.floor(cps * effectiveSec);
  if (earned <= 0) return;

  const updated = {
    ...save,
    cookies:      (save.cookies      || 0) + earned,
    totalCookies: (save.totalCookies || 0) + earned,
    cookiesThisLife: (save.cookiesThisLife || 0) + earned,
    lastSave:     now,
    cps:          Math.round(cps * 100) / 100,
    // Flag pour que la page sache qu'il y a eu du farming background
    bgEarned:     earned,
    bgEarnedAt:   now,
  };

  await fsSet('saves', userKey, updated);
  console.log(`[SW] Farmed ${earned} cookies for ${userKey} (${(effectiveSec/60).toFixed(1)} min, ${Math.round(cps)}/s)`);
}

// ── Service Worker lifecycle ──────────────────────────────────
self.addEventListener('install', () => {
  console.log('[SW] Installed v' + SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[SW] Activated');
  e.waitUntil(self.clients.claim());
});

// ── Messages from the page ────────────────────────────────────
// The page sends { type: 'START_FARMING', userKey } when player logs in
// and { type: 'STOP_FARMING' } on logout
let farmingUserKey = null;
let farmInterval   = null;

self.addEventListener('message', (e) => {
  const { type, userKey } = e.data || {};

  if (type === 'START_FARMING') {
    farmingUserKey = userKey;
    // Clear any existing interval
    if (farmInterval) clearInterval(farmInterval);
    // Run immediately then every 60s
    farmTick(farmingUserKey);
    farmInterval = setInterval(() => farmTick(farmingUserKey), BG_INTERVAL_MS);
    console.log('[SW] Started farming for', userKey);
  }

  if (type === 'STOP_FARMING') {
    if (farmInterval) clearInterval(farmInterval);
    farmInterval   = null;
    farmingUserKey = null;
    console.log('[SW] Stopped farming');
  }
});

// ── Keep-alive via periodic sync (if browser supports it) ─────
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'axo-farm' && farmingUserKey) {
    e.waitUntil(farmTick(farmingUserKey));
  }
});
