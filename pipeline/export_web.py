"""Export compact JSON for the scouting app: website/data/players.json, teams.json, meta.json."""
import json
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA, WEB = ROOT / "data", ROOT / "website" / "data"
CUR, MIN_SHOW = 2026, 300
WEB.mkdir(parents=True, exist_ok=True)

d = pd.read_csv(DATA / "player_seasons.csv")
m = pd.read_json(DATA / "model_outputs.json")
x = d.merge(m, on=["player_id", "season"], how="left")
names = dict(zip(d.player_id, d.player_name))
teams_by_ps = dict(zip(zip(d.player_id, d.season), d.team_abbreviation))
cur = x[(x.season == CUR) & (x.minutes_played >= MIN_SHOW)].copy()

OUT_SKILLS = ["Finishing", "Goal threat", "Chance creation", "Passing", "Ball carrying", "Movement", "Defending", "Discipline"]
GK_SKILLS = ["Shot stopping", "Claiming crosses", "Handling", "Distribution", "Sweeping", "Positioning"]
ACTIONS = ["shooting", "passing", "dribbling", "receiving", "interrupting", "fouling"]
r0 = lambda v: None if pd.isna(v) else int(round(v))
r2 = lambda v, k=3: None if pd.isna(v) else round(float(v), k)


history = x[x.minutes_played >= MIN_SHOW][["player_id", "season", "pct_Impact", "minutes_played", "team_abbreviation"]]
hist = {pid: [{"s": int(s), "i": r0(i), "min": int(mn), "t": t} for s, i, mn, t in zip(g.season, g.pct_Impact, g.minutes_played, g.team_abbreviation)]
        for pid, g in history.sort_values("season").groupby("player_id")}

players = []
for _, r in cur.iterrows():
    gk = r.group == "Goalkeeper"
    skills = {k: r0(r[f"pct_{k}"]) for k in (GK_SKILLS if gk else OUT_SKILLS)}
    comps = []
    for c in (r.comps if isinstance(r.comps, list) else []):
        cr = x[(x.player_id == c["id"]) & (x.season == c["season"])]
        comps.append({"id": c["id"], "n": names.get(c["id"]), "s": c["season"], "t": teams_by_ps.get((c["id"], c["season"])),
                      "sim": c["sim"], "i": r0(cr.pct_Impact.iloc[0]) if len(cr) else None})
    players.append({
        "id": r.player_id, "n": r.player_name, "t": r.team_abbreviation, "pos": r.general_position, "g": r.group, "role": r.role,
        "age": r2(r.age, 1), "nat": r.nationality if isinstance(r.nationality, str) else None, "cm": r0(r.height_cm),
        "min": int(r.minutes_played), "gp": r0(r.count_games),
        "pay": r0(r.guaranteed_compensation), "fair": r0(r.fair_salary), "val": r.value_tag,
        "imp": r0(r.pct_Impact), "proj": r0(r.pct_proj_mid), "pLo": r0(r.pct_proj_lo), "pHi": r0(r.pct_proj_hi),
        "sk": skills,
        "ga": None if gk else {a: r2(r[f"ga_{a}_p96"]) for a in ACTIONS},
        "box": {"goals": r0(r.goals), "assists": r0(r.primary_assists), "xg": r2(r.xgoals, 1), "xa": r2(r.xassists, 1), "gplus": r2(r.gplus_p96)} if not gk
               else {"saves": r0(r.saves), "conceded": r0(r.goals_conceded), "prevented": r2(-r.goals_minus_xgoals_gk, 1), "gplus": r2(r.gplus_p96)},
        "comps": comps, "hist": hist.get(r.player_id, []),
    })

# ---------------------------------------------------------------- teams
t = pd.read_json(ROOT / "data" / "raw" / "teams.json")
abbrs = sorted(cur.team_abbreviation.unique())
teams = []
for a in abbrs:
    s = cur[cur.team_abbreviation == a]
    row = t[t.team_abbreviation == a].iloc[0]
    teams.append({"a": a, "name": row.team_name, "short": row.team_short_name, "n": int(len(s)),
                  "payroll": r0(s.guaranteed_compensation.sum()), "bargains": int((s.value_tag == "Bargain").sum()),
                  "age": r2((s.age * s.minutes_played).sum() / s.minutes_played.sum(), 1),
                  "imp": r0((s.pct_Impact * s.minutes_played).sum() / s.minutes_played.sum())})

report = json.loads((DATA / "model_report.json").read_text())
meta = {"season": CUR, "players": len(players), "teams": len(teams), "min_minutes": MIN_SHOW,
        "salary_release": str(d[d.season == CUR].mlspa_release.dropna().max()), "data_through": "ASA API, fetched 2026-10-10",
        "model": report}
(WEB / "players.json").write_text(json.dumps(players, separators=(",", ":"), ensure_ascii=False))
(WEB / "teams.json").write_text(json.dumps(teams, separators=(",", ":"), ensure_ascii=False))
(WEB / "meta.json").write_text(json.dumps(meta, indent=1))
print(len(players), "players,", len(teams), "teams;", round((WEB / "players.json").stat().st_size / 1024), "KB")
