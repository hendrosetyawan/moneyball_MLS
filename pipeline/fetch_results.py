"""Fetch club match results 2023-2026 from ESPN's public soccer data into data/raw/espn_results/ (cached).

League strength is measured from results: every domestic match of the covered leagues, plus the competitions where
clubs from different leagues meet (Leagues Cup, Campeones Cup, Concacaf Champions Cup, Copa Libertadores,
Copa Sudamericana, FIFA Club World Cup 2025).
Usage: python3 pipeline/fetch_results.py [--refresh]
"""
import json, sys
import concurrent.futures as cf
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_espn import CORE, LEAGUES, SEASONS, get, list_refs, ref_id  # noqa: E402

SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
OUT = RAW / "espn_results"
CUPS = ["concacaf.leagues.cup", "campeones.cup", "concacaf.champions", "conmebol.libertadores", "conmebol.sudamericana", "fifa.cwc"]
REFRESH = "--refresh" in sys.argv


def schedule(comp, team, season):
    d = get(f"{SITE}/{comp}/teams/{team}/schedule?season={season}") or {}
    out = []
    for e in d.get("events", []):
        c = (e.get("competitions") or [{}])[0]
        if not c.get("status", {}).get("type", {}).get("completed"): continue
        t = c.get("competitors", [])
        if len(t) != 2: continue
        sc = lambda x: (x.get("score") or {}).get("value") if isinstance(x.get("score"), dict) else x.get("score")
        h, a = (t[0], t[1]) if t[0].get("homeAway") == "home" else (t[1], t[0])
        if sc(h) is None or sc(a) is None: continue
        out.append({"id": e["id"], "date": e["date"][:10], "comp": comp, "season": season, "home": h["team"]["id"], "away": a["team"]["id"],
                    "hn": h["team"].get("displayName"), "an": a["team"].get("displayName"), "hg": float(sc(h)), "ag": float(sc(a)),
                    "neutral": bool(c.get("neutralSite"))})
    return out


def fetch(comp, season, teams):
    f = OUT / comp / f"{season}.json"
    if f.exists() and not REFRESH: return "cached"
    with cf.ThreadPoolExecutor(6) as ex:
        games = {g["id"]: g for rows in ex.map(lambda t: schedule(comp, t, season), teams) for g in rows}
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(list(games.values()), ensure_ascii=False))
    return f"{len(games)} matches from {len(teams)} teams"


if __name__ == "__main__":
    for lg in LEAGUES:
        for s in SEASONS:
            p = RAW / "espn" / lg / f"{s}.json"
            if not p.exists(): continue
            teams = list(json.loads(p.read_text())["teams"])
            print(lg, s, fetch(lg, s, teams), flush=True)
    for comp in CUPS:
        for s in SEASONS:
            teams = [ref_id(r, "teams") for r in list_refs(f"{CORE}/{comp}/seasons/{s}/teams")]
            print(comp, s, fetch(comp, s, [t for t in teams if t]), flush=True)
