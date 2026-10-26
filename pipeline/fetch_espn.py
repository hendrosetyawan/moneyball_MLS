"""Fetch player seasons for the Americas scouting pool from ESPN's public soccer data into data/raw/espn/ (cached).

For every league and season: the athletes who appeared, their bio (birth date, citizenship, position, height),
club, and season statistics summed over the regular phases only (Apertura + Clausura, regular season, first stage);
play-in and playoff games are left out so a minute means the same in every league. National-team competitions
(World Cup 2026, Gold Cup, Nations League, qualifiers, Copa America) add caps, minutes and goals.

The endpoints are public but undocumented; responses are cached and requested at a low rate.
Usage: python3 pipeline/fetch_espn.py [--refresh] [league ...]
"""
import json, re, sys, time, threading, urllib.request
import concurrent.futures as cf
from pathlib import Path

CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues"
SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
RAW = Path(__file__).resolve().parents[1] / "data" / "raw" / "espn"
SEASONS = [2023, 2024, 2025, 2026]
WORKERS = 6

# slug: (name, country, region, tier, split season i.e. ESPN season s = s/s+1)
# Leagues without published player statistics (Liga de Expansión MX, Costa Rica, Honduras, Guatemala, El Salvador,
# Uruguay, Venezuela, Bolivia) are left out; their players appear through national-team competitions.
# USL comes from American Soccer Analysis instead (same goals-added metrics as MLS).
LEAGUES = {
    "usa.1": ("MLS", "USA", "MLS", 1, False),
    "mex.1": ("Liga MX", "Mexico", "Mexico", 1, True),
    "bra.1": ("Brasileirão Série A", "Brazil", "South America", 1, False),
    "bra.2": ("Brasileirão Série B", "Brazil", "South America", 2, False),
    "arg.1": ("Liga Profesional (Argentina)", "Argentina", "South America", 1, False),
    "arg.2": ("Primera Nacional (Argentina)", "Argentina", "South America", 2, False),
    "col.1": ("Primera A (Colombia)", "Colombia", "South America", 1, False),
    "chi.1": ("Primera División (Chile)", "Chile", "South America", 1, False),
    "ecu.1": ("LigaPro (Ecuador)", "Ecuador", "South America", 1, False),
    "par.1": ("Primera División (Paraguay)", "Paraguay", "South America", 1, False),
    "per.1": ("Liga 1 (Peru)", "Peru", "South America", 1, False),
}
NATIONAL = {  # slug: (name, seasons)
    "fifa.world": ("FIFA World Cup 2026", [2026]),
    "concacaf.gold": ("Concacaf Gold Cup 2025", [2025]),
    "concacaf.nations.league": ("Concacaf Nations League", [2024, 2026]),
    "fifa.worldq.concacaf": ("World Cup qualifying (Concacaf)", [2024]),
    "fifa.worldq.conmebol": ("World Cup qualifying (CONMEBOL)", [2023]),
    "conmebol.america": ("Copa América 2024", [2024]),
}
# stage names that are not part of the regular league phase
NOT_REGULAR = re.compile(r"final|semi|quarter|place|seed|playoff|play-off|round of|reclass|reducido|relegation|triangular|quadrangular|campe|champion|all-star|combined|libertadores", re.I)
REFRESH = "--refresh" in sys.argv
_lock, _last = threading.Lock(), [0.0]


def get(url, tries=4):
    for k in range(tries):
        with _lock:  # global pacing: at most ~20 requests per second across threads
            wait = _last[0] + 0.05 - time.time()
            if wait > 0: time.sleep(wait)
            _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (moneyball_MLS educational scouting project)"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(2 * (k + 1))
        except Exception:
            time.sleep(2 * (k + 1))
    return None


ref_id = lambda ref, kind: (m := re.search(rf"/{kind}/(\d+)", ref or "")) and m.group(1)


def list_refs(url):
    out, page = [], 1
    while True:
        d = get(f"{url}{'&' if '?' in url else '?'}limit=1000&page={page}")
        if not d: break
        out += [i["$ref"] for i in d.get("items", [])]
        if page >= d.get("pageCount", 1): break
        page += 1
    return out


def regular_types(lg, s):
    d = get(f"{CORE}/{lg}/seasons/{s}/types")
    if not d: return []
    out = []
    for r in d["items"]:
        t = get(r["$ref"]) or {}
        if t.get("name") and not NOT_REGULAR.search(t["name"]): out.append((ref_id(r["$ref"], "types"), t["name"]))
    return out


def stats(lg, s, t, aid):
    d = get(f"{CORE}/{lg}/seasons/{s}/types/{t}/athletes/{aid}/statistics")
    if not d or "splits" not in d: return None
    return {x["name"]: x["value"] for c in d["splits"]["categories"] for x in c["stats"] if x.get("value") is not None}


def bio(lg, s, aid):
    a = get(f"{CORE}/{lg}/seasons/{s}/athletes/{aid}") or {}
    pos = a.get("position") or {}
    return {"id": aid, "n": a.get("displayName"), "dob": (a.get("dateOfBirth") or "")[:10] or None, "cit": a.get("citizenship"),
            "pos": pos.get("name") or (get(pos["$ref"]) or {}).get("name") if pos else None,
            "h": a.get("height"), "team": ref_id((a.get("team") or {}).get("$ref"), "teams")}


def fetch_season(lg, s, types_override=None):
    out = RAW / lg / f"{s}.json"
    if out.exists() and not REFRESH: return "cached"
    types = types_override or regular_types(lg, s)
    if not types: return "no stages"
    refs = list_refs(f"{CORE}/{lg}/seasons/{s}/athletes")
    ids = sorted({ref_id(r, "athletes") for r in refs} - {None})
    teams = {}
    for tr in list_refs(f"{CORE}/{lg}/seasons/{s}/teams"):
        t = get(tr) or {}
        if t.get("id"): teams[t["id"]] = {"name": t.get("displayName"), "short": t.get("shortDisplayName"), "abbr": t.get("abbreviation")}

    def one(aid):
        per = {name: st for tid, name in types if (st := stats(lg, s, tid, aid))}
        if not per or not any(v.get("minutes", 0) or v.get("appearances", 0) for v in per.values()): return None
        return {**bio(lg, s, aid), "stages": per}

    with cf.ThreadPoolExecutor(WORKERS) as ex:
        rows = [r for r in ex.map(one, ids) if r]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"league": lg, "season": s, "stages": [n for _, n in types], "teams": teams, "athletes": rows}, ensure_ascii=False))
    return f"{len(rows)} players with stats of {len(ids)} listed"


if __name__ == "__main__":
    pick = [a for a in sys.argv[1:] if not a.startswith("--")]
    for lg in (pick or list(LEAGUES) + list(NATIONAL)):
        seasons = NATIONAL[lg][1] if lg in NATIONAL else SEASONS
        for s in seasons:
            t0 = time.time()
            # national-team tournaments: every stage counts (group + knockout)
            ov = None
            if lg in NATIONAL:
                d = get(f"{CORE}/{lg}/seasons/{s}/types")
                ov = [(ref_id(r["$ref"], "types"), (get(r["$ref"]) or {}).get("name") or "stage") for r in (d or {}).get("items", [])]
            print(f"{lg} {s}: {fetch_season(lg, s, ov)} ({time.time() - t0:.0f}s)", flush=True)
