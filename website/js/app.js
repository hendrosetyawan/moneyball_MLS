/* Moneyball MLS: scouting board for all 30 Major League Soccer clubs, plus a scouting pool of players across the
 * Americas (USL, MLS NEXT Pro, Canada, Mexico, South America, national teams) rated on the same MLS scale.
 * Everything a scout sees is a level word, a shape or a colour; exact numbers only appear on hover. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- vocabulary
const TIERS = [null, "Weak", "Developing", "Solid", "Strong", "Elite"];
const tier = (p) => (p == null ? 0 : p >= 90 ? 5 : p >= 70 ? 4 : p >= 40 ? 3 : p >= 20 ? 2 : 1);
const PLAYS_LIKE = [null, "a fringe player", "a squad player", "a rotation player", "a starter", "a star"];
const payBand = (v) => (v == null ? null : v < 150000 ? 1 : v < 400000 ? 2 : v < 1000000 ? 3 : v < 3000000 ? 4 : 5);
const PAY_WORDS = [null, "a minimum-level contract", "squad-player pay", "starter pay", "star pay", "designated-player pay"];
const PAY_SHORT = [null, "Minimum", "Squad", "Starter", "Star", "Designated"];
const money = (v) => (v == null ? "n/a" : v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `$${Math.round(v / 1e3)}K`);
const POS_NAME = { GK: "Goalkeeper", CB: "Centre-back", FB: "Full-back", DM: "Defensive mid", CM: "Central mid", AM: "Attacking mid", W: "Winger", ST: "Striker" };
const conf = (min) => (min >= 1800 ? 3 : min >= 900 ? 2 : 1);
const CONF_WORDS = [null, "small sample (under 900 minutes)", "medium sample", "large sample (1,800+ minutes)"];
const isPick = (p) => p.val === "Bargain" && (p.proj ?? p.imp) >= 55;
const SKILL_SHORT = { "Finishing": "Finish", "Goal threat": "Threat", "Chance creation": "Create", "Passing": "Pass", "Ball carrying": "Carry", "Movement": "Move",
  "Defending": "Defend", "Discipline": "Disc.", "Shot stopping": "Stops", "Claiming crosses": "Claims", "Handling": "Hands", "Distribution": "Distrib.", "Sweeping": "Sweep", "Positioning": "Position" };

// Americas pool: positions from box-score sources are broad (DEF/MID/FWD), so the pitch matches them by group
const POS_GROUP = { GK: "Goalkeeper", CB: "Defender", FB: "Defender", DM: "Midfielder", CM: "Midfielder", AM: "Midfielder", W: "Attacker", ST: "Attacker" };
const BROAD_NAME = { DEF: "Defender", MID: "Midfielder", FWD: "Forward", GK: "Goalkeeper" };
const isTarget = (p) => p.id.startsWith("x:");
const score = (p) => (isTarget(p) ? p.mr : p.imp);
const REGIONS = [{ k: "USA & Canada", label: "USA & Canada" }, { k: "Mexico", label: "Mexico" }, { k: "South America", label: "South America" }];
const READY = [{ k: "40", label: "40+ Solid", v: 40 }, { k: "55", label: "55+", v: 55 }, { k: "70", label: "70+ Strong", v: 70 }];
const TIER_WORDS = { full: "Same goals-added data as MLS (American Soccer Analysis)", rich: "Box score plus passing and defending (ESPN)", basic: "Box score only: goals, assists, shots, fouls" };
const TIER_DOTS = { full: 3, rich: 2, basic: 1 };
const SORTS = {
  mls: [["imp", "Best right now"], ["proj", "Best next season"], ["proj3", "Best in three seasons"], ["value", "Best value for money"], ["young", "Youngest first"]],
  americas: [["imp", "Best MLS-ready rating"], ["lr", "Best in his own league"], ["upside", "Young and MLS-ready"], ["young", "Youngest first"]],
  all: [["imp", "Best rating on the MLS scale"], ["young", "Youngest first"]],
};

// ---------------------------------------------------------------- state
const state = { pool: "mls", pos: new Set(), quick: null, age: null, budget: null, value: null, role: null, club: "", region: null, league: "", ready: null,
  q: "", sort: "imp", shown: 48, compare: [], nation: null };
let PLAYERS = [], TEAMS = [], META = {}, BY_ID = new Map(), TEAM_BY = new Map();
let TARGETS = [], LEAGUES = [], FLOWS = [], NATIONAL = [], LEAGUE_BY = new Map(), targetsReady = null;
const DETAILS = new Map();   // league -> {id: comps, history, box score, caps}
const leagueShort = (lg) => ({ mlsnp: "NEXT Pro", uslc: "USL Champ.", usl1: "USL One", "can.1": "CPL", "mex.1": "Liga MX", "bra.1": "Brasileirão A", "bra.2": "Série B",
  "arg.1": "Argentina", "arg.2": "Primera Nac.", "col.1": "Colombia", "chi.1": "Chile", "ecu.1": "Ecuador", "par.1": "Paraguay", "per.1": "Peru", mls: "MLS", "usa.1": "MLS" }[lg] ?? lg);
const regionOf = (p) => LEAGUE_BY.get(p.lg)?.region ?? "MLS";
const regionCls = (r) => ({ "USA & Canada": "rg-na", Mexico: "rg-mx", "South America": "rg-sa", MLS: "rg-mls" }[r] ?? "rg-na");

function ensureTargets() {
  if (!targetsReady) targetsReady = Promise.all(["targets", "leagues", "national"].map((f) => fetch(`data/${f}.json`).then((r) => r.json()))).then(([t, l, n]) => {
    TARGETS = t; LEAGUES = l.leagues; FLOWS = l.flows; NATIONAL = n;
    LEAGUE_BY = new Map(LEAGUES.map((x) => [x.id, x]));
    TARGETS.forEach((p) => BY_ID.set(p.id, p));
    $("#league").innerHTML = `<option value="">All leagues</option>` + [...LEAGUES].sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
      .map((x) => `<option value="${x.id}">${esc(x.name)} (${x.players})</option>`).join("");
    $("#pool-label").textContent = `+ ${TARGETS.length.toLocaleString()} targets across the Americas`;
  });
  return targetsReady;
}
async function details(p) {
  if (!DETAILS.has(p.lg)) DETAILS.set(p.lg, fetch(`data/targets/${p.lg}.json`).then((r) => r.json()));
  return (await DETAILS.get(p.lg))[p.id] ?? {};
}
const store = {
  get() { try { return JSON.parse(localStorage.getItem("moneyball-mls-shortlist") || "[]"); } catch { return []; } },
  set(ids) { try { localStorage.setItem("moneyball-mls-shortlist", JSON.stringify(ids)); } catch { /* storage unavailable */ } },
};
let SHORTLIST = store.get();

// ---------------------------------------------------------------- radar (string SVG, used everywhere)
function radarSVG(layers, { size = 104, labels = false, pad = 0 } = {}) {
  const keys = Object.keys(layers[0].sk);
  const n = keys.length, cx = size / 2 + pad, cy = size / 2 + pad, R = size / 2 - (labels ? 58 : 6);
  const ang = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * v / 100, cy + Math.sin(ang(i)) * R * v / 100];
  const dim = labels ? `style="width:100%;height:auto;max-width:${size + pad * 2}px;display:block;margin:0 auto"` : `width="${size}" height="${size}"`;
  let s = `<svg class="radar" viewBox="0 0 ${size + pad * 2} ${size + pad * 2}" ${dim} aria-hidden="true">`;
  for (const r of [20, 40, 70, 90]) {
    s += `<polygon class="ring ${r === 90 ? "r5" : ""}" points="${keys.map((_, i) => pt(i, r).join(",")).join(" ")}"/>`;
  }
  keys.forEach((_, i) => { const [x, y] = pt(i, 100); s += `<line class="spoke" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`; });
  layers.forEach((L, li) => {
    const pts = keys.map((k, i) => pt(i, Math.max(4, L.sk[k] ?? 0)).join(",")).join(" ");
    s += `<polygon class="area ${["", "b", "c"][li]}" points="${pts}"/>`;
  });
  if (labels) keys.forEach((k, i) => {
    const [x, y] = pt(i, 117); const anchor = Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end";
    const v = layers[0].sk[k];
    s += `<text class="lab" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" data-tip="${esc(k)}: ${v == null ? "n/a" : `better than ${v}% of ${esc(layers[0].g.toLowerCase())}s`}">${esc(k)}</text>`;
  });
  return s + "</svg>";
}

const meter = (p, { lo = null, hi = null } = {}) => {
  const t = tier(p), tl = tier(lo), th = tier(hi);
  return `<span class="meter">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= t ? `on l${t}` : lo != null && i >= tl && i <= th ? "range" : ""}"></i>`).join("")}</span>`;
};
const rt = (v, cls = "") => `<b class="rt l${tier(v)} ${cls}">${v ?? "–"}</b>`;
const SEASON = () => META.season;
// current season + up to three projected seasons, as exact ratings (0-100 vs same position group)
function seasonStrip(p, big = false) {
  const cells = [{ y: SEASON(), v: p.imp, now: true }, ...(p.fut ?? []).map((f) => ({ y: f.y, v: f.p, lo: f.lo, hi: f.hi }))];
  const html = cells.map((c) => `<div class="sz${c.now ? " now" : ""}" data-tip="${c.y}${c.now ? " (this season)" : " projection"}: rating ${c.v ?? "n/a"}${c.lo != null ? `, 80% likely ${c.lo}–${c.hi}` : ""} · ${TIERS[tier(c.v)] ?? "n/a"} · better than ${c.v ?? "?"}% of ${p.g.toLowerCase()}s">
    <span class="yr">${c.y}</span>${rt(c.v)}<small>${c.now ? "now" : `${c.lo}–${c.hi}`}</small></div>`).join("");
  const na = p.fut ? "" : `<div class="sz na"><small>No projection for goalkeepers yet</small></div>`;
  return `<div class="seasons${big ? " big" : ""}">${html}${na}</div>`;
}
const confDots = (min) => `<span class="conf" data-tip="${min.toLocaleString()} minutes: ${CONF_WORDS[conf(min)]}">${[1, 2, 3].map((i) => `<i class="${i <= conf(min) ? "on" : ""}"></i>`).join("")}</span>`;

const poolWord = (p) => (isTarget(p) ? `${p.g.toLowerCase()}s in the ${LEAGUE_BY.get(p.lg)?.name ?? "league"}` : `${p.g.toLowerCase()}s`);
function strengths(p) {
  if (!p.sk) return `<ul class="strengths"><li class="weak">Skill shape not available for keepers here</li></ul>`;
  const e = Object.entries(p.sk).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
  const top = e.filter(([, v]) => v >= 70).slice(0, 3);
  const weak = e.filter(([, v]) => v < 20).slice(-1);
  const li = top.map(([k, v]) => `<li data-tip="${esc(k)}: ${TIERS[tier(v)]}, better than ${v}% of ${esc(poolWord(p))}">${rt(v)} ${esc(k)}</li>`);
  if (!li.length) li.push(`<li class="weak">No standout skill yet</li>`);
  weak.forEach(([k, v]) => li.push(`<li class="weak" data-tip="${esc(k)}: weak, better than ${v}% of ${esc(poolWord(p))}">${rt(v)} ${esc(k)}</li>`));
  return `<ul class="strengths">${li.join("")}</ul>`;
}
const ntTag = (p) => (p.nt ? `<span class="nt" data-tip="${esc(p.nt.nation)} national team: ${p.nt.apps} appearances in 2023–26 competitions (World Cup, Gold Cup, Nations League, qualifiers, Copa América)">${esc(p.nt.nation)} · ${p.nt.apps} int'l</span>` : "");
const tierTag = (p) => `<span class="conf" data-tip="Data: ${TIER_WORDS[p.tier]}. ${p.min.toLocaleString()} minutes${p.min < 900 ? " (small sample)" : ""}.">${[1, 2, 3].map((i) => `<i class="${i <= TIER_DOTS[p.tier] ? "on" : ""}"></i>`).join("")}</span>`;
const posTip = (p) => POS_NAME[p.pos] ?? BROAD_NAME[p.pos] ?? p.pos;
function readyStrip(p, big = false) {
  const lg = LEAGUE_BY.get(p.lg);
  const lr = `<div class="sz" data-tip="${esc(p.season)} in the ${esc(lg?.name ?? p.lg)}: better than ${p.lr ?? "?"}% of the ${p.g.toLowerCase()}s there">
    <span class="yr">${esc(p.season)}</span>${rt(p.lr)}<small>in ${esc(leagueShort(p.lg))}</small></div>`;
  const mr = p.mr == null ? `<div class="sz na"><small>No MLS-ready rating for keepers yet</small></div>` :
    `<div class="sz now" data-tip="Likely MLS rating next season: ${p.mr} (${TIERS[tier(p.mr)]}), 80% likely ${p.mrLo}–${p.mrHi}. Same scale as MLS players: better than ${p.mr}% of MLS ${p.g.toLowerCase()}s.">
    <span class="yr">MLS-ready</span>${rt(p.mr)}<small>${p.mrLo}–${p.mrHi}</small></div>`;
  return `<div class="seasons ready${big ? " big" : ""}">${lr}${mr}</div>`;
}
function targetCard(p) {
  const saved = SHORTLIST.includes(p.id), r = regionOf(p);
  return `<article class="card target" data-id="${p.id}" tabindex="0" aria-label="${esc(p.n)}">
    <div class="top-row"><div><div class="name">${esc(p.n)}</div>
      <div class="meta">${esc(p.t)} · ${p.age ? Math.floor(p.age) + " yrs" : "age n/a"}${p.nat ? ` · ${esc(p.nat)}` : ""}</div></div>
      <span class="pos ${p.g}" data-tip="${posTip(p)}">${p.pos}</span></div>
    <div class="role"><span class="lg-tag ${regionCls(r)}" data-tip="${esc(LEAGUE_BY.get(p.lg)?.name ?? p.lg)} · ${esc(r)}">${esc(leagueShort(p.lg))}</span> ${esc(p.role ?? BROAD_NAME[p.pos] ?? "")}</div>
    <div class="shape">${p.sk ? radarSVG([p]) : `<div style="width:104px"></div>`}${strengths(p)}</div>
    ${readyStrip(p)}
    <div class="foot"><span>${ntTag(p)} ${tierTag(p)}</span>
      <button class="save ${saved ? "is-on" : ""}" data-save="${p.id}" aria-label="Save to shortlist">${saved ? "★ Saved" : "☆ Save"}</button></div>
  </article>`;
}

function card(p) {
  if (isTarget(p)) return targetCard(p);
  const team = TEAM_BY.get(p.t);
  const saved = SHORTLIST.includes(p.id);
  return `<article class="card ${isPick(p) ? "pick" : ""}" data-id="${p.id}" tabindex="0" aria-label="${esc(p.n)}">
    ${isPick(p) ? `<span class="pick-badge" data-tip="Bargain contract and expected to stay at least solid next season">★ MONEYBALL PICK</span>` : ""}
    <div class="top-row"><div><div class="name">${esc(p.n)}</div>
      <div class="meta">${esc(team?.short ?? p.t)} · ${Math.floor(p.age)} yrs${p.nat ? ` · ${esc(p.nat)}` : ""}</div></div>
      <span class="pos ${p.g}" data-tip="${POS_NAME[p.pos]}">${p.pos}</span></div>
    <div class="role">${esc(p.role ?? POS_NAME[p.pos])}</div>
    <div class="shape">${radarSVG([p])}${strengths(p)}</div>
    ${seasonStrip(p)}
    <div class="foot"><span><span class="vtag ${p.val}" data-tip="${valueTip(p)}">${p.val === "Unknown" ? "No salary" : p.val}</span> ${confDots(p.min)} ${ntTag(p)}</span>
      <button class="save ${saved ? "is-on" : ""}" data-save="${p.id}" aria-label="Save to shortlist">${saved ? "★ Saved" : "☆ Save"}</button></div>
  </article>`;
}
const valueTip = (p) => p.pay == null ? "Not in the April 2026 MLSPA salary release" :
  `Paid ${money(p.pay)} (${PAY_SHORT[payBand(p.pay)]}). Players with this production usually earn about ${money(p.fair)}.`;

// ---------------------------------------------------------------- filters
const QUICK_MLS = [
  { k: "picks", label: "★ Moneyball picks", gold: true, f: isPick },
  { k: "gems", label: "Hidden gems (U23)", f: (p) => p.age < 23 && p.imp >= 70 && (p.pay ?? 0) < 400000 },
  { k: "ready", label: "Ready now", f: (p) => p.imp >= 80 && p.min >= 1500 },
  { k: "upside", label: "Upside", f: (p) => p.age < 25 && p.pHi != null && p.pHi >= 85 },
];
const NA_PASSPORT = /^(United States|USA|Canada)$/i;
const QUICK_AM = [
  { k: "mlsready", label: "★ MLS starter level", gold: true, f: (p) => (p.mr ?? 0) >= 70 && p.min >= 1200 },
  { k: "u23", label: "Under-23 upside", f: (p) => p.age < 23 && (p.mrHi ?? 0) >= 70 },
  { k: "dominant", label: "Dominating his league", f: (p) => (p.lr ?? 0) >= 90 && p.min >= 1200 },
  { k: "intl", label: "National-team players", f: (p) => !!p.nt },
  { k: "na", label: "US / Canadian passport", f: (p) => NA_PASSPORT.test(p.nat ?? "") },
];
const quickList = () => (state.pool === "mls" ? QUICK_MLS : state.pool === "americas" ? QUICK_AM : [...QUICK_MLS.slice(1, 3), ...QUICK_AM.slice(3)]);
const AGES = [{ k: "u21", label: "Under 21", f: (a) => a < 21 }, { k: "21", label: "21–24", f: (a) => a >= 21 && a < 25 }, { k: "25", label: "25–29", f: (a) => a >= 25 && a < 30 }, { k: "30", label: "30+", f: (a) => a >= 30 }];
const BUDGETS = [{ k: "min", label: "Minimum", f: (v) => v < 150000 }, { k: "400", label: "Under $400K", f: (v) => v < 400000 }, { k: "1m", label: "Under $1M", f: (v) => v < 1000000 }, { k: "3m", label: "Under $3M", f: (v) => v < 3000000 }];
const VALUES = ["Bargain", "Fair", "Premium"];
const ZONES = [
  ["GK", [[0, 45, 24, 60]]], ["CB", [[24, 38, 46, 74]]], ["FB", [[24, 0, 71, 38], [24, 112, 71, 38]]], ["DM", [[70, 38, 32, 74]]],
  ["CM", [[102, 20, 34, 110]]], ["AM", [[136, 38, 40, 74]]], ["W", [[136, 0, 84, 38], [136, 112, 84, 38]]], ["ST", [[176, 38, 44, 74]]],
];

function chipRow(el, items, key, { multi = false } = {}) {
  el.innerHTML = items.map((it) => `<button class="chip ${it.gold ? "gold" : ""}" data-k="${it.k}">${esc(it.label)}</button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state[key] = state[key] === b.dataset.k ? null : b.dataset.k; state.shown = 48; syncChips(); render();
  };
}
function syncChips() {
  for (const [id, key] of [["quick", "quick"], ["age", "age"], ["budget", "budget"], ["value", "value"], ["roles", "role"], ["region", "region"], ["ready", "ready"]]) {
    $$(`#${id} .chip`).forEach((b) => b.classList.toggle("is-on", state[key] === b.dataset.k));
  }
  $$("#pitch-picker .zone").forEach((z) => z.classList.toggle("is-on", state.pos.has(z.dataset.pos)));
}
function buildPitchPicker() {
  const svg = $("#pitch-picker");
  let s = `<rect class="chalk" x="1" y="1" width="218" height="148" rx="4"/><line class="chalk" x1="110" y1="1" x2="110" y2="149"/><circle class="chalk" cx="110" cy="75" r="16"/>
    <rect class="chalk" x="1" y="40" width="26" height="70"/><rect class="chalk" x="193" y="40" width="26" height="70"/>`;
  for (const [pos, rects] of ZONES) {
    rects.forEach(([x, y, w, h], i) => { s += `<rect class="zone" data-pos="${pos}" x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="4"><title>${POS_NAME[pos]}</title></rect>`; });
    const [x, y, w, h] = rects[0]; s += `<text x="${x + w / 2}" y="${y + h / 2}">${pos}</text>`;
    if (rects[1]) { const [x2, y2, w2, h2] = rects[1]; s += `<text x="${x2 + w2 / 2}" y="${y2 + h2 / 2}">${pos}</text>`; }
  }
  s += `<text x="218" y="158" style="font-size:8px;fill:#8eaa9b;text-anchor:end">attack →</text>`;
  svg.innerHTML = s;
  svg.onclick = (e) => {
    const z = e.target.closest(".zone"); if (!z) return;
    const p = z.dataset.pos; state.pos.has(p) ? state.pos.delete(p) : state.pos.add(p);
    state.role = null; state.shown = 48; buildRoleChips(); syncChips(); render();
  };
}
const posMatch = (p) => !state.pos.size || state.pos.has(p.pos) || (p.pos === "DM" && state.pos.has("CM")) ||
  (BROAD_NAME[p.pos] && [...state.pos].some((x) => POS_GROUP[x] === p.g));
const poolList = () => (state.pool === "mls" ? PLAYERS : state.pool === "americas" ? TARGETS : PLAYERS.concat(TARGETS));
function buildRoleChips() {
  const pool = poolList().filter(posMatch);
  const roles = [...new Set(pool.map((p) => p.role).filter(Boolean))].sort();
  chipRow($("#roles"), roles.map((r) => ({ k: r, label: r })), "role");
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const quick = quickList().find((x) => x.k === state.quick), age = AGES.find((x) => x.k === state.age), bud = BUDGETS.find((x) => x.k === state.budget);
  const ready = READY.find((x) => x.k === state.ready);
  const mlsOnly = state.pool === "mls";
  let list = poolList().filter((p) =>
    posMatch(p) && (!quick || quick.f(p)) && (!age || (p.age != null && age.f(p.age))) &&
    (!mlsOnly || ((!bud || (p.pay != null && bud.f(p.pay))) && (!state.value || p.val === state.value) && (!state.club || p.t === state.club))) &&
    (!state.role || p.role === state.role) &&
    (mlsOnly || ((!state.league || (state.league === "usa.1" ? !isTarget(p) : p.lg === state.league)) && (!state.region || regionOf(p) === state.region) &&
      (!ready || (score(p) ?? -1) >= ready.v))) &&
    (!q || p.n.toLowerCase().includes(q) || (isTarget(p) ? `${p.t} ${p.tn ?? ""} ${LEAGUE_BY.get(p.lg)?.name ?? ""} ${p.nt?.nation ?? ""}`.toLowerCase().includes(q)
      : (TEAM_BY.get(p.t)?.name ?? "").toLowerCase().includes(q) || p.t.toLowerCase() === q)));
  const by = {
    imp: (a, b) => (score(b) ?? -1) - (score(a) ?? -1) || b.min - a.min,
    proj: (a, b) => (b.proj ?? -1) - (a.proj ?? -1) || (b.imp ?? -1) - (a.imp ?? -1),
    proj3: (a, b) => (b.fut?.[2]?.p ?? -1) - (a.fut?.[2]?.p ?? -1) || (b.imp ?? -1) - (a.imp ?? -1),
    value: (a, b) => ((b.fair ?? 0) / (b.pay ?? 1e9)) * (b.imp ?? 0) - ((a.fair ?? 0) / (a.pay ?? 1e9)) * (a.imp ?? 0),
    lr: (a, b) => (b.lr ?? -1) - (a.lr ?? -1) || (score(b) ?? -1) - (score(a) ?? -1),
    upside: (a, b) => ((b.mrHi ?? 0) - Math.max(0, b.age - 21) * 4) - ((a.mrHi ?? 0) - Math.max(0, a.age - 21) * 4),
    young: (a, b) => (a.age ?? 99) - (b.age ?? 99),
  }[state.sort] ?? ((a, b) => (score(b) ?? -1) - (score(a) ?? -1));
  return list.sort(by);
}

async function setPool(pool) {
  state.pool = pool;
  $$("#pool button").forEach((b) => { b.classList.toggle("is-on", b.dataset.pool === pool); b.setAttribute("aria-checked", b.dataset.pool === pool); });
  document.body.dataset.pool = pool;
  $("#pool-note").innerHTML = {
    mls: "The 30 MLS squads. Switch to <b>Americas targets</b> to scout USL, MLS NEXT Pro, Canada, Mexico and South America on the same 0–100 MLS scale.",
    americas: "Players outside MLS. <b>MLS-ready</b> = the rating he would likely have in MLS next season, on the same scale as MLS players (with an 80% range).",
    all: "MLS players and Americas targets together, ranked on one MLS scale (MLS players by this season's rating, targets by MLS-ready rating).",
  }[pool];
  const opts = SORTS[pool];
  if (!opts.some(([k]) => k === state.sort)) state.sort = "imp";
  $("#sort").innerHTML = opts.map(([k, l]) => `<option value="${k}" ${k === state.sort ? "selected" : ""}>${l}</option>`).join("");
  Object.assign(state, { quick: null, role: null, shown: 48 });
  chipRow($("#quick"), quickList(), "quick");
  if (pool !== "mls") {
    $("#cards").innerHTML = `<div class="empty">Loading players from across the Americas…</div>`;
    await ensureTargets();
  }
  buildRoleChips(); syncChips(); render();
}

// ---------------------------------------------------------------- views
function renderBoard(list) {
  const shown = list.slice(0, state.shown);
  $("#cards").innerHTML = shown.length ? shown.map(card).join("") : `<div class="empty">No players match. Try removing a filter.</div>`;
  $("#more").hidden = list.length <= state.shown;
  $("#board-count").textContent = `${list.length.toLocaleString()} of ${poolList().length.toLocaleString()} players`;
  const lg = state.pool !== "mls" && state.league ? (state.league === "usa.1" ? "MLS" : LEAGUE_BY.get(state.league)?.name) : null;
  const bits = [state.pos.size ? [...state.pos].map((p) => POS_NAME[p] + "s").join(" + ") : null, state.pool === "mls" && state.club ? TEAM_BY.get(state.club)?.name : null,
    lg, state.pool !== "mls" && !lg ? state.region : null].filter(Boolean);
  $("#board-title").textContent = bits.length ? bits.join(" · ") : { mls: "Scout board", americas: "Americas targets", all: "MLS + Americas" }[state.pool];
}

function renderAgeMap(list) {
  // targets have no salary data: show level on the MLS scale against age (young + high = top-left)
  const el = $("#map"); const W = 980, H = 560, m = { l: 56, r: 20, t: 20, b: 46 };
  const pts = list.filter((p) => score(p) != null && p.age).slice(0, 2500);
  const x = d3.scaleLinear().domain([16, 37]).range([m.l, W - m.r]).clamp(true), y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
  const col = { MLS: "#dfeee6", "USA & Canada": "#5cc8ff", Mexico: "#3ddc84", "South America": "#f5c542" };
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`);
  svg.append("rect").attr("class", "zone").attr("x", x(16)).attr("y", y(100)).attr("width", x(23) - x(16)).attr("height", y(70) - y(100)).attr("rx", 8);
  svg.append("text").attr("class", "zlabel").attr("x", x(23) - 8).attr("y", y(70) - 8).attr("text-anchor", "end").text("YOUNG AND MLS-READY");
  svg.append("g").selectAll("line").data([90, 70, 40, 20]).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d)).attr("stroke", "#1d3a2d").attr("stroke-dasharray", "3 4");
  svg.append("g").attr("class", "axis").selectAll("text").data([[95, "Elite"], [80, "Strong"], [55, "Solid"], [30, "Developing"], [10, "Weak"]]).join("text")
    .attr("x", m.l - 8).attr("y", (d) => y(d[0])).attr("text-anchor", "end").attr("dominant-baseline", "middle").text((d) => d[1]);
  svg.append("g").attr("class", "axis").selectAll("text").data([18, 21, 24, 27, 30, 33, 36]).join("text").attr("x", (d) => x(d)).attr("y", H - m.b + 18).attr("text-anchor", "middle").text((d) => d);
  svg.append("text").attr("class", "axis").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").attr("fill", "#8eaa9b").attr("font-size", 12).text("Age →   (vertical: rating on the MLS scale; targets use their MLS-ready rating)");
  const r = d3.scaleSqrt().domain([600, 3000]).range([2.5, 6.5]).clamp(true);
  svg.append("g").selectAll("circle").data(pts).join("circle")
    .attr("cx", (d) => x(d.age + (d.id.charCodeAt(d.id.length - 1) % 10) / 25)).attr("cy", (d) => y(score(d))).attr("r", (d) => r(d.min))
    .attr("fill", (d) => col[regionOf(d)] ?? "#5cc8ff").attr("fill-opacity", 0.7).attr("stroke", "#07110d").attr("stroke-width", 0.6)
    .attr("data-id", (d) => d.id).attr("data-tip", (d) => `${d.n} · ${isTarget(d) ? leagueShort(d.lg) + " · " + d.t : d.t} · ${posTip(d)}\n${isTarget(d) ? `MLS-ready ${d.mr} (${d.mrLo}–${d.mrHi})` : `MLS rating ${d.imp}`} · ${d.age ? Math.floor(d.age) + " yrs" : "age n/a"}`);
  const top = pts.filter((d) => d.age < 24 && score(d) >= 70).sort((a, b) => score(b) - score(a)).slice(0, 18);
  svg.append("g").selectAll("text").data(top).join("text").attr("class", "lbl").attr("x", (d) => x(d.age) + 7).attr("y", (d) => y(score(d)) + 3).text((d) => d.n.split(" ").slice(-1)[0]);
  const lg = svg.append("g").attr("transform", `translate(${W - m.r - 140},${H - m.b - 86})`);
  Object.entries(col).forEach(([k, c], i) => { lg.append("circle").attr("cx", 6).attr("cy", i * 18).attr("r", 5).attr("fill", c); lg.append("text").attr("x", 16).attr("y", i * 18 + 4).attr("fill", "#8eaa9b").attr("font-size", 11).text(k); });
  el.replaceChildren(svg.node());
}

function renderMap(list) {
  if (state.pool !== "mls") { renderAgeMap(list); return; }
  const el = $("#map"); const W = 980, H = 560, m = { l: 56, r: 20, t: 20, b: 46 };
  const pts = list.filter((p) => p.pay != null && p.imp != null);
  const x = d3.scaleLog().domain([70000, 26000000]).range([m.l, W - m.r]).clamp(true);
  const y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
  const col = { Attacker: "#ff8a7e", Midfielder: "#5cc8ff", Defender: "#3ddc84", Goalkeeper: "#b69cff" };
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`);
  svg.append("rect").attr("class", "zone").attr("x", x(70000)).attr("y", y(100)).attr("width", x(400000) - x(70000)).attr("height", y(70) - y(100)).attr("rx", 8);
  svg.append("text").attr("class", "zlabel").attr("x", x(400000) - 8).attr("y", y(70) - 8).attr("text-anchor", "end").text("BARGAIN CORNER");
  const tiers = [[90, "Elite"], [70, "Strong"], [40, "Solid"], [20, "Developing"]];
  svg.append("g").selectAll("line").data(tiers).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d[0])).attr("y2", (d) => y(d[0])).attr("stroke", "#1d3a2d").attr("stroke-dasharray", "3 4");
  svg.append("g").attr("class", "axis").selectAll("text").data([[95, "Elite"], [80, "Strong"], [55, "Solid"], [30, "Developing"], [10, "Weak"]]).join("text")
    .attr("x", m.l - 8).attr("y", (d) => y(d[0])).attr("text-anchor", "end").attr("dominant-baseline", "middle").text((d) => d[1]);
  const ticks = [[100000, "$100K"], [150000, "Minimum"], [400000, "$400K"], [1000000, "$1M"], [3000000, "$3M"], [10000000, "$10M"]];
  svg.append("g").attr("class", "axis").selectAll("text").data(ticks).join("text").attr("x", (d) => x(d[0])).attr("y", H - m.b + 18).attr("text-anchor", "middle").text((d) => d[1]);
  svg.append("text").attr("class", "axis").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").attr("fill", "#8eaa9b").attr("font-size", 12).text("Guaranteed pay, 2026 (log scale) →");
  const r = d3.scaleSqrt().domain([300, 2800]).range([3, 8]);
  svg.append("g").selectAll("circle").data(pts).join("circle")
    .attr("cx", (d) => x(d.pay)).attr("cy", (d) => y(d.imp)).attr("r", (d) => r(d.min)).attr("fill", (d) => col[d.g]).attr("fill-opacity", (d) => (isPick(d) ? 1 : 0.7))
    .attr("stroke", (d) => (isPick(d) ? "#f5c542" : "#07110d")).attr("stroke-width", (d) => (isPick(d) ? 2 : 0.8))
    .attr("data-id", (d) => d.id).attr("data-tip", (d) => `${d.n} · ${d.t} · ${POS_NAME[d.pos]}\n${TIERS[tier(d.imp)]} now · paid ${money(d.pay)} · ${d.val}`);
  // label picks and the most expensive players, skipping labels that would collide
  const cand = [...pts.filter(isPick).sort((a, b) => b.imp - a.imp), ...pts.filter((d) => d.pay >= 6000000).sort((a, b) => b.pay - a.pay)];
  const placed = [], lab = [];
  for (const d of cand) {
    const px = x(d.pay), py = y(d.imp);
    if (placed.some(([qx, qy]) => Math.abs(qx - px) < 70 && Math.abs(qy - py) < 13)) continue;
    placed.push([px, py]); lab.push(d); if (lab.length >= 22) break;
  }
  svg.append("g").selectAll("text").data(lab).join("text").attr("class", "lbl").attr("x", (d) => x(d.pay) + 7).attr("y", (d) => y(d.imp) + 3).text((d) => d.n.split(" ").slice(-1)[0]);
  const lg = svg.append("g").attr("transform", `translate(${W - m.r - 120},${H - m.b - 86})`);
  Object.entries(col).forEach(([k, c], i) => { lg.append("circle").attr("cx", 6).attr("cy", i * 18).attr("r", 5).attr("fill", c); lg.append("text").attr("x", 16).attr("y", i * 18 + 4).attr("fill", "#8eaa9b").attr("font-size", 11).text(k + "s"); });
  el.replaceChildren(svg.node());
}

function renderClubs() {
  $("#club-grid").innerHTML = TEAMS.map((t) => `<div class="club ${state.club === t.a ? "is-on" : ""}" data-club="${t.a}">
    <div class="ab">${t.a}</div><div class="nm">${esc(t.name)}</div>
    <div class="mini"><span data-tip="Minutes-weighted squad rating (0-100)">Rating ${rt(t.imp)}</span><span data-tip="Bargain contracts in the squad">${t.bargains ? `★ ${t.bargains}` : ""}</span></div></div>`).join("");
  const t = TEAM_BY.get(state.club);
  if (!t) { $("#club-detail").innerHTML = `<p class="muted">Select a club above.</p>`; return; }
  const squad = PLAYERS.filter((p) => p.t === t.a).sort((a, b) => b.min - a.min);
  const take = (pos, n, used) => squad.filter((p) => pos.includes(p.pos) && !used.has(p.id)).slice(0, n).map((p) => (used.add(p.id), p));
  const used = new Set();
  const XI = { GK: take(["GK"], 1, used), DEF: [...take(["FB"], 1, used), ...take(["CB"], 2, used), ...take(["FB"], 1, used)],
    MID: take(["DM", "CM", "AM"], 3, used), ATT: [...take(["W"], 1, used), ...take(["ST"], 1, used), ...take(["W"], 1, used)] };
  const rows = [["ATT", 70], ["MID", 175], ["DEF", 285], ["GK", 370]];
  const W = 520, H = 420;
  let s = `<svg viewBox="0 0 ${W} ${H}"><rect class="pitch" x="10" y="10" width="${W - 20}" height="${H - 20}" rx="10"/>
    <line class="chalk" x1="10" y1="${H / 2}" x2="${W - 10}" y2="${H / 2}"/><circle class="chalk" cx="${W / 2}" cy="${H / 2}" r="40"/>
    <rect class="chalk" x="${W / 2 - 90}" y="10" width="180" height="56"/><rect class="chalk" x="${W / 2 - 90}" y="${H - 66}" width="180" height="56"/>`;
  const tierCol = ["#4a5a52", "#4a5a52", "#6f8a7c", "#9bd3b2", "#3ddc84", "#f5c542"];
  const valFill = { Bargain: "#f5c542", Fair: "#2a3d34", Premium: "#5a2420", Unknown: "#1a2a22" };
  for (const [k, yy] of rows) {
    const line = XI[k]; const n = line.length;
    line.forEach((p, i) => {
      const xx = (W / (n + 1)) * (i + 1);
      s += `<g class="tok" data-id="${p.id}" data-tip="${esc(p.n)}&#10;${esc(p.role ?? "")} · ${TIERS[tier(p.imp)] ?? "n/a"} now · ${p.val}">
        <circle cx="${xx}" cy="${yy}" r="19" fill="${valFill[p.val]}" stroke="${tierCol[tier(p.imp)]}" stroke-width="4"/>
        <text x="${xx}" y="${yy + 4}" style="fill:${p.val === "Bargain" ? "#2a1f00" : "#eaf4ee"}">${p.pos}</text>
        <text x="${xx}" y="${yy + 34}">${esc(p.n.split(" ").slice(-1)[0])}</text>
        <text class="sub" x="${xx}" y="${yy + 46}">${TIERS[tier(p.imp)] ?? ""}</text></g>`;
    });
  }
  s += `</svg>`;
  const bargains = squad.filter((p) => p.val === "Bargain");
  const slots = [...XI.DEF, ...XI.MID, ...XI.ATT].filter((p) => p.imp != null).sort((a, b) => a.imp - b.imp).slice(0, 3);
  $("#club-detail").innerHTML = `<div class="board-head"><h1>${esc(t.name)}</h1><span class="muted">Most-used XI (4-3-3 by minutes). Ring colour = level now; fill = contract value (gold bargain, red premium).</span></div>
    <div class="xi-wrap"><div class="xi">${s}</div><div class="upgrade" id="upgrade"><h3>Upgrade targets</h3><p class="muted">Loading players from across the Americas…</p></div></div>
    <h3 style="font-family:var(--head);font-size:22px;margin:18px 0 8px">${bargains.length ? `★ Bargains at ${esc(t.short)}` : "Full squad"}</h3>
    <div class="cards">${(bargains.length ? bargains : squad).map(card).join("")}</div>
    ${bargains.length ? `<h3 style="font-family:var(--head);font-size:22px;margin:18px 0 8px">Full squad</h3><div class="cards">${squad.filter((p) => p.val !== "Bargain").map(card).join("")}</div>` : ""}`;
  ensureTargets().then(() => renderUpgrade(t, slots));
}

// for the club's three weakest XI slots: players outside MLS whose MLS-ready rating clearly beats the current starter
function renderUpgrade(team, slots) {
  const el = $("#upgrade"); if (!el || state.club !== team.a) return;
  const fits = (tg, pos) => tg.pos === pos || (pos === "DM" && tg.pos === "CM") || (pos === "CM" && tg.pos === "DM") || (BROAD_NAME[tg.pos] && POS_GROUP[pos] === tg.g);
  const blocks = slots.map((sl) => {
    const c = TARGETS.filter((tg) => tg.mr != null && fits(tg, sl.pos) && tg.mr >= sl.imp + 10 && tg.min >= 900)
      .sort((a, b) => b.mr - a.mr || (a.age ?? 99) - (b.age ?? 99)).slice(0, 4);
    return `<div class="up-slot"><div class="up-head"><span class="pos ${sl.g}">${sl.pos}</span> <b>${esc(sl.n)}</b> <span class="muted">now ${sl.imp}</span></div>
      ${c.length ? c.map((tg) => `<button class="up-row" data-id="${tg.id}" data-tip="${esc(tg.n)} · ${esc(tg.t)} (${esc(LEAGUE_BY.get(tg.lg)?.name ?? tg.lg)}) · MLS-ready ${tg.mr}, 80% likely ${tg.mrLo}–${tg.mrHi}">
        <span class="lg-tag ${regionCls(regionOf(tg))}">${esc(leagueShort(tg.lg))}</span><span class="up-n">${esc(tg.n)}</span><span class="muted">${tg.age ? Math.floor(tg.age) : ""}</span>${rt(tg.mr)}</button>`).join("")
        : `<p class="muted">No clear upgrade found.</p>`}</div>`;
  }).join("");
  el.innerHTML = `<h3>Upgrade targets</h3><p class="muted">The three weakest XI slots and players outside MLS whose MLS-ready rating beats the starter by 10+ (900+ minutes).</p>${blocks}`;
}

// ---------------------------------------------------------------- leagues & nations
const REGION_COL = { "USA & Canada": "#5cc8ff", Mexico: "#3ddc84", "South America": "#f5c542", MLS: "#dfeee6" };
function renderLeagues() {
  // ordered by club results (goals per match vs an average MLS club); USL and NEXT Pro have no cross-league results
  const R = LEAGUES.filter((l) => l.strength != null).concat([{ id: "usa.1", name: "MLS", region: "MLS", strength: 0, level: 50, players: PLAYERS.length, data: "goals added", movers_to_mls: null }])
    .sort((a, b) => b.strength - a.strength);
  const A = LEAGUES.filter((l) => l.strength == null && l.level != null).sort((a, b) => b.level - a.level);
  const W = 980, rowH = 30, m = { l: 230, r: 230, t: 34, b: 40 }, H = m.t + m.b + rowH * R.length;
  const lo = Math.min(-0.65, d3.min(R, (l) => l.strength) - 0.05), hi = Math.max(0.45, d3.max(R, (l) => l.strength) + 0.05);
  const x = d3.scaleLinear().domain([lo, hi]).range([m.l, W - m.r]);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  [-0.6, -0.4, -0.2, 0, 0.2, 0.4].filter((v) => v >= lo && v <= hi).forEach((v) => {
    s += `<line x1="${x(v)}" x2="${x(v)}" y1="${m.t - 6}" y2="${H - m.b}" stroke="${v === 0 ? "#dfeee6" : "#1d3a2d"}" stroke-dasharray="${v === 0 ? "4 4" : "2 4"}" opacity="${v === 0 ? 0.6 : 1}"/>
      <text x="${x(v)}" y="${m.t - 12}" text-anchor="middle" fill="#8eaa9b" font-size="11">${v > 0 ? "+" : ""}${v.toFixed(1)}</text>`; });
  s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 10}" text-anchor="middle" fill="#8eaa9b" font-size="11">Club results: goals per match vs an average MLS club (2023–2026, recent matches weigh more) →</text>
    <text x="${W - m.r + 12}" y="${m.t - 12}" fill="#8eaa9b" font-size="10.5">typical regular → MLS rating</text>`;
  const rs = d3.scaleSqrt().domain([0, d3.max(R, (l) => l.players)]).range([4, 13]);
  R.forEach((l, i) => {
    const yy = m.t + rowH * (i + 0.5), mls = l.id === "usa.1";
    s += `<g class="${mls ? "" : "lg-row"}" ${mls ? "" : `data-league="${l.id}"`} data-tip="${esc(l.name)} · ${esc(l.region)}\nClub results: ${l.strength >= 0 ? "+" : ""}${l.strength.toFixed(2)} goals per match vs an average MLS club.${mls ? "" : `\nA typical regular here would rate about ${l.level} in MLS next season.\n${l.players} players in the pool · ${l.movers_to_mls} moved to MLS since 2023 · data: ${esc(l.data)}`}">
      <text x="${m.l - 12}" y="${yy + 4}" text-anchor="end" fill="${mls ? "#3ddc84" : "#eaf4ee"}" font-size="13" font-weight="${mls ? 700 : 400}">${esc(l.name)}</text>
      <line x1="${x(0)}" x2="${x(l.strength)}" y1="${yy}" y2="${yy}" stroke="${REGION_COL[l.region]}" stroke-opacity=".4" stroke-width="2"/>
      <circle cx="${x(l.strength)}" cy="${yy}" r="${mls ? 8 : rs(l.players)}" fill="${REGION_COL[l.region]}" fill-opacity=".85" stroke="#07110d"/>
      <text x="${W - m.r + 12}" y="${yy + 4}" fill="#eaf4ee" font-size="12">${mls ? "50 (reference)" : `${rt(l.level).replace(/<[^>]+>/g, "")} <tspan fill="#8eaa9b" font-size="10.5">· ${esc(l.data)}</tspan>`}</text></g>`;
  });
  s += `</svg>`;
  const ladder = A.map((l) => `<button class="up-row" data-scout-league="${l.id}" data-tip="${esc(l.name)}: rated from ${l.movers_to_mls} players who moved up to MLS. A typical regular here would rate about ${l.level} in MLS next season.">
    <span class="lg-tag ${regionCls(l.region)}">${esc(leagueShort(l.id))}</span><span class="up-n">${esc(l.name)} <span class="muted">· ${l.players} players · ${l.movers_to_mls} moved up</span></span><span></span>${rt(l.level)}</button>`).join("");
  // moves into MLS: left = source league, right = MLS, width = number of players
  const into = FLOWS.filter((f) => f.b === "usa.1" && f.a !== "usa.1").sort((a, b) => b.n - a.n);
  const outOf = FLOWS.filter((f) => f.a === "usa.1" && f.b !== "usa.1");
  const maxN = d3.max(into, (f) => f.n) || 1, wOf = (n) => Math.max(1.5, 22 * n / maxN);
  const stackH = d3.sum(into, (f) => wOf(f.n) + 2), FW = 980, FH = Math.max(160, 26 * into.length + 40, stackH + 40);
  let fl = `<svg viewBox="0 0 ${FW} ${FH}" style="width:100%;height:auto">`;
  let yR = 20 + Math.max(0, (26 * into.length - stackH) / 2); const mx = 700, top = yR;
  into.forEach((f, i) => {
    const y0 = 20 + i * 26 + 9, w = wOf(f.n), y1 = yR + w / 2; yR += w + 2;
    const lg = LEAGUE_BY.get(f.a), c = REGION_COL[lg?.region] ?? "#5cc8ff", back = outOf.find((o) => o.b === f.a)?.n ?? 0;
    fl += `<g data-tip="${esc(lg?.name ?? f.a)} → MLS: ${f.n} players with 450+ minutes in the next MLS season · MLS → ${esc(lg?.name ?? f.a)}: ${back}">
      <text x="210" y="${y0 + 4}" text-anchor="end" fill="#eaf4ee" font-size="12">${esc(lg?.name ?? f.a)}</text>
      <text x="222" y="${y0 + 4}" fill="#f5c542" font-size="11" font-weight="700">${f.n}</text>
      <path d="M250,${y0} C${(250 + mx) / 2},${y0} ${(250 + mx) / 2},${y1} ${mx},${y1}" fill="none" stroke="${c}" stroke-opacity=".6" stroke-width="${w}"/></g>`;
  });
  fl += `<rect x="${mx}" y="${top}" width="14" height="${Math.max(10, yR - top)}" fill="#dfeee6" rx="3"/><text x="${mx + 24}" y="${top + (yR - top) / 2 + 5}" fill="#eaf4ee" font-size="16" font-family="Barlow Condensed" font-weight="700">MLS</text></svg>`;
  $("#leagues").innerHTML = `<div class="box"><h3>How strong is each league?</h3>
    <p class="hint">League strength from club results, including the competitions where leagues meet (Leagues Cup, Concacaf Champions Cup, Libertadores, Sudamericana, Club World Cup). Right: where a typical regular of each league (median production, 600+ minutes) would land on the MLS 0–100 scale next season. Dot size = players in the pool. Click a league to scout it.</p>${s}
    <h3 style="margin-top:14px">USL and MLS NEXT Pro</h3><p class="hint">No cross-league results here; these leagues are rated from the players who moved up to MLS (same goals-added data as MLS).</p><div class="upgrade" style="padding:6px 12px">${ladder}</div></div>
    <div class="box" style="margin-top:16px"><h3>Where MLS players come from</h3><p class="hint">Players who moved from each league to MLS the next season (2017–2026 for USL and NEXT Pro, 2023–2026 for the others).</p>${into.length ? fl : `<p class="muted">No moves recorded yet.</p>`}</div>`;
  renderNations();
}
function renderNations() {
  if (!NATIONAL.length) { $("#nations").innerHTML = ""; return; }
  const ns = [...NATIONAL].sort((a, b) => b.players.length - a.players.length);
  if (!state.nation || !ns.some((n) => n.nation === state.nation)) state.nation = ns.find((n) => n.nation === "United States")?.nation ?? ns[0].nation;
  const cur = ns.find((n) => n.nation === state.nation);
  const rows = cur.players.map((p) => { const t = p.link ? BY_ID.get(p.link) : null;
    const where = t ? (isTarget(t) ? `${esc(t.t)} · ${esc(leagueShort(t.lg))}` : `${esc(TEAM_BY.get(t.t)?.short ?? t.t)} · MLS`) : `<span class="muted">club league not covered</span>`;
    const rating = t ? (isTarget(t) ? (t.mr != null ? `${rt(t.mr)} <small class="muted">MLS-ready</small>` : "") : `${rt(t.imp)} <small class="muted">MLS now</small>`) : "";
    return `<tr ${t ? `class="link" data-id="${t.id}"` : ""}><td><b>${esc(p.n)}</b></td><td>${esc(BROAD_NAME[{ Defender: "DEF", Midfielder: "MID", Forward: "FWD", Goalkeeper: "GK" }[p.pos]] ?? p.pos ?? "")}</td>
      <td>${p.age ? Math.floor(p.age) : ""}</td><td class="num">${p.apps}</td><td class="num">${p.min.toLocaleString()}</td><td class="num">${p.goals}</td><td>${where}</td><td>${rating}</td></tr>`; }).join("");
  $("#nations").innerHTML = `<div class="box" style="margin-top:16px"><h3>National-team pools</h3>
    <p class="hint">Players who appeared for an Americas nation in the 2026 World Cup, 2025 Gold Cup, Nations League, World Cup qualifying or 2024 Copa América. Rows with a club in a covered league open a scouting profile.</p>
    <div class="chips nation-chips">${ns.map((n) => `<button class="chip ${n.nation === state.nation ? "is-on" : ""}" data-nation="${esc(n.nation)}">${esc(n.nation)} <small>${n.players.length}</small></button>`).join("")}</div>
    <table class="nt-table"><tr><th>Player</th><th>Position</th><th>Age</th><th>Int'l apps</th><th>Minutes</th><th>Goals</th><th>Club</th><th>Rating</th></tr>${rows}</table></div>`;
}

function renderShortlist() {
  const list = SHORTLIST.map((id) => BY_ID.get(id)).filter(Boolean);
  $("#sl-count").textContent = list.length;
  $("#sl-cards").innerHTML = list.length ? list.map(card).join("") : `<div class="empty">Tap ☆ Save on any player to build a shortlist.</div>`;
  state.compare = state.compare.filter((id) => SHORTLIST.includes(id));
  if (!list.length) { $("#compare").innerHTML = ""; return; }
  const sig = (p) => Object.keys(p.sk ?? {}).join("|");
  if (!state.compare.length) { const first = list.find((p) => p.sk && p.g !== "Goalkeeper"); if (first) state.compare = list.filter((p) => sig(p) === sig(first)).slice(0, 3).map((p) => p.id); }
  const sel = state.compare.map((id) => BY_ID.get(id)).filter((p) => p?.sk);
  const cols = ["#3ddc84", "#5cc8ff", "#f5c542"];
  $("#compare").innerHTML = `<div>${sel.length ? radarSVG(sel, { size: 300, labels: true, pad: 46 }) : ""}</div>
    <div class="keys"><b style="font-family:var(--head);font-size:20px">Compare shapes</b><span class="muted">Pick up to three with the same skill set (MLS and same-data leagues compare directly; box-score leagues compare with each other).</span>
    ${list.filter((p) => p.sk).map((p) => { const i = state.compare.indexOf(p.id); return `<button class="chip ${i >= 0 ? "is-on" : ""}" data-cmp="${p.id}" style="text-align:left">${i >= 0 ? `<i style="background:${cols[i]}"></i>` : ""}${esc(p.n)} · ${p.pos}${isTarget(p) ? ` · ${esc(leagueShort(p.lg))}` : ""}</button>`; }).join("")}</div>`;
}

// ---------------------------------------------------------------- profile drawer
function summary(p) {
  const team = TEAM_BY.get(p.t);
  const top = Object.entries(p.sk).filter(([, v]) => v >= 70).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${TIERS[tier(v)].toLowerCase()} ${k.toLowerCase()}`);
  let s = `${Math.floor(p.age)}-year-old ${(p.role ?? POS_NAME[p.pos]).toLowerCase()} at ${team?.name ?? p.t}. `;
  s += top.length ? `Stands out for ${top.join(" and ")}. ` : "No single skill stands out yet. ";
  if (p.imp != null) s += `Plays like ${PLAYS_LIKE[tier(p.imp)]}`;
  if (p.pay != null) s += `${p.imp != null ? " on " : "On "}${PAY_WORDS[payBand(p.pay)]}`;
  s += ". ";
  if (p.val === "Bargain") s += "His contract is well below what this level of play usually earns. ";
  if (p.val === "Premium") s += "He is paid well above what this level of play usually earns. ";
  if (p.imp != null) s += `Rating ${p.imp} this season. `;
  if (p.fut) s += `Projected ${p.fut.map((f) => `${f.p} in ${f.y} (range ${f.lo}–${f.hi})`).join(", ")}.`;
  if (conf(p.min) === 1) s += " Small sample so far, so treat this as a first look.";
  return s;
}

function addsValuePitch(p) {
  if (!p.ga) return "";
  // each on-ball action placed where it usually happens; bubble size = value added per game vs an average player at his position
  const spots = { interrupting: [70, 75, "Winning the ball"], fouling: [120, 118, "Fouls / discipline"], passing: [175, 60, "Passing"], dribbling: [235, 100, "Carrying"],
    receiving: [300, 48, "Getting on the ball"], shooting: [352, 85, "Shooting"] };
  const vmax = 0.12;
  let s = `<svg viewBox="0 0 400 150" style="width:100%;height:auto"><rect x="2" y="2" width="396" height="146" rx="8" fill="#0f2a1d" stroke="rgba(223,238,230,.35)"/>
    <line x1="200" y1="2" x2="200" y2="148" stroke="rgba(223,238,230,.3)"/><rect x="2" y="40" width="44" height="70" fill="none" stroke="rgba(223,238,230,.3)"/>
    <rect x="354" y="40" width="44" height="70" fill="none" stroke="rgba(223,238,230,.3)"/><text x="392" y="14" text-anchor="end" fill="#8eaa9b" font-size="9">attack →</text>`;
  for (const [k, [x, y, lab]] of Object.entries(spots)) {
    const v = p.ga[k] ?? 0; const r = 5 + 24 * Math.min(1, Math.abs(v) / vmax);
    const word = v > 0.03 ? "adds a lot" : v > 0.008 ? "adds some" : v < -0.03 ? "costs a lot" : v < -0.008 ? "costs some" : "about average";
    s += `<g data-tip="${lab}: ${word} (${v >= 0 ? "+" : ""}${v.toFixed(3)} goals added per 96 min vs average ${esc(p.pos)})">
      <circle cx="${x}" cy="${y}" r="${r}" fill="${v >= 0 ? "rgba(61,220,132,.55)" : "rgba(255,107,94,.5)"}" stroke="${v >= 0 ? "#3ddc84" : "#ff6b5e"}"/>
      <text x="${x}" y="${y + r + 11}" text-anchor="middle" fill="#dfeee6" font-size="10">${lab}</text></g>`;
  }
  return s + "</svg>";
}

function ratingTimeline(p) {
  const past = p.hist.filter((d) => d.i != null);
  const fut = p.fut ?? [];
  if (!past.length && !fut.length) return `<p class="muted">No rated seasons yet.</p>`;
  const y0 = SEASON() - 5, y1 = SEASON() + 3;
  const W = 520, H = 230, L = 34, R = 16, T = 22, B = 30;
  const x = (yr) => L + ((W - L - R) * (yr - y0)) / (y1 - y0), y = (v) => T + (H - T - B) * (1 - v / 100);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  [[90, 100, "#f5c542"], [70, 90, "#3ddc84"], [40, 70, "#9bd3b2"], [20, 40, "#6f8a7c"], [0, 20, "#4a5a52"]].forEach(([a, b, c]) => {
    s += `<rect x="${L}" width="${W - L - R}" y="${y(b)}" height="${y(a) - y(b)}" fill="${c}" opacity=".08"/>`;
  });
  [0, 20, 40, 70, 90, 100].forEach((v) => { s += `<text x="${L - 6}" y="${y(v) + 3}" text-anchor="end" fill="#8eaa9b" font-size="10">${v}</text>`; });
  for (let yr = y0; yr <= y1; yr++) s += `<text x="${x(yr)}" y="${H - 10}" text-anchor="middle" fill="${yr > SEASON() ? "#f5c542" : "#8eaa9b"}" font-size="11" font-weight="${yr === SEASON() ? 700 : 400}">${yr}</text>`;
  s += `<line x1="${x(SEASON() + 0.5)}" x2="${x(SEASON() + 0.5)}" y1="${T - 8}" y2="${H - B}" stroke="#2a5240" stroke-dasharray="3 3"/>
    <text x="${x(SEASON() + 0.5) + 4}" y="${T - 10}" fill="#f5c542" font-size="10">projected →</text>`;
  if (fut.length && p.imp != null) {
    const band = [[SEASON(), p.imp, p.imp], ...fut.map((f) => [f.y, f.lo, f.hi])];
    s += `<polygon points="${band.map(([yr, , hi]) => `${x(yr)},${y(hi)}`).join(" ")} ${band.slice().reverse().map(([yr, lo]) => `${x(yr)},${y(lo)}`).join(" ")}" fill="rgba(245,197,66,.13)" stroke="none"/>`;
    s += `<polyline fill="none" stroke="#f5c542" stroke-width="2" stroke-dasharray="5 4" points="${[[SEASON(), p.imp], ...fut.map((f) => [f.y, f.p])].map(([yr, v]) => `${x(yr)},${y(v)}`).join(" ")}"/>`;
    fut.forEach((f) => {
      s += `<g data-tip="${f.y} projection: rating ${f.p}, 80% likely ${f.lo}–${f.hi}"><circle cx="${x(f.y)}" cy="${y(f.p)}" r="5" fill="#07110d" stroke="#f5c542" stroke-width="2"/>
        <text x="${x(f.y)}" y="${y(f.p) - 10}" text-anchor="middle" fill="#f5c542" font-size="13" font-weight="700">${f.p}</text>
        <text x="${x(f.y)}" y="${y(f.lo) + 13}" text-anchor="middle" fill="#8eaa9b" font-size="9.5">${f.lo}–${f.hi}</text></g>`;
    });
  }
  if (past.length) s += `<polyline fill="none" stroke="#dfeee6" stroke-width="2" points="${past.map((d) => `${x(d.s)},${y(d.i)}`).join(" ")}"/>`;
  past.forEach((d) => {
    s += `<g data-tip="${d.s} · ${esc(d.t)} · rating ${d.i} (${TIERS[tier(d.i)]}) · ${d.min.toLocaleString()} min">
      <circle cx="${x(d.s)}" cy="${y(d.i)}" r="${d.min >= 1800 ? 6 : d.min >= 900 ? 4.5 : 3}" fill="#3ddc84" stroke="#07110d"/>
      <text x="${x(d.s)}" y="${y(d.i) - 10}" text-anchor="middle" fill="#eaf4ee" font-size="12" font-weight="700">${d.i}</text></g>`;
  });
  return s + "</svg>";
}

function contractNumbers(p) {
  if (p.pay == null) return `<p class="muted">Not in the April 2026 MLSPA salary release.</p>`;
  const ratio = p.fair / p.pay;
  return `<div class="money">
    <div><span>Paid (2026)</span><b>${money(p.pay)}</b><small>${PAY_SHORT[payBand(p.pay)]} pay</small></div>
    <div><span>Production usually earns</span><b class="gold">${money(p.fair)}</b><small>${PAY_SHORT[payBand(p.fair)]} pay</small></div>
    <div><span>Value</span><b class="${ratio >= 2 ? "gold" : ratio <= 0.5 ? "red" : ""}">${ratio.toFixed(1)}×</b><small>${ratio >= 1 ? "worth more than he costs" : "costs more than his production"}</small></div></div>`;
}

function targetSummary(p) {
  const lg = LEAGUE_BY.get(p.lg);
  const top = Object.entries(p.sk ?? {}).filter(([, v]) => v >= 70).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${TIERS[tier(v)].toLowerCase()} ${k.toLowerCase()}`);
  let s = `${p.age ? Math.floor(p.age) + "-year-old " : ""}${(p.role ?? BROAD_NAME[p.pos] ?? "player").toLowerCase()} at ${p.tn ?? p.t} (${lg?.name ?? p.lg}). `;
  if (p.lr != null) s += `In his league he beats ${p.lr}% of ${p.g.toLowerCase()}s${top.length ? `, standing out for ${top.join(" and ")}` : ""}. `;
  if (p.mr != null) s += `On the MLS scale he projects as ${PLAYS_LIKE[tier(p.mr)]} (rating ${p.mr}, 80% likely ${p.mrLo}–${p.mrHi}). `;
  if (lg?.level != null) s += `A typical regular in his league would rate about ${lg.level} in MLS. `;
  if (p.nt) s += `${p.nt.nation} international (${p.nt.apps} appearances in 2023–26 competitions). `;
  if (p.min < 900) s += "Small sample so far, so treat this as a first look.";
  return s;
}
function translateChart(p) {
  const lg = LEAGUE_BY.get(p.lg); if (p.mr == null) return `<p class="muted">Keepers get a league rating only.</p>`;
  const W = 520, H = 120, L = 16, R = 16, x = (v) => L + (W - L - R) * v / 100;
  const mark = (v, y, c, label, tip) => `<g data-tip="${esc(tip)}"><circle cx="${x(v)}" cy="${y}" r="6" fill="${c}" stroke="#07110d"/><text x="${x(v)}" y="${y - 11}" text-anchor="middle" fill="${c}" font-size="11" font-weight="700">${esc(label)}</text></g>`;
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  [[0, 20, "#4a5a52"], [20, 40, "#6f8a7c"], [40, 70, "#9bd3b2"], [70, 90, "#3ddc84"], [90, 100, "#f5c542"]].forEach(([a, b, c]) => { s += `<rect x="${x(a)}" y="70" width="${x(b) - x(a)}" height="10" fill="${c}" opacity=".5"/>`; });
  [0, 20, 40, 70, 90, 100].forEach((v) => { s += `<text x="${x(v)}" y="98" text-anchor="middle" fill="#8eaa9b" font-size="10">${v}</text>`; });
  s += `<rect x="${x(p.mrLo)}" y="66" width="${x(p.mrHi) - x(p.mrLo)}" height="18" fill="rgba(245,197,66,.18)" stroke="#f5c542" stroke-dasharray="3 2"/>`;
  s += mark(50, 75, "#dfeee6", "MLS regular", "A typical MLS regular sits at 50 on this scale");
  if (lg?.level != null) s += mark(lg.level, 48, REGION_COL[lg.region] ?? "#5cc8ff", `${leagueShort(p.lg)} regular`, `A typical regular in the ${lg.name} would rate about ${lg.level} in MLS`);
  s += mark(p.mr, 22, "#f5c542", `${p.n.split(" ").slice(-1)[0]} ${p.mr}`, `His likely MLS rating next season: ${p.mr}, 80% likely ${p.mrLo}–${p.mrHi}`);
  return s + `<text x="${W - R}" y="116" text-anchor="end" fill="#8eaa9b" font-size="10">MLS scale (0–100) →</text></svg>`;
}
function histTable(p) {
  if (!p.hist?.length) return `<p class="muted">No other seasons in covered leagues.</p>`;
  return `<table class="nt-table"><tr><th>Season</th><th>League</th><th>Club</th><th>Minutes</th><th>Rating</th></tr>${p.hist.map((h) => `<tr><td>${h.s}</td><td>${esc(leagueShort(h.lg))}</td><td>${esc(h.t ?? "")}</td>
    <td class="num">${h.min.toLocaleString()}</td><td data-tip="${h.lg === "mls" ? "MLS rating that season" : "Rating within that league"}">${rt(h.r)} <small class="muted">${h.lg === "mls" ? "MLS" : "in league"}</small></td></tr>`).join("")}</table>`;
}
async function openTarget(p) {
  $("#profile").innerHTML = `<div class="p-head"><div><h2>${esc(p.n)}</h2><p class="muted">Loading profile…</p></div><button class="close" data-close aria-label="Close">×</button></div>`;
  $("#drawer").hidden = false;
  const q = { ...p, ...(await details(p)) }, lg = LEAGUE_BY.get(p.lg), saved = SHORTLIST.includes(p.id);
  const skillRows = Object.entries(q.sk ?? {}).map(([k, v]) => `<span>${esc(k)}</span><span data-tip="${v == null ? "n/a" : `Better than ${v}% of ${esc(poolWord(q))}`}">${rt(v)}</span><span class="w l${tier(v)}">${TIERS[tier(v)] ?? "n/a"}</span>`).join("");
  const comps = (q.comps ?? []).map((c) => `<div class="comp ${BY_ID.has(c.id) && !isTarget(BY_ID.get(c.id)) ? "link" : ""}" ${BY_ID.has(c.id) ? `data-id="${c.id}"` : ""} data-tip="Profile similarity ${(c.sim * 100).toFixed(0)}%">
    <b>${esc(c.n)}</b>${c.season} · ${esc(c.t ?? "")}<div class="comp-rt">${rt(c.i)}</div><span class="muted">MLS rating that season</span></div>`).join("");
  const box = q.box ? (q.tier === "full" ? `Goals ${q.box.goals} (xG ${q.box.xg}) · assists ${q.box.assists} (xA ${q.box.xa}) · goals added per 96 min ${q.box.gplus >= 0 ? "+" : ""}${q.box.gplus}`
    : `Goals ${q.box.goals ?? "–"} · assists ${q.box.assists ?? "–"} · shots ${q.box.shots ?? "–"} (on target ${q.box.sot ?? "–"})${q.box.passes != null ? ` · passes ${q.box.passes} (${Math.round(q.box.passPct * 100)}%) · tackles won ${q.box.tackles} · interceptions ${q.box.inter}` : ""}`) : "";
  const nt = q.nt ? `<div class="box"><h3>National team</h3><p class="hint">${esc(q.nt.nation)} · appearances in 2023–26 competitions (friendlies not included).</p>
    <table class="nt-table"><tr><th>Competition</th><th>Apps</th><th>Minutes</th><th>Goals</th></tr>${(q.nt.comps ?? []).map((c) => `<tr><td>${esc(c.c)}</td><td class="num">${c.apps}</td><td class="num">${c.min.toLocaleString()}</td><td class="num">${c.g}</td></tr>`).join("")}</table></div>` : "";
  $("#profile").innerHTML = `
    <div class="p-head"><div>
      <span class="pos ${q.g}">${q.pos}</span> <span class="lg-tag ${regionCls(regionOf(q))}" style="margin-left:6px">${esc(lg?.name ?? q.lg)}</span> <span class="role" style="margin-left:6px">${esc(q.role ?? BROAD_NAME[q.pos] ?? "")}</span>
      <h2>${esc(q.n)}</h2>
      <div class="muted">${esc(q.tn ?? q.t)} · ${q.age ? Math.floor(q.age) + " yrs" : "age n/a"}${q.nat ? ` · ${esc(q.nat)}` : ""}${q.cm ? ` · ${q.cm} cm` : ""} · ${q.gp ?? "?"} games, ${q.min.toLocaleString()} min in ${esc(q.season)} ${tierTag(q)}</div>
      <div class="actions">${ntTag(q)} <span class="muted" style="font-size:12px">Data: ${esc(TIER_WORDS[q.tier])}</span></div></div>
      <button class="close" data-close aria-label="Close">×</button></div>
    <div class="summary">${esc(targetSummary(q))}</div>
    <div class="actions" style="margin-bottom:14px"><button class="btn ${saved ? "gold" : ""}" data-save="${q.id}">${saved ? "★ On shortlist" : "☆ Add to shortlist"}</button>
      <button class="btn alt" data-similar="${q.id}">Find similar targets</button><button class="btn alt" data-scout-league="${q.lg}">Scout the ${esc(leagueShort(q.lg))}</button></div>
    <div class="p-grid">
      <div class="box"><h3>On the MLS scale</h3><p class="hint">His rating inside his league, and the rating he would likely have in MLS next season (80% range).</p>${readyStrip(q, true)}
        <h3 style="margin-top:14px">How the translation works</h3>${translateChart(q)}</div>
      <div class="box"><h3>Skills in his league</h3><p class="hint">Compared with ${esc(poolWord(q))} this season.</p>${q.sk ? radarSVG([q], { size: 260, labels: true, pad: 46 }) : ""}<div class="skill-rows">${skillRows}</div></div>
      ${nt}
      <div class="box"><h3>Recent seasons</h3>${histTable(q)}</div>
    </div>
    <div class="box" style="margin-top:16px"><h3>Plays like (MLS)</h3><p class="hint">MLS players since ${SEASON() - 2} with the closest ${q.tier === "full" ? "style (goals-added profile)" : "box-score profile"}, same position group, and how good they were in MLS that season.</p><div class="comps">${comps || `<p class="muted">No close MLS match.</p>`}</div></div>
    <details class="box" style="margin-top:16px"><summary style="cursor:pointer">For the numbers people</summary><p class="muted" style="margin:8px 0 0">${box} · ${q.min.toLocaleString()} minutes · league strength offset ${lg?.offset ?? "n/a"} goals added per 96 min vs MLS</p></details>`;
  $("#profile").scrollTop = 0;
  try { history.replaceState(null, "", `#p=${q.id}`); } catch { /* ignore */ }
}

function openProfile(id) {
  const p = BY_ID.get(id); if (!p) return;
  if (isTarget(p)) { openTarget(p); return; }
  const team = TEAM_BY.get(p.t), saved = SHORTLIST.includes(p.id);
  const skillRows = Object.entries(p.sk).map(([k, v]) => `<span>${esc(k)}</span><span data-tip="${v == null ? "n/a" : `Better than ${v}% of ${p.g.toLowerCase()}s`}">${rt(v)}</span><span class="w l${tier(v)}">${TIERS[tier(v)] ?? "n/a"}</span>`).join("");
  const comps = p.comps.map((c) => `<div class="comp" data-tip="Style similarity ${(c.sim * 100).toFixed(0)}%"><b>${esc(c.n)}</b>${c.s} · ${esc(c.t ?? "")}<div class="comp-rt">${rt(c.i)}</div><span class="muted">rating that season (${TIERS[tier(c.i)] ?? "n/a"})</span></div>`).join("");
  const box = p.g === "Goalkeeper"
    ? `Saves ${p.box.saves} · conceded ${p.box.conceded} · goals prevented vs expected ${p.box.prevented >= 0 ? "+" : ""}${p.box.prevented}`
    : `Goals ${p.box.goals} (xG ${p.box.xg}) · assists ${p.box.assists} (xA ${p.box.xa}) · goals added per 96 min ${p.box.gplus >= 0 ? "+" : ""}${p.box.gplus}`;
  $("#profile").innerHTML = `
    <div class="p-head"><div>
      <span class="pos ${p.g}">${p.pos}</span> <span class="role" style="margin-left:6px">${esc(p.role ?? POS_NAME[p.pos])}</span>
      <h2>${esc(p.n)}</h2>
      <div class="muted">${esc(team?.name ?? p.t)} · ${Math.floor(p.age)} yrs${p.nat ? ` · ${esc(p.nat)}` : ""}${p.cm ? ` · ${p.cm} cm` : ""} · ${p.gp ?? "?"} games ${confDots(p.min)}</div>
      <div class="actions"><span class="vtag ${p.val}" data-tip="${valueTip(p)}" style="font-size:13px;padding:3px 10px">${p.val === "Unknown" ? "No salary data" : p.val + " contract"}</span>
        ${isPick(p) ? `<span class="star">★ Moneyball pick</span>` : ""}</div></div>
      <button class="close" data-close aria-label="Close">×</button></div>
    <div class="summary">${esc(summary(p))}</div>
    <div class="actions" style="margin-bottom:14px"><button class="btn ${saved ? "gold" : ""}" data-save="${p.id}">${saved ? "★ On shortlist" : "☆ Add to shortlist"}</button>
      <button class="btn alt" data-similar="${p.id}">Find similar players</button></div>
    <div class="p-grid">
      <div class="box"><h3>Skill shape</h3><p class="hint">Compared with ${p.g.toLowerCase()}s this season. The dashed gold ring is elite.</p>${radarSVG([p], { size: 300, labels: true, pad: 46 })}</div>
      <div class="box"><h3>Skills in words</h3><div class="skill-rows">${skillRows}</div>
        <h3 style="margin-top:16px">Overall rating</h3>${seasonStrip(p, true)}</div>
      ${p.ga ? `<div class="box"><h3>Where he adds value</h3><p class="hint">Green adds goals for his team, red costs them, compared with an average ${POS_NAME[p.pos].toLowerCase()}.</p>${addsValuePitch(p)}</div>` : ""}
      <div class="box"><h3>Contract</h3>${contractNumbers(p)}</div>
    </div>
    <div class="box" style="margin-top:16px"><h3>Rating: last five seasons and next three</h3><p class="hint">Rating 0–100 = better than that % of ${p.g.toLowerCase()}s. White = actual seasons (bigger dot = more minutes). Gold dashed = projection, shaded = 80% likely range; it widens because further seasons are harder to call.</p>${ratingTimeline(p)}</div>
    <div>
    </div>
    <div class="box" style="margin-top:16px"><h3>Plays like</h3><p class="hint">Closest playing styles in MLS since 2015 (same position), with how good they were that season.</p><div class="comps">${comps}</div></div>
    <details class="box" style="margin-top:16px"><summary style="cursor:pointer">For the numbers people</summary><p class="muted" style="margin:8px 0 0">${box} · ${p.min.toLocaleString()} minutes · pay ${money(p.pay)}, typical pay for this production ${money(p.fair)}</p></details>`;
  $("#drawer").hidden = false; $("#profile").scrollTop = 0;
  try { history.replaceState(null, "", `#p=${p.id}`); } catch { /* ignore */ }
}
function closeProfile() { $("#drawer").hidden = true; try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ } }

// ---------------------------------------------------------------- about
function renderAbout() {
  const r = META.model, pv = r.projection_validation, fs = r.fair_salary_model;
  $("#about").innerHTML = `<h1>How it works</h1>
  <p>Moneyball MLS turns Major League Soccer event data into a scouting board you can read at a glance. Every player in the ${META.season} season with at least ${META.min_minutes} minutes (${META.players} players, ${META.teams} clubs) gets a role, a skill shape, comparable players, a next-season outlook and a contract-value tag.</p>
  <h2>Ratings</h2>
  <p>Every rating is a number from 0 to 100: the share of players in the same position group this season (defenders, midfielders, attackers, goalkeepers) that the player beats. 89 means better than 89% of them. Colours follow five bands: <b style="color:var(--lv5)">90+ Elite</b>, <b style="color:var(--lv4)">70–89 Strong</b>, <b style="color:var(--lv3)">40–69 Solid</b>, <b style="color:var(--lv2)">20–39 Developing</b>, under 20 Weak. Skills come from American Soccer Analysis <i>goals added</i> (g+), which credits every on-ball action with how much it changed the chance of scoring or conceding, plus expected goals and assists. The overall rating uses total goals added per 96 minutes.</p>
  <h2>The machine-learning models</h2>
  <ul>
    <li><b>Roles</b>: k-means clustering within each position on a 13-feature style profile (2015–${META.season}, 900+ minute seasons); clusters are named from their centroids, for example ball-playing centre-back vs stopper.</li>
    <li><b>Plays like</b>: cosine similarity on the same style profile, searching every MLS season since 2015.</li>
    <li><b>Next three seasons</b>: one ridge regression per horizon (${SEASON() + 1}, ${SEASON() + 2}, ${SEASON() + 3}) on minutes-weighted, multi-season goals added plus age and style, trained on MLS 2015–${SEASON() - 1}. Each was tested only on seasons it had not seen:</li>
  </ul>
  <table><tr><th>Projection</th><th>Test seasons</th><th>Model error</th><th>"Same as last season"</th><th>"Shrink to average"</th><th>Rank corr.</th><th>80% range hit</th></tr>
    ${Object.entries(pv.horizons).map(([h, v]) => `<tr><td>${SEASON() + +h} (${h} season${h > 1 ? "s" : ""} ahead)</td><td>${v.folds.length}</td><td><b>${v.mean_mae_model}</b></td><td>${v.mean_mae_same_as_last_season}</td><td>${v.mean_mae_shrink_to_average}</td><td>${v.mean_spearman_model}</td><td>${Math.round(v.interval_80_coverage_heldout * 100)}%</td></tr>`).join("")}</table>
  <p class="note">Error = minutes-weighted mean absolute error in goals added per 96 minutes, averaged over the test seasons; lower is better. Ranges are calibrated on held-out errors. The further ahead, the weaker the ranking (rank correlation falls), so treat ${SEASON() + 3} as a rough guide. Projections assume the player is still in MLS with regular minutes.</p>
  <ul><li><b>Contract value</b>: a gradient-boosted model (LightGBM) learns what MLS pays for a given level of production, age and position from ${fs.n.toLocaleString()} player-seasons (2021–${META.season}), using out-of-fold predictions grouped by player (R² ${fs.r2_log_oof} on log pay; typical miss ×${fs.median_abs_ratio_error}). <span class="vtag Bargain">Bargain</span> = paid less than half of that and at least solid; <span class="vtag Premium">Premium</span> = paid more than twice that and not elite. ★ Moneyball pick = bargain expected to stay at least solid next season.</li></ul>
  ${scoutingAbout()}
  <h2>Data</h2>
  <p>Player data from the <a href="https://www.americansocceranalysis.com/">American Soccer Analysis</a> public API (xG, xPass, goals added; seasons 2015–${META.season}, ${META.season} season to date). Salaries are guaranteed compensation from the MLS Players Association releases (latest: ${META.salary_release}), as provided by ASA. 30 clubs, including San Diego FC.</p>
  <h2>Know before you use it</h2>
  <ul><li>Event data cannot see off-ball work, pressing intensity, character or injuries. Watch the player.</li>
    <li>Small samples (one hollow dot) swing a lot. Goalkeepers have no next-season projection yet.</li>
    <li>Salary tags do not know about transfer fees, allocation money, roster designations or how a player was acquired.</li></ul>
  <p class="note">Built by Hendro Setyawan. Code: <a href="https://github.com/hendrosetyawan/moneyball_MLS">github.com/hendrosetyawan/moneyball_MLS</a>. Not affiliated with MLS, the MLSPA or American Soccer Analysis.</p>`;
}

function scoutingAbout() {
  const sc = META.scouting; if (!sc) return "";
  const a = sc.same_metric_leagues, b = sc.box_score_leagues, f = sc.box_score_to_goals_added;
  return `<h2>Scouting the Americas</h2>
  <p>Switch the scout pool to <b>Americas targets</b> to search ${(META.targets ?? 0).toLocaleString()} players outside MLS: USL Championship, USL League One, MLS NEXT Pro, the Canadian Premier League, Liga MX, Brazil (Série A and B), Argentina (Liga Profesional and Primera Nacional), Colombia, Chile, Ecuador, Paraguay and Peru, plus national-team players of every Americas nation. Each target gets two numbers on the same 0–100 scale as MLS players: how he rates <b>inside his own league</b>, and his <b>MLS-ready rating</b>, the rating he would likely have in MLS next season, with an 80% range.</p>
  <ul>
    <li><b>USL and MLS NEXT Pro</b> have the same goals-added data as MLS. A ridge model trained on the ${a.movers} players who moved from these leagues to MLS predicts next-season MLS goals added from goals added, style and age in the lower league. Held-out error ${a.mae_model} vs ${a.mae_league_average_of_movers} for the league average of movers and ${a.mae_same_goals_added_as_lower_league} for "same as in the lower league"; ranking (Spearman) ${a.spearman_model}, about the same as ranking by raw lower-league goals added (${a.spearman_lower_league_goals_added}). 80% ranges hit ${Math.round(a.interval_80_coverage_heldout * 100)}% of held-out players.</li>
    <li><b>Box-score leagues</b> (ESPN, CPL): three steps. (1) Inside MLS, a model learns how box-score stats per 90 relate to goals added (R² ${f.basic.r2_oof} with goals, primary assists, shots, fouls and cards; ${f.rich?.r2_oof ?? "–"} where passing and defending are recorded). Where a league does not record a stat, the model is retrained without it. (2) League strength comes from results: team ratings from ${(b.matches ?? 0).toLocaleString()} matches in 2023–2026, including the competitions where leagues meet (Leagues Cup, Concacaf Champions Cup, Libertadores, Sudamericana, Club World Cup); one factor fitted on players who moved to MLS turns it into goals added. (3) A calibration learned from ${sc.box_score_calibration?.rows?.toLocaleString() ?? "–"} MLS player-seasons turns MLS-level production into next season's rating (regression to the mean, age). Checked on the ${b.movers_into_mls} players who moved from these leagues to MLS, each held out: error ${b.mae_model ?? "–"} vs ${b.mae_mls_average ?? "–"} for "MLS average" and ${b.mae_without_league_strength ?? "–"} without league strength; ranking ${b.spearman_model ?? "–"}; 80% ranges hit ${b.interval_80_coverage_heldout != null ? Math.round(b.interval_80_coverage_heldout * 100) + "%" : "–"}. Box-score ratings are a filter for whom to watch, less precise than goals-added ratings.</li>
    <li><b>Leagues & nations</b> shows each league's strength on the MLS scale, where MLS players come from, and national-team pools (2026 World Cup, 2025 Gold Cup, Nations League, World Cup qualifying, 2024 Copa América).</li>
  </ul>
  <p class="note">Outside MLS there is no salary or transfer-fee data, so targets have no contract tag. Leagues without published player statistics (Uruguay, Venezuela, Bolivia, Central America, Liga de Expansión MX) appear only through national teams. A predicted MLS rating is a reason to watch a player, not a verdict: style, adaptation, injuries and roster rules (international slots) are not in the data.</p>`;
}

// ---------------------------------------------------------------- render loop
function currentView() { return $(".tab.is-on").dataset.view; }
function render() {
  const list = filtered(); const v = currentView();
  if (v === "board") renderBoard(list);
  if (v === "map") renderMap(list);
  if (v === "clubs") renderClubs();
  if (v === "shortlist") renderShortlist();
  if (v === "leagues") { if (LEAGUES.length) renderLeagues(); else ensureTargets().then(renderLeagues); }
  $("#sl-count").textContent = SHORTLIST.length;
}
function setView(v) {
  $$(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("is-on", s.id === `view-${v}`));
  document.body.dataset.view = v;            // about and leagues use the full width (no filters)
  render();
}
function toggleSave(id) {
  SHORTLIST = SHORTLIST.includes(id) ? SHORTLIST.filter((x) => x !== id) : [...SHORTLIST, id];
  store.set(SHORTLIST);
  render();
  if (!$("#drawer").hidden) openProfile(id);
}

async function init() {
  const [players, teams, meta] = await Promise.all(["players", "teams", "meta"].map((f) => fetch(`data/${f}.json`).then((r) => r.json())));
  PLAYERS = players; TEAMS = teams; META = meta;
  BY_ID = new Map(PLAYERS.map((p) => [p.id, p])); TEAM_BY = new Map(TEAMS.map((t) => [t.a, t]));
  $("#season-label").textContent = meta.season;
  $("#club").innerHTML += TEAMS.map((t) => `<option value="${t.a}">${esc(t.name)}</option>`).join("");
  buildPitchPicker();
  chipRow($("#quick"), QUICK_MLS, "quick"); chipRow($("#age"), AGES, "age"); chipRow($("#budget"), BUDGETS, "budget");
  chipRow($("#region"), REGIONS, "region"); chipRow($("#ready"), READY, "ready");
  $("#sort").innerHTML = SORTS.mls.map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  document.body.dataset.pool = "mls";
  $("#pool").onclick = (e) => { const b = e.target.closest("[data-pool]"); if (b && b.dataset.pool !== state.pool) setPool(b.dataset.pool); };
  $("#league").onchange = (e) => { state.league = e.target.value; state.shown = 48; render(); };
  chipRow($("#value"), VALUES.map((v) => ({ k: v, label: v, gold: v === "Bargain" })), "value");
  buildRoleChips(); renderAbout();
  if (matchMedia("(max-width: 900px)").matches) $("#more-filters").open = false;

  $(".tabs").onclick = (e) => { const t = e.target.closest(".tab"); if (t) setView(t.dataset.view); };
  $("#search").oninput = (e) => { state.q = e.target.value; state.shown = 48; render(); };
  $("#club").onchange = (e) => { state.club = e.target.value; state.shown = 48; render(); };
  $("#sort").onchange = (e) => { state.sort = e.target.value; render(); };
  $("#more").onclick = () => { state.shown += 48; render(); };
  $("#reset").onclick = () => {
    Object.assign(state, { pos: new Set(), quick: null, age: null, budget: null, value: null, role: null, club: "", region: null, league: "", ready: null, q: "", sort: "imp", shown: 48 });
    $("#search").value = ""; $("#club").value = ""; $("#league").value = ""; $("#sort").value = "imp"; buildRoleChips(); syncChips(); render();
  };
  document.addEventListener("click", async (e) => {
    const save = e.target.closest("[data-save]"); if (save) { e.stopPropagation(); toggleSave(save.dataset.save); return; }
    if (e.target.closest("[data-close]")) { closeProfile(); return; }
    const sim = e.target.closest("[data-similar]");
    if (sim) {
      const p = BY_ID.get(sim.dataset.similar); closeProfile();
      const pos = BROAD_NAME[p.pos] ? Object.keys(POS_GROUP).filter((k) => POS_GROUP[k] === p.g) : [p.pos];
      Object.assign(state, { pos: new Set(pos), role: p.role ?? null, quick: null, club: "", league: "", shown: 48 });
      if (isTarget(p) && state.pool === "mls") await setPool("americas");
      $("#league").value = ""; buildRoleChips(); syncChips(); setView("board"); return;
    }
    const scoutLg = e.target.closest("[data-scout-league], .lg-row");
    if (scoutLg) {
      closeProfile(); state.league = scoutLg.dataset.scoutLeague ?? scoutLg.dataset.league; state.region = null;
      if (state.pool === "mls") await setPool("americas");
      $("#league").value = state.league; state.shown = 48; syncChips(); setView("board"); return;
    }
    const nation = e.target.closest("[data-nation]"); if (nation) { state.nation = nation.dataset.nation; renderNations(); return; }
    const cmp = e.target.closest("[data-cmp]");
    if (cmp) {
      const id = cmp.dataset.cmp, p = BY_ID.get(id);
      if (state.compare.includes(id)) state.compare = state.compare.filter((x) => x !== id);
      else { const sig = (x) => Object.keys(x.sk ?? {}).join("|"); if (state.compare.length && sig(BY_ID.get(state.compare[0])) !== sig(p)) state.compare = []; state.compare = [...state.compare, id].slice(-3); }
      renderShortlist(); return;
    }
    const club = e.target.closest("[data-club]"); if (club) { state.club = state.club === club.dataset.club ? "" : club.dataset.club; $("#club").value = state.club; render(); return; }
    const hit = e.target.closest(".card, .tok, circle[data-id], .up-row, tr.link, .comp.link"); if (hit) openProfile(hit.dataset.id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeProfile();
    if (e.key === "Enter" && e.target.classList?.contains("card")) openProfile(e.target.dataset.id);
  });
  // tooltip
  const tip = $("#tip");
  document.addEventListener("mouseover", (e) => { const t = e.target.closest("[data-tip]"); if (!t) { tip.hidden = true; return; } tip.textContent = t.dataset.tip; tip.hidden = false; });
  document.addEventListener("mousemove", (e) => { if (tip.hidden) return; const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`; });
  render();
  if (SHORTLIST.some((id) => id.startsWith("x:"))) ensureTargets().then(() => { if (currentView() === "shortlist") renderShortlist(); });
  const m = location.hash.match(/p=([\w:.-]+)/);
  if (m) { if (m[1].startsWith("x:")) ensureTargets().then(() => openProfile(m[1])); else openProfile(m[1]); }
}
init();
