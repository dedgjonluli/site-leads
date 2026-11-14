'use strict';
/* Site Leads — standalone app. Data lives in Supabase (one private table per user, locked by login). */
const SB_URL = 'https://pycozqnumrkhzynhovse.supabase.co';
const SB_KEY = 'sb_publishable_QlcYUxNzPfBJKztAxoqWiQ_S-gdyuVB'; // publishable key: meant to be in the app
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const PHASES = ['Excavation','Foundation','Framing','Rough-in (ready)','Insulation','Drywall','Finished'];
const PHASE_COLOR = {'Excavation':'#8d6e63','Foundation':'#78909c','Framing':'#ef8f00','Rough-in (ready)':'#1e8a4c','Insulation':'#2f6db5','Drywall':'#7e57c2','Finished':'#37474f','':'#b0b7c0'};
const STATUSES = [['new','New'],['active','Active'],['won','Won'],['dead','Dead']];
const AREAS = ['Long Island','Rockland','Upstate','Unsorted'];
const LIST_COLS = 'id,address,town,area,status,phase,hot,builder,notes,follow_up,source,lat,lng,geo_src,created_at,updated_at';

const sb = supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

let user = null;
const leads = new Map();
const photos = new Map();
const ui = {
  tab: 'leads', area: 'Long Island', q: '', phase: '', selecting: false, sel: new Set(),
  openTowns: new Set(), hl: null, routeMap: false, nearOpen: true, signup: false, openLead: null
};
let route = { ids: [], done: [], drive: -1 };
let myPos = null; // [lat, lng]
try { const a = JSON.parse(localStorage.getItem('sl.area') || 'null'); if (AREAS.includes(a)) ui.area = a; } catch (e) {}
try { const r = JSON.parse(localStorage.getItem('sl.route') || 'null'); if (r && Array.isArray(r.ids)) route = r; } catch (e) {}
try { const t = JSON.parse(localStorage.getItem('sl.towns') || '[]'); t.forEach(x => ui.openTowns.add(x)); } catch (e) {}

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function hav(a, b) { const R = 3958.8, r = x => x * Math.PI / 180; const dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
function fmtMi(d) { return d < 0.1 ? 'here' : d < 10 ? d.toFixed(1) + ' mi' : Math.round(d) + ' mi'; }
function fmtTime(t) { const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function titleCase(s) { return s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()); }
function normTown(s) {
  if (!s) return '';
  let t = String(s).replace(/\b(ny|n\.y\.|new york)\b\.?/ig, '').replace(/\b\d{5}(-\d{4})?\b/g, '').replace(/,+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const low = t.toLowerCase();
  if (TOWN_ALIAS[low]) return TOWN_ALIAS[low];
  return Object.keys(TOWNS).find(k => k.toLowerCase() === low) || titleCase(t);
}
function areaFor(town) { if (!town) return 'Unsorted'; if (ROCKLAND.has(town)) return 'Rockland'; if (UPSTATE.has(town)) return 'Upstate'; if (TOWNS[town]) return 'Long Island'; return 'Unsorted'; }
const WORDS = { street: 'st', road: 'rd', avenue: 'ave', av: 'ave', lane: 'ln', drive: 'dr', court: 'ct', place: 'pl', boulevard: 'blvd', terrace: 'ter', highway: 'hwy', parkway: 'pkwy', circle: 'cir', east: 'e', west: 'w', north: 'n', south: 's', turnpike: 'tpke', crescent: 'cres' };
function normAddr(a) { return String(a || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map(w => WORDS[w] || w).join(' '); }
function leadId(addr, town) { const s = (normAddr(addr) + ' ' + String(town || '').toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); return (s || 'lead-' + Date.now()).slice(0, 180); }
function hasNumber(a) { return /^\s*\d/.test(a || ''); }
function builderOf(l) { return l.builder || {}; }
function pinOf(l) {
  if (l.lat != null && l.lng != null) return { ll: [l.lat, l.lng], exact: l.geo_src === 'address' || l.geo_src === 'gps' };
  const c = TOWNS[l.town]; if (!c) return null;
  let h = 0; for (const ch of l.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const j = ((h & 1023) / 1023 - 0.5) * 0.012, k = (((h >> 10) & 1023) / 1023 - 0.5) * 0.012;
  return { ll: [c[0] + j, c[1] + k], exact: false };
}
function navTarget(l) {
  if (l.geo_src === 'gps' || (!hasNumber(l.address) && l.lat != null)) return l.lat + ',' + l.lng;
  return l.address + ', ' + l.town + ', NY';
}
function gmaps(l) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(navTarget(l)); }
function amaps(l) { return 'https://maps.apple.com/?daddr=' + encodeURIComponent(navTarget(l)); }
function sortTown(a, b) { return (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (a.address || '').localeCompare(b.address || '', undefined, { numeric: true }); }
function orderTowns(towns) {
  const placed = towns.filter(t => TOWNS[t]), rest0 = towns.filter(t => !TOWNS[t]).sort();
  let rest = placed.slice().sort((x, y) => TOWNS[x][1] - TOWNS[y][1]); const out = [];
  let cur = rest.length ? TOWNS[rest[0]] : null;
  while (rest.length) { let bi = 0, bd = Infinity; rest.forEach((t, i) => { const d = hav(cur, TOWNS[t]); if (d < bd) { bd = d; bi = i; } }); const t = rest.splice(bi, 1)[0]; out.push(t); cur = TOWNS[t]; }
  return out.concat(rest0);
}
function groupByTown(list) {
  const by = {}; for (const l of list) (by[l.town || 'No town'] = by[l.town || 'No town'] || []).push(l);
  return orderTowns(Object.keys(by)).map(t => ({ town: t, items: by[t].sort(sortTown) }));
}
function shrinkPhoto(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader(); fr.onerror = () => rej(new Error('read'));
    fr.onload = () => { const img = new Image(); img.onerror = () => rej(new Error('decode')); img.onload = () => { const max = 900; const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); let q = .75, u = c.toDataURL('image/jpeg', q); while (u.length > 240000 && q > .35) { q -= .1; u = c.toDataURL('image/jpeg', q); } res(u); }; img.src = fr.result; };
    fr.readAsDataURL(file);
  });
}

/* ---------- data ---------- */
function cacheLeads() { save('sl.cache.' + (user && user.id), [...leads.values()]); }
async function loadLeads() {
  try { const c = JSON.parse(localStorage.getItem('sl.cache.' + user.id) || '[]'); c.forEach(l => leads.set(l.id, l)); if (c.length) renderAll(); } catch (e) {}
  const { data, error } = await sb.from('leads').select(LIST_COLS).order('address');
  if (error) { toast(navigator.onLine ? 'Could not load leads: ' + error.message : 'Offline — showing saved copy'); return; }
  leads.clear(); data.forEach(l => leads.set(l.id, l)); cacheLeads(); renderAll();
}
async function upd(id, patch, quiet) {
  const l = leads.get(id); if (!l) return;
  const before = Object.assign({}, l);
  Object.assign(l, patch); cacheLeads(); renderAll(); if (ui.openLead === id) renderLead(id);
  const { error } = await sb.from('leads').update(patch).eq('id', id);
  if (error) { leads.set(id, before); cacheLeads(); renderAll(); if (ui.openLead === id) renderLead(id); toast('Not saved: ' + error.message); return false; }
  if (!quiet) toast('Saved');
  return true;
}
async function addNote(id, text) {
  const l = leads.get(id); if (!l || !text.trim()) return;
  const notes = (l.notes || []).concat([{ t: Date.now(), text: text.trim() }]);
  await upd(id, { notes }, true);
}

/* ---------- geocoding (OpenStreetMap Nominatim, 1 request per second) ---------- */
let geoBusy = false;
const EXPAND = { st: 'Street', rd: 'Road', ave: 'Avenue', av: 'Avenue', ln: 'Lane', dr: 'Drive', ct: 'Court', pl: 'Place', blvd: 'Boulevard', ter: 'Terrace', hwy: 'Highway', pkwy: 'Parkway', cir: 'Circle', rdg: 'Ridge', tpke: 'Turnpike', cres: 'Crescent', e: 'East', w: 'West', n: 'North', s: 'South', pt: 'Port' };
function expandAddr(a) { return String(a).split(/\s+/).map(w => EXPAND[w.toLowerCase().replace(/\.$/, '')] || w).join(' '); }
async function nomi(q) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('geocoder ' + r.status);
  const j = await r.json(); return j[0] || null;
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function geocodeOne(l) {
  const num = hasNumber(l.address);
  const street = l.address.replace(/^\s*[\d-]+[a-z]?\s+/i, '');
  const tries = [l.address + ', ' + l.town + ', NY'];
  if (expandAddr(l.address) !== l.address) tries.push(expandAddr(l.address) + ', ' + l.town + ', NY');
  if (num) tries.push(expandAddr(street) + ', ' + l.town + ', NY');
  for (let i = 0; i < tries.length; i++) {
    if (i) await pause(1100);
    const hit = await nomi(tries[i]);
    if (!hit) continue;
    if (TOWNS[l.town] && hav(TOWNS[l.town], [+hit.lat, +hit.lon]) > 15) continue; // wrong town with the same street name
    const isStreetTry = num && tries[i].startsWith(expandAddr(street));
    const exact = num && !isStreetTry && (hit.addresstype === 'building' || hit.addresstype === 'place' || hit.type === 'house' || hit.category === 'building' || /^\d/.test(hit.display_name));
    return { lat: +hit.lat, lng: +hit.lon, geo_src: exact ? 'address' : 'street' };
  }
  return { geo_src: 'none' };
}
async function geocodeAll(force) {
  if (geoBusy) return toast('Already locating pins…');
  const todo = [...leads.values()].filter(l => force ? l.geo_src !== 'gps' : (!l.geo_src || l.geo_src === 'none'));
  if (!todo.length) return toast('Every lead already has a pin');
  geoBusy = true; let n = 0;
  toast('Locating ' + todo.length + ' pins… keep the app open (about ' + Math.ceil(todo.length * 1.2 / 60) + ' min)');
  for (const l of todo) {
    try { const p = await geocodeOne(l); await upd(l.id, p, true); n++; } catch (e) { console.warn(e); }
    await new Promise(r => setTimeout(r, 1150));
  }
  geoBusy = false; toast('Done: ' + n + ' pins located'); if (map) drawMarkers();
}

/* ---------- auth ---------- */
async function boot() {
  const { data } = await sb.auth.getSession();
  setUser(data.session ? data.session.user : null);
  sb.auth.onAuthStateChange((_e, s) => { const u = s ? s.user : null; if ((u && u.id) !== (user && user.id)) setUser(u); });
}
function setUser(u) {
  user = u; leads.clear();
  $('#auth').hidden = !!u; $('#app').hidden = !u;
  if (u) { loadLeads(); renderAll(); startLocation(); }
}
$('#auth-switch').onclick = () => {
  ui.signup = !ui.signup;
  $('#auth-go').textContent = ui.signup ? 'Create account' : 'Sign in';
  $('#auth-switch').textContent = ui.signup ? 'Already have an account? Sign in' : 'First time? Create your account';
  $('#auth-msg').textContent = ui.signup ? 'Pick the email and password you\'ll use to sign in. Password: 8 characters or more.' : 'Sign in to see your leads.';
  $('#auth-pass').autocomplete = ui.signup ? 'new-password' : 'current-password';
};
$('#auth-form').onsubmit = async e => {
  e.preventDefault();
  const email = $('#auth-email').value.trim(), password = $('#auth-pass').value;
  $('#auth-go').disabled = true;
  try {
    if (ui.signup) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
      if (error) throw error;
      if (!data.session) { $('#auth-msg').textContent = 'Almost done: open the email from Supabase and tap the confirm link. Then come back here and sign in.'; $('#auth-switch').click(); $('#auth-msg').textContent = 'Check your email for the confirm link, then sign in here.'; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) { $('#auth-msg').textContent = err.message || String(err); }
  finally { $('#auth-go').disabled = false; }
};

/* ---------- location ---------- */
let watchId = null;
function startLocation() {
  if (!('geolocation' in navigator) || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(p => { myPos = [p.coords.latitude, p.coords.longitude]; if (ui.tab === 'map') renderNear(); }, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}
function getPosOnce() {
  return new Promise(res => {
    if (!('geolocation' in navigator)) return res(myPos);
    navigator.geolocation.getCurrentPosition(p => { myPos = [p.coords.latitude, p.coords.longitude]; res(myPos); }, () => res(myPos), { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
  });
}

/* ---------- rendering: leads list ---------- */
function matches(l, q) {
  const b = builderOf(l);
  return [l.address, l.town, b.name, b.company, b.phone, l.phase].join(' ').toLowerCase().includes(q);
}
function rowHtml(l, extra) {
  const b = builderOf(l);
  const sub = [l.phase || (l.status === 'new' ? 'Never scouted' : ''), b.name || b.company].filter(Boolean).join(' · ');
  return '<li class="row">' +
    (ui.selecting ? '<input type="checkbox" data-sel="' + esc(l.id) + '"' + (ui.sel.has(l.id) ? ' checked' : '') + ' aria-label="Select">' : '') +
    '<button class="main" data-open="' + esc(l.id) + '"><span class="addr"><span class="ph" style="background:' + (PHASE_COLOR[l.phase || ''] || '#b0b7c0') + '"></span>' + esc(l.address) + '</span>' +
    '<span class="sub">' + esc(sub || ' ') + '</span></button>' +
    (extra || '') +
    '<button class="star' + (l.hot ? ' on' : '') + '" data-hot="' + esc(l.id) + '" aria-label="Hot">★</button></li>';
}
function renderLeads() {
  const el = $('#view-leads'); const all = [...leads.values()];
  const q = ui.q.trim().toLowerCase();
  if (q) {
    const hits = all.filter(l => matches(l, q)).sort(sortTown);
    el.innerHTML = '<div class="block"><div class="block-h">Search <span class="count">' + hits.length + '</span></div>' +
      (hits.length ? '<ul class="rows">' + hits.map(l => rowHtml(l, '<span class="dist">' + esc(l.town) + '</span>')).join('') + '</ul>' : '<p class="empty">No leads match.</p>') + '</div>';
    return;
  }
  const due = all.filter(l => l.follow_up);
  const dueIds = new Set(due.map(l => l.id));
  let h = '<div class="block"><div class="block-h">Follow-ups due' + (due.length ? ' <span class="count">' + due.length + '</span>' : '') + '</div>';
  if (!due.length) h += '<p class="empty">Nothing here yet. This fills in once your Salesforce follow-ups are imported.</p>';
  else h += groupByTown(due).map(g => '<div class="block-h" style="font-size:14px;padding-bottom:4px">' + esc(g.town) + ' <span class="count">' + g.items.length + '</span></div><ul class="rows">' + g.items.map(l => rowHtml(l)).join('') + '</ul>').join('');
  h += '</div>';

  const counts = {}; all.forEach(l => { if (!dueIds.has(l.id)) counts[l.area || 'Unsorted'] = (counts[l.area || 'Unsorted'] || 0) + 1; });
  if (!counts[ui.area] && leads.size) { const f = AREAS.find(a => counts[a]); if (f) ui.area = f; }
  const areas = AREAS.filter(a => counts[a] || a === ui.area);
  h += '<div class="areas">' + areas.map(a => '<button class="chip' + (a === ui.area ? ' on' : '') + '" data-area="' + esc(a) + '">' + esc(a) + '<small>' + (counts[a] || 0) + '</small></button>').join('') + '</div>';
  const inArea = all.filter(l => (l.area || 'Unsorted') === ui.area && !dueIds.has(l.id));
  const phCounts = {}; inArea.forEach(l => { phCounts[l.phase || ''] = (phCounts[l.phase || ''] || 0) + 1; });
  h += '<div class="chips"><button class="chip' + (!ui.phase ? ' on' : '') + '" data-phase="">All</button>' +
    PHASES.concat(['']).filter(p => phCounts[p]).map(p => '<button class="chip' + (ui.phase === (p || '-') ? ' on' : '') + '" data-phase="' + esc(p || '-') + '"><span class="ph" style="background:' + PHASE_COLOR[p] + '"></span>' + esc(p || 'Never scouted') + '<small>' + phCounts[p] + '</small></button>').join('') + '</div>';
  const shown = inArea.filter(l => !ui.phase || (ui.phase === '-' ? !l.phase : l.phase === ui.phase));
  const groups = groupByTown(shown);
  h += '<div class="block">';
  if (!groups.length) h += '<p class="empty" style="padding-top:14px">' + (leads.size ? 'No leads here.' : 'Loading your leads…') + '</p>';
  h += groups.map(g => {
    const key = ui.area + '|' + g.town; const open = ui.openTowns.has(key) || !!ui.phase;
    return '<details class="folder" data-town="' + esc(key) + '"' + (open ? ' open' : '') + '><summary><span>' + esc(g.town) + '</span><span><span class="count">' + g.items.length + '</span> <span class="chev">›</span></span></summary><ul class="rows">' + g.items.map(l => rowHtml(l)).join('') + '</ul></details>';
  }).join('');
  h += '</div>';
  el.innerHTML = h;
}

/* ---------- lead page ---------- */
function openLead(id) { ui.openLead = id; $('#sheet').hidden = false; renderLead(id); loadPhoto(id); }
function closeSheet() { ui.openLead = null; $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; }
async function loadPhoto(id) {
  if (photos.has(id)) return;
  const { data } = await sb.from('leads').select('photo').eq('id', id).maybeSingle();
  photos.set(id, data && data.photo || null);
  if (ui.openLead === id) renderLead(id);
}
function renderLead(id) {
  const l = leads.get(id); if (!l) return closeSheet();
  const b = builderOf(l); const p = pinOf(l); const ph = photos.get(id);
  const pinTxt = l.geo_src === 'gps' ? 'Pin set from your location on site.' : l.geo_src === 'address' ? 'Pin at the street address.' : l.geo_src === 'street' ? 'Pin on the street (no exact house found).' : l.geo_src === 'none' ? 'Address not found on the map. Pin is at the town center.' : 'Pin not located yet. Shown at the town center.';
  const notes = (l.notes || []).slice().sort((a, b) => b.t - a.t);
  $('#sheet-body').innerHTML =
    '<div class="sheet-top"><h2>' + esc(l.address) + '<span class="sub">' + esc(l.town) + (l.area ? ' · ' + esc(l.area) : '') + '</span></h2>' +
    '<button class="star' + (l.hot ? ' on' : '') + '" data-hot="' + esc(id) + '" style="font-size:24px" aria-label="Hot">★</button>' +
    '<button class="icon" data-act="close" aria-label="Close">✕</button></div>' +
    '<div class="actions"><a class="btn primary" href="' + esc(gmaps(l)) + '" target="_blank" rel="noopener">Navigate</a>' +
    '<a class="btn" href="' + esc(amaps(l)) + '" target="_blank" rel="noopener">Apple Maps</a>' +
    '<button class="btn" data-act="seemap" data-id="' + esc(id) + '">See on map</button>' +
    (b.phone ? '<a class="btn" href="tel:' + esc(b.phone.replace(/[^\d+]/g, '')) + '">Call builder</a>' : '') + '</div>' +
    '<div class="card"><h3>Phase</h3><div class="seg">' + PHASES.map(x => '<button data-setphase="' + esc(x) + '" class="' + (l.phase === x ? 'on' : '') + '">' + esc(x) + '</button>').join('') + '<button data-setphase="" class="' + (!l.phase ? 'on' : '') + '">Not set</button></div>' +
    '<h3 style="margin-top:14px">Status</h3><div class="seg">' + STATUSES.map(([k, v]) => '<button data-setstatus="' + k + '" class="' + (l.status === k ? 'on' : '') + '">' + v + '</button>').join('') + '</div></div>' +
    '<div class="card"><h3>Builder</h3>' +
    '<label class="field"><span>Name</span><input id="b-name" value="' + esc(b.name || '') + '"></label>' +
    '<label class="field"><span>Company</span><input id="b-company" value="' + esc(b.company || '') + '"></label>' +
    '<label class="field"><span>Phone (builder\'s own)</span><input id="b-phone" type="tel" value="' + esc(b.phone || '') + '"></label>' +
    '<label class="field"><span>Builder notes</span><textarea id="b-notes">' + esc(b.notes || '') + '</textarea></label>' +
    '<button class="btn primary" data-act="savebuilder" data-id="' + esc(id) + '">Save builder</button></div>' +
    '<div class="card"><h3>Notes</h3><label class="field"><textarea id="n-text" placeholder="Add a note…"></textarea></label><button class="btn primary" data-act="addnote" data-id="' + esc(id) + '">Add note</button>' +
    '<div style="margin-top:10px">' + (notes.length ? notes.map(n => '<div class="note"><time>' + esc(fmtTime(n.t)) + (n.sys ? ' · imported' : '') + '</time>' + esc(n.text) + '</div>').join('') : '<p class="muted">No notes yet.</p>') + '</div></div>' +
    '<div class="card"><h3>Photo</h3>' + (ph ? '<img class="photo" src="' + esc(ph) + '" alt="Site photo">' : (photos.has(id) ? '' : '<p class="muted">Loading…</p>')) +
    '<label class="btn">' + (ph ? 'Replace photo' : 'Add photo') + '<input type="file" accept="image/*" id="f-photo" data-id="' + esc(id) + '" hidden></label> ' +
    (ph ? '<button class="btn danger" data-act="delphoto" data-id="' + esc(id) + '">Remove</button>' : '') + '</div>' +
    '<div class="card"><h3>Map pin</h3><p class="pinline">' + esc(pinTxt) + '</p><div class="seg"><button data-act="pinhere" data-id="' + esc(id) + '">I\'m at this site: pin here</button><button data-act="pinfind" data-id="' + esc(id) + '">Look up address</button></div></div>' +
    '<div class="card"><h3>Lead</h3><label class="field"><span>Address</span><input id="l-address" value="' + esc(l.address) + '"></label>' +
    '<label class="field"><span>Town</span><input id="l-town" list="townlist" value="' + esc(l.town) + '"></label>' +
    '<button class="btn" data-act="saveaddr" data-id="' + esc(id) + '">Save address</button> <button class="btn danger" data-act="dellead" data-id="' + esc(id) + '">Delete lead</button>' +
    '<p class="muted" style="font-size:13px;margin:10px 0 0">Source: ' + esc(l.source || '—') + '</p></div>';
}

/* ---------- add lead ---------- */
function openAdd() {
  ui.openLead = null; $('#sheet').hidden = false;
  $('#sheet-body').innerHTML = '<div class="sheet-top"><h2>New lead</h2><button class="icon" data-act="close" aria-label="Close">✕</button></div>' +
    '<div class="card"><label class="field"><span>Address</span><input id="a-address" placeholder="58 S Dennis Ln" autocomplete="off"></label>' +
    '<label class="field"><span>Town</span><input id="a-town" list="townlist" placeholder="Coram" autocomplete="off"></label>' +
    '<h3 style="margin-top:12px">Phase</h3><div class="seg" id="a-phase">' + PHASES.map(x => '<button data-aphase="' + esc(x) + '">' + esc(x) + '</button>').join('') + '<button data-aphase="" class="on">Not set</button></div>' +
    '<label class="field" style="margin-top:12px"><span>Note (optional)</span><textarea id="a-note"></textarea></label>' +
    '<label style="display:flex;gap:8px;align-items:center;margin:6px 0 12px"><input type="checkbox" id="a-here"> I\'m standing at this site (pin it here)</label>' +
    '<button class="btn primary big" data-act="addsave" style="width:100%">Save lead</button></div>';
  setTimeout(() => $('#a-address').focus(), 50);
}
async function saveNew() {
  const address = $('#a-address').value.trim().replace(/\s+/g, ' '); const town = normTown($('#a-town').value);
  if (!address) return toast('Type the address');
  if (!town) return toast('Type the town');
  const id = leadId(address, town);
  if (leads.has(id)) { toast('Already in your leads'); return openLead(id); }
  const phEl = document.querySelector('#a-phase .on'); const phase = phEl ? phEl.dataset.aphase : '';
  const note = $('#a-note').value.trim();
  const row = { id, address, town, area: areaFor(town), phase, status: phase ? 'active' : 'new', notes: note ? [{ t: Date.now(), text: note }] : [], builder: { name: '', company: '', phone: '', notes: '' }, source: 'Added in app ' + new Date().toLocaleDateString() };
  if ($('#a-here').checked) { const p = await getPosOnce(); if (p) { row.lat = p[0]; row.lng = p[1]; row.geo_src = 'gps'; } }
  const { data, error } = await sb.from('leads').insert(row).select(LIST_COLS).single();
  if (error) return toast('Not saved: ' + error.message);
  leads.set(id, data); cacheLeads(); ui.area = data.area; ui.openTowns.add(data.area + '|' + data.town); renderAll(); openLead(id);
  if (!data.geo_src) { try { const p = await geocodeOne(data); await upd(id, p, true); if (map) drawMarkers(); } catch (e) {} }
}

/* ---------- map ---------- */
let map = null, markers = new Map(), popup = null, geoCtl = null;
function initMap() {
  if (map) { map.resize(); return; }
  const c = TOWNS[ui.area === 'Rockland' ? 'Spring Valley' : ui.area === 'Upstate' ? 'Poughkeepsie' : 'Coram'];
  map = new maplibregl.Map({ container: 'map', style: MAP_STYLE, center: [c[1], c[0]], zoom: 10, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  geoCtl = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, showUserLocation: true, showAccuracyCircle: true });
  map.addControl(geoCtl, 'top-right');
  geoCtl.on('geolocate', e => { myPos = [e.coords.latitude, e.coords.longitude]; renderNear(); if (ui.routeMap) fitRoute(); });
  map.on('load', () => { drawMarkers(); if (ui.routeMap) fitRoute(); else if (ui.hl) focusLead(ui.hl); else { fitAll(); geoCtl.trigger(); } });
}
function fitAll() {
  const pts = [...leads.values()].filter(l => (l.area || 'Unsorted') === ui.area).map(pinOf).filter(Boolean).map(p => p.ll);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds(); pts.forEach(p => b.extend([p[1], p[0]]));
  map.fitBounds(b, { padding: 50, maxZoom: 14, duration: 0 });
}
function drawMarkers() {
  if (!map) return;
  markers.forEach(m => m.remove()); markers.clear();
  if (ui.routeMap) return drawRoute();
  clearRouteLine();
  for (const l of leads.values()) {
    const p = pinOf(l); if (!p) continue;
    const el = document.createElement('div');
    el.className = 'pin' + (p.exact ? '' : ' approx') + (ui.hl === l.id ? ' hl' : '');
    el.style.background = PHASE_COLOR[l.phase || ''] || '#b0b7c0';
    el.addEventListener('click', ev => { ev.stopPropagation(); showPopup(l.id); });
    const m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.ll[1], p.ll[0]]).addTo(map);
    markers.set(l.id, m);
  }
  renderNear();
}
function showPopup(id) {
  const l = leads.get(id); const p = pinOf(l); if (!p) return;
  if (popup) popup.remove();
  const b = builderOf(l);
  const html = '<div class="pop-a">' + esc(l.address) + '</div><div class="pop-s">' + esc(l.town) + (l.phase ? ' · ' + esc(l.phase) : '') + (b.name ? '<br>Builder: ' + esc(b.name) : '') + (p.exact ? '' : '<br><i>Approximate pin</i>') + '</div>' +
    '<div class="pop-b"><button class="btn primary" data-open="' + esc(id) + '">Open lead</button><a class="btn" href="' + esc(gmaps(l)) + '" target="_blank" rel="noopener">Navigate</a></div>';
  popup = new maplibregl.Popup({ offset: 22, closeButton: true, maxWidth: '280px' }).setLngLat([p.ll[1], p.ll[0]]).setHTML(html).addTo(map);
}
function focusLead(id) {
  const l = leads.get(id); const p = l && pinOf(l); if (!p || !map) return;
  markers.forEach((m, k) => m.getElement().classList.toggle('hl', k === id));
  map.flyTo({ center: [p.ll[1], p.ll[0]], zoom: p.exact ? 16 : 14, duration: 600 });
  showPopup(id);
}
function renderNear() {
  if (ui.tab !== 'map') return;
  if (ui.routeMap) return renderRouteSummary();
  const list = $('#near-list'); const title = $('#near-title');
  if (!myPos) { title.textContent = 'Near me'; list.innerHTML = '<li class="row"><span class="sub">Waiting for your location… If asked, allow location for this app.</span></li>'; return; }
  const items = [...leads.values()].map(l => { const p = pinOf(l); return p ? { l, d: hav(myPos, p.ll), exact: p.exact } : null; }).filter(Boolean).sort((a, b) => a.d - b.d).slice(0, 25);
  const close = items.filter(x => x.d <= 5).length;
  title.textContent = 'Near me · ' + close + ' within 5 mi';
  list.innerHTML = items.map(x => '<li class="row"><button class="main" data-focus="' + esc(x.l.id) + '"><span class="addr"><span class="ph" style="background:' + (PHASE_COLOR[x.l.phase || ''] || '#b0b7c0') + '"></span>' + esc(x.l.address) + '</span><span class="sub">' + esc(x.l.town) + (x.l.phase ? ' · ' + esc(x.l.phase) : '') + '</span></button><span class="dist">' + fmtMi(x.d) + (x.exact ? '' : '~') + '</span></li>').join('');
}

/* ---------- route on the app map ---------- */
let routeGeo = { key: '', line: null, miles: null, mins: null };
function routeStops() { return route.ids.filter(id => leads.has(id) && pinOf(leads.get(id))); }
function clearRouteLine() { if (map && map.getLayer('route-line')) { map.removeLayer('route-line'); map.removeSource('route-line'); } }
function setRouteLine(coords) {
  const data = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  if (map.getSource('route-line')) map.getSource('route-line').setData(data);
  else { map.addSource('route-line', { type: 'geojson', data }); map.addLayer({ id: 'route-line', type: 'line', source: 'route-line', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2f6db5', 'line-width': 5, 'line-opacity': 0.85 } }); }
}
function drawRoute() {
  const ids = routeStops(); const done = new Set(route.done);
  ids.forEach((id, i) => {
    const l = leads.get(id); const p = pinOf(l);
    const el = document.createElement('div');
    el.className = 'num-pin' + (done.has(id) ? ' done' : '') + (p.exact ? '' : ' approx');
    el.textContent = i + 1;
    el.addEventListener('click', ev => { ev.stopPropagation(); showPopup(id); });
    markers.set(id, new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.ll[1], p.ll[0]]).addTo(map));
  });
  const pts = ids.map(id => { const p = pinOf(leads.get(id)).ll; return [p[1], p[0]]; });
  const key = pts.map(p => p.join(',')).join(';');
  if (routeGeo.key === key && routeGeo.line) setRouteLine(routeGeo.line);
  else { setRouteLine(pts); routeGeo = { key, line: null, miles: null, mins: null }; if (pts.length > 1) roadRoute(key, pts); }
  renderRouteSummary();
}
async function roadRoute(key, pts) {
  // Road-following line from the free OSRM router; falls back to straight lines if it can't be reached.
  try {
    const coords = []; let miles = 0, mins = 0;
    for (let i = 0; i < pts.length - 1; i += 79) {
      const chunk = pts.slice(i, i + 80);
      const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + chunk.map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';') + '?overview=full&geometries=geojson');
      if (!r.ok) throw new Error('router ' + r.status);
      const j = await r.json(); if (!j.routes || !j.routes.length) throw new Error('no route');
      coords.push(...j.routes[0].geometry.coordinates); miles += j.routes[0].distance / 1609.34; mins += j.routes[0].duration / 60;
    }
    if (routeGeo.key !== key) return;
    routeGeo.line = coords; routeGeo.miles = miles; routeGeo.mins = mins;
    if (ui.routeMap && map) setRouteLine(coords);
    renderRouteSummary();
  } catch (e) { console.warn(e); }
}
function fitRoute() {
  const ids = routeStops(); if (!ids.length || !map) return;
  const b = new maplibregl.LngLatBounds(); ids.forEach(id => { const p = pinOf(leads.get(id)).ll; b.extend([p[1], p[0]]); });
  if (myPos) b.extend([myPos[1], myPos[0]]);
  map.fitBounds(b, { padding: { top: 60, bottom: 260, left: 40, right: 40 }, maxZoom: 15, duration: 0 });
}
function renderRouteSummary() {
  if (ui.tab !== 'map' || !ui.routeMap) return;
  const ids = routeStops(); const done = new Set(route.done);
  const t = routeGeo.miles != null ? ' · ' + Math.round(routeGeo.miles) + ' mi · ' + (routeGeo.mins >= 60 ? Math.floor(routeGeo.mins / 60) + 'h ' : '') + Math.round(routeGeo.mins % 60) + 'm' : '';
  $('#near-title').textContent = 'Route · ' + ids.length + ' stops' + t;
  $('#near-list').innerHTML = '<li class="row"><button class="btn" data-act="exitroutemap">Back to all leads</button><button class="btn" data-act="gotoroute">Route list</button></li>' +
    ids.map((id, i) => { const l = leads.get(id); return '<li class="row"><span class="n-badge' + (done.has(id) ? ' done' : '') + '">' + (i + 1) + '</span><button class="main" data-focus="' + esc(id) + '"><span class="addr">' + esc(l.address) + '</span><span class="sub">' + esc(l.town) + (l.phase ? ' · ' + esc(l.phase) : '') + '</span></button></li>'; }).join('');
}

/* ---------- route ---------- */
async function makeRoute(ids) {
  const start = await getPosOnce();
  let rest = ids.filter(id => leads.has(id) && pinOf(leads.get(id)));
  const noPin = ids.filter(id => leads.has(id) && !pinOf(leads.get(id)));
  let cur = start || (rest.length ? pinOf(leads.get(rest[0])).ll : null); const out = [];
  while (rest.length) { let bi = 0, bd = Infinity; rest.forEach((id, i) => { const d = hav(cur, pinOf(leads.get(id)).ll); if (d < bd) { bd = d; bi = i; } }); const id = rest.splice(bi, 1)[0]; out.push(id); cur = pinOf(leads.get(id)).ll; }
  route = { ids: out.concat(noPin), done: [], drive: -1 }; save('sl.route', route);
  ui.selecting = false; ui.sel.clear(); setTab('route');
  toast('Route: ' + route.ids.length + ' stops, nearest first' + (start ? ' from where you are' : ''));
}
function renderRoute() {
  const el = $('#view-route');
  const ids = route.ids.filter(id => leads.has(id));
  if (!ids.length) { el.innerHTML = '<div class="block"><div class="block-h">No route yet</div><p class="empty">On the Leads tab, tap ☑︎ at the top, check the leads you want to hit, then tap “Make route”. They get put in order, nearest first from where you are.</p></div>'; return; }
  const done = new Set(route.done);
  if (route.drive >= 0) return renderDrive(ids, done);
  const left = ids.filter(id => !done.has(id));
  const next9 = left.slice(0, 10);
  const gUrl = next9.length ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(navTarget(leads.get(next9[next9.length - 1]))) + (next9.length > 1 ? '&waypoints=' + encodeURIComponent(next9.slice(0, -1).map(id => navTarget(leads.get(id))).join('|')) : '') + '&travelmode=driving' : '#';
  el.innerHTML = '<div class="actions"><button class="btn primary big" data-act="drive">Start drive-by</button><button class="btn big" data-act="routemap">Open in map</button><a class="btn big" href="' + esc(gUrl) + '" target="_blank" rel="noopener">Next ' + next9.length + ' in Google Maps</a></div>' +
    '<div class="block"><div class="block-h">' + ids.length + ' stops <span class="count">' + done.size + ' done</span></div>' +
    ids.map((id, i) => { const l = leads.get(id); return '<div class="stop' + (done.has(id) ? ' done' : '') + '"><span class="n">' + (i + 1) + '</span><button class="main" style="flex:1;text-align:left" data-open="' + esc(id) + '"><span class="addr" style="font-weight:600;display:block">' + esc(l.address) + '</span><span class="sub" style="font-size:13px;color:var(--muted)">' + esc(l.town) + (l.phase ? ' · ' + esc(l.phase) : '') + '</span></button><button class="btn" data-done="' + esc(id) + '">' + (done.has(id) ? 'Undo' : 'Done') + '</button></div>'; }).join('') +
    '</div><div class="actions"><button class="btn danger" data-act="clearroute">Clear route</button></div>';
}
function renderDrive(ids, done) {
  const el = $('#view-route');
  let i = route.drive; while (i < ids.length && done.has(ids[i])) i++;
  if (i >= ids.length) { el.innerHTML = '<div class="drive"><div class="addr">Route finished</div><p class="muted">' + done.size + ' of ' + ids.length + ' stops done.</p><button class="btn primary" data-act="enddrive">Back to list</button></div>'; return; }
  route.drive = i; save('sl.route', route);
  const l = leads.get(ids[i]); const b = builderOf(l);
  el.innerHTML = '<div class="drive"><div class="muted">Stop ' + (i + 1) + ' of ' + ids.length + '</div><div class="addr">' + esc(l.address) + '</div><div class="town">' + esc(l.town) + (b.name ? ' · Builder: ' + esc(b.name) : '') + '</div>' +
    '<div class="actions" style="padding:0 0 12px"><a class="btn primary big" href="' + esc(gmaps(l)) + '" target="_blank" rel="noopener">Navigate</a><a class="btn big" href="' + esc(amaps(l)) + '" target="_blank" rel="noopener">Apple</a>' + (b.phone ? '<a class="btn big" href="tel:' + esc(b.phone.replace(/[^\d+]/g, '')) + '">Call</a>' : '') + '</div>' +
    '<div class="muted" style="margin-bottom:6px">What phase is it?</div><div class="seg">' + PHASES.map(x => '<button data-dphase="' + esc(x) + '" data-id="' + esc(l.id) + '" class="' + (l.phase === x ? 'on' : '') + '">' + esc(x) + '</button>').join('') + '</div>' +
    '<label class="field" style="margin-top:12px"><span>Quick note</span><textarea id="d-note" placeholder="Builder name on sign, dumpster company…"></textarea></label>' +
    '<div class="actions" style="padding:6px 0 0"><button class="btn primary big" data-act="drivenext" data-id="' + esc(l.id) + '">Done, next stop</button><button class="btn big" data-act="driveskip">Skip</button><button class="btn big" data-open="' + esc(l.id) + '">Open lead</button></div></div>' +
    '<div class="actions"><button class="btn" data-act="enddrive">Back to list</button></div>';
}

/* ---------- tabs & global render ---------- */
function setTab(t) {
  ui.tab = t;
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#view-leads').hidden = t !== 'leads'; $('#view-map').hidden = t !== 'map'; $('#view-route').hidden = t !== 'route';
  $('#search-row').hidden = t !== 'leads'; $('#btn-select').hidden = t !== 'leads';
  $('#title').textContent = t === 'map' ? 'Map' : t === 'route' ? 'Route' : 'Leads';
  if (t === 'map') { initMap(); setTimeout(() => map && map.resize(), 50); renderNear(); }
  renderAll();
}
function renderSel() {
  $('#btn-select').classList.toggle('on', ui.selecting);
  $('#selbar').hidden = !(ui.selecting && ui.tab === 'leads');
  $('#selcount').textContent = ui.sel.size + ' selected';
  $('#sel-route').disabled = !ui.sel.size;
}
let drawT = null;
function renderAll() {
  if (!user) return;
  if (ui.tab === 'leads') renderLeads();
  if (ui.tab === 'route') renderRoute();
  if (ui.tab === 'map' && map && map.loaded()) { clearTimeout(drawT); drawT = setTimeout(drawMarkers, 80); }
  renderSel();
}
function openMenu() {
  const noPin = [...leads.values()].filter(l => !l.geo_src || l.geo_src === 'none').length;
  $('#menu').hidden = false;
  $('#menu-body').innerHTML =
    '<div style="padding:4px 18px 10px;color:var(--muted);font-size:14px">' + leads.size + ' leads · signed in as ' + esc(user.email) + '</div>' +
    '<button class="menu-item" data-act="geoall">Locate map pins' + (noPin ? ' (' + noPin + ' still at town center)' : '') + '</button>' +
    '<button class="menu-item" data-act="reload">Refresh leads</button>' +
    '<button class="menu-item" data-act="signout">Sign out</button>' +
    '<button class="menu-item" data-act="closemenu" style="color:var(--muted)">Close</button>';
}

/* ---------- events ---------- */
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.onclick = () => { if (b.dataset.tab === 'map' && ui.routeMap) { ui.routeMap = false; if (map && map.loaded()) drawMarkers(); } setTab(b.dataset.tab); });
$('#tab-add').onclick = openAdd;
$('#btn-menu').onclick = openMenu;
$('#btn-select').onclick = () => { ui.selecting = !ui.selecting; if (!ui.selecting) ui.sel.clear(); renderAll(); };
$('#sel-clear').onclick = () => { ui.sel.clear(); ui.selecting = false; renderAll(); };
$('#sel-route').onclick = () => makeRoute([...ui.sel]);
$('#q').oninput = e => { ui.q = e.target.value; renderLeads(); };
$('#near-toggle').onclick = () => { ui.nearOpen = !ui.nearOpen; $('#near').classList.toggle('closed', !ui.nearOpen); };
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
$('#menu').addEventListener('click', e => { if (e.target.id === 'menu') $('#menu').hidden = true; });
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('details.folder')) return;
  const k = d.dataset.town; if (d.open) ui.openTowns.add(k); else ui.openTowns.delete(k); save('sl.towns', [...ui.openTowns]);
}, true);
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.sel) { if (t.checked) ui.sel.add(t.dataset.sel); else ui.sel.delete(t.dataset.sel); renderSel(); }
  if (t.id === 'f-photo' && t.files && t.files[0]) {
    const id = t.dataset.id;
    try { const u = await shrinkPhoto(t.files[0]); const prev = photos.get(id); photos.set(id, u); renderLead(id);
      const { error } = await sb.from('leads').update({ photo: u }).eq('id', id);
      if (error) { photos.set(id, prev); renderLead(id); toast('Photo not saved: ' + error.message); } else toast('Photo saved');
    } catch (err) { toast('Could not read that photo'); }
  }
});
document.addEventListener('click', async e => {
  const t = e.target.closest('button,[data-open]'); if (!t) return;
  const d = t.dataset;
  if (d.open) { $('#menu').hidden = true; return openLead(d.open); }
  if (d.hot) return upd(d.hot, { hot: !leads.get(d.hot).hot }, true);
  if (d.area) { ui.area = d.area; ui.phase = ''; save('sl.area', ui.area); return renderLeads(); }
  if (d.phase !== undefined && t.classList.contains('chip')) { ui.phase = d.phase; return renderLeads(); }
  if (d.focus) return focusLead(d.focus);
  if (d.setphase !== undefined) { const l = leads.get(ui.openLead); const patch = { phase: d.setphase }; if (d.setphase && l.status === 'new') patch.status = 'active'; return upd(ui.openLead, patch); }
  if (d.setstatus) return upd(ui.openLead, { status: d.setstatus });
  if (d.aphase !== undefined) { document.querySelectorAll('#a-phase button').forEach(b => b.classList.toggle('on', b === t)); return; }
  if (d.dphase) { const l = leads.get(d.id); const patch = { phase: d.dphase }; if (l.status === 'new') patch.status = 'active'; return upd(d.id, patch, true); }
  if (d.done) { const s = new Set(route.done); s.has(d.done) ? s.delete(d.done) : s.add(d.done); route.done = [...s]; save('sl.route', route); return renderRoute(); }
  switch (d.act) {
    case 'close': return closeSheet();
    case 'closemenu': $('#menu').hidden = true; return;
    case 'seemap': closeSheet(); ui.routeMap = false; ui.hl = d.id; setTab('map'); if (map && map.loaded()) { drawMarkers(); focusLead(d.id); } return;
    case 'savebuilder': return upd(d.id, { builder: { name: $('#b-name').value.trim(), company: $('#b-company').value.trim(), phone: $('#b-phone').value.trim(), notes: $('#b-notes').value.trim() } });
    case 'addnote': { const v = $('#n-text').value; if (!v.trim()) return; await addNote(d.id, v); return toast('Note added'); }
    case 'delphoto': { if (!confirm('Remove this photo?')) return; photos.set(d.id, null); renderLead(d.id); const { error } = await sb.from('leads').update({ photo: null }).eq('id', d.id); return toast(error ? 'Not removed: ' + error.message : 'Photo removed'); }
    case 'pinhere': { toast('Getting your location…'); const p = await getPosOnce(); if (!p) return toast('Location not available. Allow location for this app in Settings.'); return upd(d.id, { lat: p[0], lng: p[1], geo_src: 'gps' }); }
    case 'pinfind': { try { toast('Looking up…'); const p = await geocodeOne(leads.get(d.id)); await upd(d.id, p, true); toast(p.geo_src === 'none' ? 'Address not found on the map' : p.geo_src === 'address' ? 'Found the address' : 'Found the street'); } catch (err) { toast('Lookup failed. Try again in a minute.'); } return; }
    case 'saveaddr': { const l = leads.get(d.id); const address = $('#l-address').value.trim(), town = normTown($('#l-town').value); if (!address || !town) return toast('Address and town are both needed'); return upd(d.id, { address, town, area: areaFor(town), lat: l.geo_src === 'gps' ? l.lat : null, lng: l.geo_src === 'gps' ? l.lng : null, geo_src: l.geo_src === 'gps' ? 'gps' : null }); }
    case 'dellead': { const l = leads.get(d.id); if (!confirm('Delete ' + l.address + ', ' + l.town + '? This can\'t be undone.')) return; const { error } = await sb.from('leads').delete().eq('id', d.id); if (error) return toast('Not deleted: ' + error.message); leads.delete(d.id); cacheLeads(); closeSheet(); renderAll(); return toast('Lead deleted'); }
    case 'addsave': return saveNew();
    case 'routemap': ui.routeMap = true; ui.hl = null; if (map && popup) popup.remove(); setTab('map'); if (map && map.loaded()) { drawMarkers(); fitRoute(); } return;
    case 'exitroutemap': ui.routeMap = false; if (popup) popup.remove(); drawMarkers(); return;
    case 'gotoroute': ui.routeMap = false; return setTab('route');
    case 'drive': route.drive = 0; save('sl.route', route); return renderRoute();
    case 'drivenext': { const v = $('#d-note').value; if (v.trim()) await addNote(d.id, v); const s = new Set(route.done); s.add(d.id); route.done = [...s]; route.drive++; save('sl.route', route); return renderRoute(); }
    case 'driveskip': route.drive++; save('sl.route', route); return renderRoute();
    case 'enddrive': route.drive = -1; save('sl.route', route); return renderRoute();
    case 'clearroute': if (!confirm('Clear this route?')) return; route = { ids: [], done: [], drive: -1 }; save('sl.route', route); return renderRoute();
    case 'geoall': $('#menu').hidden = true; return geocodeAll(false);
    case 'reload': $('#menu').hidden = true; return loadLeads();
    case 'signout': $('#menu').hidden = true; await sb.auth.signOut(); return;
  }
});

/* town suggestions for the town fields */
(function () { const dl = document.createElement('datalist'); dl.id = 'townlist'; dl.innerHTML = Object.keys(TOWNS).sort().map(t => '<option value="' + esc(t) + '">').join(''); document.body.appendChild(dl); })();

boot();
