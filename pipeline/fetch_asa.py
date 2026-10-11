"""Fetch MLS player data from the American Soccer Analysis public API into data/raw/ (cached, not committed).

Seasons 2021-2026, regular season + playoffs combined, one row per player-season (not split by team).
Usage: python3 pipeline/fetch_asa.py [--refresh]
"""
import json, sys, time, urllib.parse, urllib.request
from pathlib import Path

API = "https://app.americansocceranalysis.com/api/v1/mls"
RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
SEASONS = list(range(2021, 2027))
REFRESH = "--refresh" in sys.argv


def get(path, **params):
    q = urllib.parse.urlencode(params)
    url = f"{API}/{path}" + (f"?{q}" if q else "")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "moneyball_us_soccer (educational)"}), timeout=120) as r:
                return json.load(r)
        except Exception as e:  # rate limit or transient error: back off
            wait = 5 * (attempt + 1)
            print(f"  retry {attempt + 1} in {wait}s: {e}")
            time.sleep(wait)
    raise SystemExit(f"failed: {url}")


def save(name, fn):
    out = RAW / f"{name}.json"
    if out.exists() and not REFRESH:
        print("cached", out.name); return
    data = fn(); out.write_text(json.dumps(data)); print(f"saved {out.name} ({len(data)} rows)")
    time.sleep(1.0)


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    save("teams", lambda: get("teams"))
    save("players", lambda: get("players"))
    for s in SEASONS:
        common = dict(season_name=s, split_by_seasons="true")
        save(f"xgoals_{s}", lambda: get("players/xgoals", **common))
        save(f"xpass_{s}", lambda: get("players/xpass", **common))
        save(f"goals_added_{s}", lambda: get("players/goals-added", **common))
        save(f"gk_goals_added_{s}", lambda: get("goalkeepers/goals-added", **common))
        save(f"gk_xgoals_{s}", lambda: get("goalkeepers/xgoals", **common))
        save(f"salaries_{s}", lambda: get("players/salaries", season_name=s))
