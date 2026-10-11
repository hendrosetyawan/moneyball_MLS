/* Moneyball US Soccer: scouting board for all 30 MLS clubs.
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

// ---------------------------------------------------------------- state
const state = { pos: new Set(), quick: null, age: null, budget: null, value: null, role: null, club: "", q: "", sort: "imp", shown: 48, compare: [] };
let PLAYERS = [], TEAMS = [], META = {}, BY_ID = new Map(), TEAM_BY = new Map();
const store = {
  get() { try { return JSON.parse(localStorage.getItem("mbus-shortlist") || "[]"); } catch { return []; } },
  set(ids) { try { localStorage.setItem("mbus-shortlist", JSON.stringify(ids)); } catch { /* storage unavailable */ } },
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
const confDots = (min) => `<span class="conf" data-tip="${min.toLocaleString()} minutes: ${CONF_WORDS[conf(min)]}">${[1, 2, 3].map((i) => `<i class="${i <= conf(min) ? "on" : ""}"></i>`).join("")}</span>`;

function strengths(p) {
  const e = Object.entries(p.sk).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
  const top = e.filter(([, v]) => v >= 70).slice(0, 3);
  const weak = e.filter(([, v]) => v < 20).slice(-1);
  const li = top.map(([k, v]) => `<li data-tip="${esc(k)}: better than ${v}% of ${p.g.toLowerCase()}s"><b class="w l${tier(v)}">${TIERS[tier(v)]}</b> ${esc(k.toLowerCase())}</li>`);
  if (!li.length) li.push(`<li class="weak">No standout skill yet</li>`);
  weak.forEach(([k, v]) => li.push(`<li class="weak" data-tip="${esc(k)}: better than ${v}% of ${p.g.toLowerCase()}s">Weak ${esc(k.toLowerCase())}</li>`));
  return `<ul class="strengths">${li.join("")}</ul>`;
}

function card(p) {
  const team = TEAM_BY.get(p.t);
  const saved = SHORTLIST.includes(p.id);
  return `<article class="card ${isPick(p) ? "pick" : ""}" data-id="${p.id}" tabindex="0" aria-label="${esc(p.n)}">
    ${isPick(p) ? `<span class="pick-badge" data-tip="Bargain contract and expected to stay at least solid next season">★ MONEYBALL PICK</span>` : ""}
    <div class="top-row"><div><div class="name">${esc(p.n)}</div>
      <div class="meta">${esc(team?.short ?? p.t)} · ${Math.floor(p.age)} yrs${p.nat ? ` · ${esc(p.nat)}` : ""}</div></div>
      <span class="pos ${p.g}" data-tip="${POS_NAME[p.pos]}">${p.pos}</span></div>
    <div class="role">${esc(p.role ?? POS_NAME[p.pos])}</div>
    <div class="shape">${radarSVG([p])}${strengths(p)}</div>
    <div class="meters">
      <span>Now</span><span data-tip="Overall impact this season: ${TIERS[tier(p.imp)] ?? "n/a"} (better than ${p.imp ?? "?"}% of ${p.g.toLowerCase()}s)">${meter(p.imp)}</span>
      <span>Next year</span><span data-tip="${p.proj == null ? "No projection for goalkeepers" : `Projected: ${TIERS[tier(p.proj)]}, likely range ${TIERS[tier(p.pLo)]} to ${TIERS[tier(p.pHi)]}`}">${p.proj == null ? `<span class="muted">n/a</span>` : meter(p.proj, { lo: p.pLo, hi: p.pHi })}</span>
    </div>
    <div class="foot"><span><span class="vtag ${p.val}" data-tip="${valueTip(p)}">${p.val === "Unknown" ? "No salary" : p.val}</span> ${confDots(p.min)}</span>
      <button class="save ${saved ? "is-on" : ""}" data-save="${p.id}" aria-label="Save to shortlist">${saved ? "★ Saved" : "☆ Save"}</button></div>
  </article>`;
}
const valueTip = (p) => p.pay == null ? "Not in the April 2026 MLSPA salary release" :
  `Paid ${money(p.pay)} (${PAY_SHORT[payBand(p.pay)]}). Players with this production usually earn about ${money(p.fair)}.`;

// ---------------------------------------------------------------- filters
const QUICK = [
  { k: "picks", label: "★ Moneyball picks", gold: true, f: isPick },
  { k: "gems", label: "Hidden gems (U23)", f: (p) => p.age < 23 && p.imp >= 70 && (p.pay ?? 0) < 400000 },
  { k: "ready", label: "Ready now", f: (p) => p.imp >= 80 && p.min >= 1500 },
  { k: "upside", label: "Upside", f: (p) => p.age < 25 && p.pHi != null && p.pHi >= 85 },
];
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
  for (const [id, key] of [["quick", "quick"], ["age", "age"], ["budget", "budget"], ["value", "value"], ["roles", "role"]]) {
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
function buildRoleChips() {
  const pool = PLAYERS.filter((p) => !state.pos.size || state.pos.has(p.pos));
  const roles = [...new Set(pool.map((p) => p.role).filter(Boolean))].sort();
  chipRow($("#roles"), roles.map((r) => ({ k: r, label: r })), "role");
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const quick = QUICK.find((x) => x.k === state.quick), age = AGES.find((x) => x.k === state.age), bud = BUDGETS.find((x) => x.k === state.budget);
  let list = PLAYERS.filter((p) =>
    (!state.pos.size || state.pos.has(p.pos)) && (!quick || quick.f(p)) && (!age || age.f(p.age)) && (!bud || (p.pay != null && bud.f(p.pay))) &&
    (!state.value || p.val === state.value) && (!state.role || p.role === state.role) && (!state.club || p.t === state.club) &&
    (!q || p.n.toLowerCase().includes(q) || (TEAM_BY.get(p.t)?.name ?? "").toLowerCase().includes(q) || p.t.toLowerCase() === q));
  const by = {
    imp: (a, b) => (b.imp ?? -1) - (a.imp ?? -1) || b.min - a.min,
    proj: (a, b) => (b.proj ?? -1) - (a.proj ?? -1) || (b.imp ?? -1) - (a.imp ?? -1),
    value: (a, b) => ((b.fair ?? 0) / (b.pay ?? 1e9)) * (b.imp ?? 0) - ((a.fair ?? 0) / (a.pay ?? 1e9)) * (a.imp ?? 0),
    young: (a, b) => a.age - b.age,
  }[state.sort];
  return list.sort(by);
}

// ---------------------------------------------------------------- views
function renderBoard(list) {
  const shown = list.slice(0, state.shown);
  $("#cards").innerHTML = shown.length ? shown.map(card).join("") : `<div class="empty">No players match. Try removing a filter.</div>`;
  $("#more").hidden = list.length <= state.shown;
  $("#board-count").textContent = `${list.length} of ${PLAYERS.length} players`;
  const bits = [state.pos.size ? [...state.pos].map((p) => POS_NAME[p] + "s").join(" + ") : null, state.club ? TEAM_BY.get(state.club)?.name : null].filter(Boolean);
  $("#board-title").textContent = bits.length ? bits.join(" · ") : "Scout board";
}

function renderMap(list) {
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
    <div class="mini"><span data-tip="Minutes-weighted squad level">${meter(t.imp)}</span><span data-tip="Bargain contracts in the squad">${t.bargains ? `★ ${t.bargains}` : ""}</span></div></div>`).join("");
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
  $("#club-detail").innerHTML = `<div class="board-head"><h1>${esc(t.name)}</h1><span class="muted">Most-used XI (4-3-3 by minutes). Ring colour = level now; fill = contract value (gold bargain, red premium).</span></div>
    <div class="xi">${s}</div>
    <h3 style="font-family:var(--head);font-size:22px;margin:18px 0 8px">${bargains.length ? `★ Bargains at ${esc(t.short)}` : "Full squad"}</h3>
    <div class="cards">${(bargains.length ? bargains : squad).map(card).join("")}</div>
    ${bargains.length ? `<h3 style="font-family:var(--head);font-size:22px;margin:18px 0 8px">Full squad</h3><div class="cards">${squad.filter((p) => p.val !== "Bargain").map(card).join("")}</div>` : ""}`;
}

function renderShortlist() {
  const list = SHORTLIST.map((id) => BY_ID.get(id)).filter(Boolean);
  $("#sl-count").textContent = list.length;
  $("#sl-cards").innerHTML = list.length ? list.map(card).join("") : `<div class="empty">Tap ☆ Save on any player to build a shortlist.</div>`;
  state.compare = state.compare.filter((id) => SHORTLIST.includes(id));
  if (!list.length) { $("#compare").innerHTML = ""; return; }
  if (!state.compare.length) state.compare = list.filter((p) => p.g !== "Goalkeeper").slice(0, 3).map((p) => p.id);
  const sel = state.compare.map((id) => BY_ID.get(id));
  const cols = ["#3ddc84", "#5cc8ff", "#f5c542"];
  $("#compare").innerHTML = `<div>${sel.length ? radarSVG(sel, { size: 300, labels: true, pad: 46 }) : ""}</div>
    <div class="keys"><b style="font-family:var(--head);font-size:20px">Compare shapes</b><span class="muted">Pick up to three of the same type (outfield or keeper).</span>
    ${list.map((p) => { const i = state.compare.indexOf(p.id); return `<button class="chip ${i >= 0 ? "is-on" : ""}" data-cmp="${p.id}" style="text-align:left">${i >= 0 ? `<i style="background:${cols[i]}"></i>` : ""}${esc(p.n)} · ${p.pos}</button>`; }).join("")}</div>`;
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
  if (p.proj != null) s += `Next season: most likely ${TIERS[tier(p.proj)].toLowerCase()}${tier(p.pLo) !== tier(p.pHi) ? ` (range ${TIERS[tier(p.pLo)].toLowerCase()} to ${TIERS[tier(p.pHi)].toLowerCase()})` : ""}.`;
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

function seasonsChart(p) {
  const h = p.hist.filter((d) => d.i != null);
  if (!h.length) return `<p class="muted">No earlier MLS seasons with 300+ minutes.</p>`;
  const W = 360, H = 160, years = [2021, 2022, 2023, 2024, 2025, 2026];
  const x = (s) => 44 + ((W - 64) * (s - 2021)) / 5, y = (v) => 10 + (H - 34) * (1 - v / 100);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  [[90, 100, "#f5c542"], [70, 90, "#3ddc84"], [40, 70, "#9bd3b2"], [20, 40, "#6f8a7c"], [0, 20, "#4a5a52"]].forEach(([a, b, c]) => {
    s += `<rect x="44" width="${W - 64}" y="${y(b)}" height="${y(a) - y(b)}" fill="${c}" opacity=".10"/>`;
  });
  [[95, "Elite"], [79, "Strong"], [55, "Solid"], [30, "Dev."], [10, "Weak"]].forEach(([v, l]) => { s += `<text x="40" y="${y(v) + 3}" text-anchor="end" fill="#8eaa9b" font-size="9">${l}</text>`; });
  years.forEach((yr) => { s += `<text x="${x(yr)}" y="${H - 6}" text-anchor="middle" fill="#8eaa9b" font-size="10">${yr}</text>`; });
  s += `<polyline fill="none" stroke="#dfeee6" stroke-width="1.5" points="${h.map((d) => `${x(d.s)},${y(d.i)}`).join(" ")}"/>`;
  h.forEach((d) => { s += `<circle cx="${x(d.s)}" cy="${y(d.i)}" r="${d.min >= 1800 ? 6 : d.min >= 900 ? 4.5 : 3}" fill="#3ddc84" stroke="#07110d" data-tip="${d.s} · ${esc(d.t)} · ${TIERS[tier(d.i)]} (${d.i}th percentile) · ${d.min.toLocaleString()} min"/>`; });
  return s + "</svg>";
}

function outlook(p) {
  if (p.proj == null) return `<p class="muted">Projections cover outfield players only.</p>`;
  const segs = [[0, 20, "#4a5a52"], [20, 40, "#6f8a7c"], [40, 70, "#9bd3b2"], [70, 90, "#3ddc84"], [90, 100, "#f5c542"]];
  return `<div class="tierscale">${segs.map(([a, b, c]) => `<div class="seg" style="left:${a}%;width:${b - a}%;background:${c};opacity:.55"></div>`).join("")}
    <div class="band" style="left:${p.pLo}%;width:${Math.max(2, p.pHi - p.pLo)}%" data-tip="80% likely range: ${TIERS[tier(p.pLo)]} to ${TIERS[tier(p.pHi)]}"></div>
    <div class="pt" style="left:${p.proj}%" data-tip="Most likely: ${TIERS[tier(p.proj)]} (${p.proj}th percentile)"></div>
    ${p.imp != null ? `<div class="now" style="left:${p.imp}%" data-tip="This season: ${TIERS[tier(p.imp)]}"></div>` : ""}</div>
    <div class="tierlabels"><span>Weak</span><span>Developing</span><span>Solid</span><span>Strong</span><span>Elite</span></div>
    <p class="hint" style="margin-top:8px">● this season · ▮ most likely next season · box = 80% likely range. Big seasons usually cool off a little, so the projection leans toward average.</p>`;
}

function payBars(p) {
  if (p.pay == null) return `<p class="muted">Not in the April 2026 MLSPA salary release.</p>`;
  const x = d3.scaleLog().domain([70000, 26000000]).range([0, 100]).clamp(true);
  return `<div class="paybars">
    <div class="row"><span>Paid</span><div><div class="bar" style="width:${x(p.pay)}%;background:${p.val === "Premium" ? "#ff6b5e" : "#9bd3b2"}" data-tip="Guaranteed pay ${money(p.pay)} (MLSPA, Apr 2026)"></div></div></div>
    <div class="row"><span>Plays like</span><div><div class="bar" style="width:${x(p.fair)}%;background:#f5c542" data-tip="Players with this production usually earn about ${money(p.fair)} (model)"></div></div></div>
    <div class="ticks"><span></span><div><span>Min</span><span>$400K</span><span>$1M</span><span>$3M</span><span>$10M+</span></div></div></div>
    <p class="hint" style="margin-top:8px">Paid ${PAY_WORDS[payBand(p.pay)]}; production like this usually earns ${PAY_WORDS[payBand(p.fair)]}.</p>`;
}

function openProfile(id) {
  const p = BY_ID.get(id); if (!p) return;
  const team = TEAM_BY.get(p.t), saved = SHORTLIST.includes(p.id);
  const skillRows = Object.entries(p.sk).map(([k, v]) => `<span>${esc(k)}</span><span data-tip="${v == null ? "n/a" : `Better than ${v}% of ${p.g.toLowerCase()}s`}">${meter(v)}</span><span class="w l${tier(v)}">${TIERS[tier(v)] ?? "n/a"}</span>`).join("");
  const comps = p.comps.map((c) => `<div class="comp" data-tip="Style similarity ${(c.sim * 100).toFixed(0)}%"><b>${esc(c.n)}</b>${c.s} · ${esc(c.t ?? "")}<div style="margin-top:6px">${meter(c.i)}</div><span class="muted">${TIERS[tier(c.i)] ?? ""} that season</span></div>`).join("");
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
        <h3 style="margin-top:16px">Overall</h3><div class="skill-rows"><span>Now</span><span>${meter(p.imp)}</span><span class="w l${tier(p.imp)}">${TIERS[tier(p.imp)] ?? "n/a"}</span></div></div>
      ${p.ga ? `<div class="box"><h3>Where he adds value</h3><p class="hint">Green adds goals for his team, red costs them, compared with an average ${POS_NAME[p.pos].toLowerCase()}.</p>${addsValuePitch(p)}</div>` : ""}
      <div class="box"><h3>Level by season</h3><p class="hint">Bigger dots = more minutes that season.</p>${seasonsChart(p)}</div>
      <div class="box"><h3>Next season outlook</h3>${outlook(p)}</div>
      <div class="box"><h3>Contract</h3>${payBars(p)}</div>
    </div>
    <div class="box" style="margin-top:16px"><h3>Plays like</h3><p class="hint">Closest playing styles in MLS since 2021 (same position), with how good they were that season.</p><div class="comps">${comps}</div></div>
    <details class="box" style="margin-top:16px"><summary style="cursor:pointer">For the numbers people</summary><p class="muted" style="margin:8px 0 0">${box} · ${p.min.toLocaleString()} minutes · pay ${money(p.pay)}, typical pay for this production ${money(p.fair)}</p></details>`;
  $("#drawer").hidden = false; $("#profile").scrollTop = 0;
  try { history.replaceState(null, "", `#p=${p.id}`); } catch { /* ignore */ }
}
function closeProfile() { $("#drawer").hidden = true; try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ } }

// ---------------------------------------------------------------- about
function renderAbout() {
  const r = META.model, pv = r.projection_validation, fs = r.fair_salary_model;
  $("#about").innerHTML = `<h1>How it works</h1>
  <p>Moneyball US Soccer turns MLS event data into a scouting board you can read at a glance. Every player in the ${META.season} season with at least ${META.min_minutes} minutes (${META.players} players, ${META.teams} clubs) gets a role, a skill shape, comparable players, a next-season outlook and a contract-value tag.</p>
  <h2>Levels instead of numbers</h2>
  <p>Each skill is a percentile against players in the same position group this season (defenders, midfielders, attackers, goalkeepers), shown as five levels: <b style="color:var(--lv5)">Elite</b> (top 10%), <b style="color:var(--lv4)">Strong</b> (top 30%), <b style="color:var(--lv3)">Solid</b> (middle), <b style="color:var(--lv2)">Developing</b> and Weak. Skills come from American Soccer Analysis <i>goals added</i> (g+), which credits every on-ball action with how much it changed the chance of scoring or conceding, plus expected goals and assists. "Now" is total goals added per 96 minutes.</p>
  <h2>The machine-learning models</h2>
  <ul>
    <li><b>Roles</b>: k-means clustering within each position on a 13-feature style profile (2021–${META.season}, 900+ minute seasons); clusters are named from their centroids, for example ball-playing centre-back vs stopper.</li>
    <li><b>Plays like</b>: cosine similarity on the same style profile, searching every MLS season since 2021.</li>
    <li><b>Next season</b>: ridge regression on minutes-weighted, multi-season goals added plus age and style. Tested on unseen seasons against simple baselines:</li>
  </ul>
  <table><tr><th>Test</th><th>Players</th><th>Model error</th><th>"Same as last season"</th><th>"Shrink to average"</th><th>Rank corr. (model)</th></tr>
    ${pv.folds.map((f) => `<tr><td>${f.test}</td><td>${f.n}</td><td><b>${f.mae_model}</b></td><td>${f.mae_same_as_last_season}</td><td>${f.mae_shrink_to_average}</td><td>${f.spearman_model}</td></tr>`).join("")}</table>
  <p class="note">Error = minutes-weighted mean absolute error in goals added per 96 minutes. The 80% range is calibrated on held-out errors (it contained ${Math.round(pv.interval_80_coverage_heldout * 100)}% of real outcomes). Next-season performance is noisy for everyone; the outlook is a guide, not a promise.</p>
  <ul><li><b>Contract value</b>: a gradient-boosted model (LightGBM) learns what MLS pays for a given level of production, age and position from ${fs.n.toLocaleString()} player-seasons (2021–${META.season}), using out-of-fold predictions grouped by player (R² ${fs.r2_log_oof} on log pay; typical miss ×${fs.median_abs_ratio_error}). <span class="vtag Bargain">Bargain</span> = paid less than half of that and at least solid; <span class="vtag Premium">Premium</span> = paid more than twice that and not elite. ★ Moneyball pick = bargain expected to stay at least solid next season.</li></ul>
  <h2>Data</h2>
  <p>Player data from the <a href="https://www.americansocceranalysis.com/">American Soccer Analysis</a> public API (xG, xPass, goals added; seasons 2021–${META.season}, ${META.season} season to date). Salaries are guaranteed compensation from the MLS Players Association releases (latest: ${META.salary_release}), as provided by ASA. 30 clubs, including San Diego FC.</p>
  <h2>Know before you use it</h2>
  <ul><li>Event data cannot see off-ball work, pressing intensity, character or injuries. Watch the player.</li>
    <li>Small samples (one hollow dot) swing a lot. Goalkeepers have no next-season projection yet.</li>
    <li>Salary tags do not know about transfer fees, allocation money, roster designations or how a player was acquired.</li></ul>
  <p class="note">Built by Hendro Setyawan. Code: <a href="https://github.com/hendrosetyawan/moneyball_us_soccer">github.com/hendrosetyawan/moneyball_us_soccer</a>. Not affiliated with MLS, the MLSPA or American Soccer Analysis.</p>`;
}

// ---------------------------------------------------------------- render loop
function currentView() { return $(".tab.is-on").dataset.view; }
function render() {
  const list = filtered(); const v = currentView();
  if (v === "board") renderBoard(list);
  if (v === "map") renderMap(list);
  if (v === "clubs") renderClubs();
  if (v === "shortlist") renderShortlist();
  $("#sl-count").textContent = SHORTLIST.length;
}
function setView(v) {
  $$(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("is-on", s.id === `view-${v}`));
  $("#filters").style.display = v === "about" ? "none" : "";
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
  chipRow($("#quick"), QUICK, "quick"); chipRow($("#age"), AGES, "age"); chipRow($("#budget"), BUDGETS, "budget");
  chipRow($("#value"), VALUES.map((v) => ({ k: v, label: v, gold: v === "Bargain" })), "value");
  buildRoleChips(); renderAbout();
  if (matchMedia("(max-width: 900px)").matches) $("#more-filters").open = false;

  $(".tabs").onclick = (e) => { const t = e.target.closest(".tab"); if (t) setView(t.dataset.view); };
  $("#search").oninput = (e) => { state.q = e.target.value; state.shown = 48; render(); };
  $("#club").onchange = (e) => { state.club = e.target.value; state.shown = 48; render(); };
  $("#sort").onchange = (e) => { state.sort = e.target.value; render(); };
  $("#more").onclick = () => { state.shown += 48; render(); };
  $("#reset").onclick = () => {
    Object.assign(state, { pos: new Set(), quick: null, age: null, budget: null, value: null, role: null, club: "", q: "", sort: "imp", shown: 48 });
    $("#search").value = ""; $("#club").value = ""; $("#sort").value = "imp"; buildRoleChips(); syncChips(); render();
  };
  document.addEventListener("click", (e) => {
    const save = e.target.closest("[data-save]"); if (save) { e.stopPropagation(); toggleSave(save.dataset.save); return; }
    if (e.target.closest("[data-close]")) { closeProfile(); return; }
    const sim = e.target.closest("[data-similar]");
    if (sim) { const p = BY_ID.get(sim.dataset.similar); closeProfile(); Object.assign(state, { pos: new Set([p.pos]), role: p.role, quick: null, club: "", shown: 48 }); buildRoleChips(); syncChips(); setView("board"); return; }
    const cmp = e.target.closest("[data-cmp]");
    if (cmp) {
      const id = cmp.dataset.cmp, p = BY_ID.get(id);
      if (state.compare.includes(id)) state.compare = state.compare.filter((x) => x !== id);
      else { const g0 = state.compare.length ? BY_ID.get(state.compare[0]).g === "Goalkeeper" : null; if (g0 !== null && g0 !== (p.g === "Goalkeeper")) state.compare = []; state.compare = [...state.compare, id].slice(-3); }
      renderShortlist(); return;
    }
    const club = e.target.closest("[data-club]"); if (club) { state.club = state.club === club.dataset.club ? "" : club.dataset.club; $("#club").value = state.club; render(); return; }
    const hit = e.target.closest(".card, .tok, circle[data-id]"); if (hit) openProfile(hit.dataset.id);
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
  const m = location.hash.match(/p=([\w-]+)/); if (m) openProfile(m[1]);
}
init();
