"""Join the raw ASA tables into one player-season table: data/player_seasons.csv (MLS), plus
data/scout_asa_seasons.csv for the scouting leagues with the same metrics (USL Championship, USL League One,
MLS NEXT Pro; no salaries).

One row per player and season (MLS 2015-2026). Rates are per 96 minutes (ASA's convention:
90 minutes plus typical stoppage time). Goals added (g+) values are "above average"
for the player's position, as published by ASA.
"""
import json
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "data" / "raw", ROOT / "data"
SEASONS = range(2015, 2027)
ACTIONS = ["Dribbling", "Fouling", "Interrupting", "Passing", "Receiving", "Shooting"]
GK_ACTIONS = ["Claiming", "Fielding", "Handling", "Passing", "Shotstopping", "Sweeping"]
GROUP = {"CB": "Defender", "FB": "Defender", "DM": "Midfielder", "CM": "Midfielder", "AM": "Midfielder",
         "W": "Attacker", "ST": "Attacker", "GK": "Goalkeeper"}

SCOUT_LEAGUES = {"uslc": ("USL Championship", 2017), "usl1": ("USL League One", 2019), "mlsnp": ("MLS NEXT Pro", 2022)}
_raw = [RAW]
load = lambda name: json.loads((_raw[0] / f"{name}.json").read_text())
first = lambda v: v[0] if isinstance(v, list) else v


def ga_wide(rows, actions, prefix):
    out = []
    for r in rows:
        d = {"player_id": r["player_id"], "minutes_ga": r["minutes_played"]}
        acts = {a["action_type"]: a for a in r["data"]}
        for a in actions:
            d[f"{prefix}{a.lower()}"] = acts.get(a, {}).get("goals_added_above_avg", 0.0)
            d[f"n_{a.lower()}"] = acts.get(a, {}).get("count_actions", 0)
        out.append(d)
    return pd.DataFrame(out)


def season_table(s):
    xg = pd.DataFrame(load(f"xgoals_{s}"))
    xg["team_id"] = xg.team_id.map(first)
    xp = pd.DataFrame(load(f"xpass_{s}"))[["player_id", "attempted_passes", "pass_completion_percentage", "xpass_completion_percentage",
                                             "passes_completed_over_expected_p100", "avg_distance_yds", "avg_vertical_distance_yds",
                                             "share_team_touches", "count_games"]]
    ga = ga_wide(load(f"goals_added_{s}"), ACTIONS, "ga_")
    df = xg.merge(xp, on="player_id", how="left").merge(ga, on="player_id", how="left")
    gk = ga_wide(load(f"gk_goals_added_{s}"), GK_ACTIONS, "gk_")
    gkx = pd.DataFrame(load(f"gk_xgoals_{s}"))[["player_id", "shots_faced", "goals_conceded", "saves", "xgoals_gk_faced", "goals_minus_xgoals_gk"]]
    gk = gk.merge(gkx, on="player_id", how="left")
    gk = gk.rename(columns={"gk_passing": "gk_passing_ga", "n_passing": "n_gk_passing"})
    df = df.merge(gk, on="player_id", how="left", suffixes=("", "_gk"))
    # goalkeepers are missing from the outfield xgoals table in some seasons: add them
    gk_only = gk[~gk.player_id.isin(df.player_id)]
    if len(gk_only):
        raw = pd.DataFrame(load(f"gk_xgoals_{s}"))[["player_id", "team_id", "minutes_played"]]
        raw["team_id"] = raw.team_id.map(first)
        add = raw[raw.player_id.isin(gk_only.player_id)].merge(gk_only, on="player_id")
        add["general_position"] = "GK"
        df = pd.concat([df, add], ignore_index=True)
    df["season"] = s
    return df


def salaries():
    rows = []
    for s in SEASONS:
        sal = pd.DataFrame(load(f"salaries_{s}"))
        sal = sal.sort_values("mlspa_release").groupby("player_id").tail(1)  # latest release in the season
        rows.append(sal.assign(season=s)[["player_id", "season", "base_salary", "guaranteed_compensation", "mlspa_release"]])
    return pd.concat(rows)


def finish(df):
    """shared columns: names, position group, age, height, per-96 rates and total goals added"""
    players = pd.DataFrame(load("players"))
    for c in ["height_ft", "height_in", "primary_general_position"]:
        if c not in players: players[c] = np.nan
    players = players[["player_id", "player_name", "birth_date", "nationality", "height_ft", "height_in", "primary_general_position"]].drop_duplicates("player_id")
    teams = pd.DataFrame(load("teams"))[["team_id", "team_name", "team_short_name", "team_abbreviation"]]
    df = df.merge(players, on="player_id", how="left").merge(teams, on="team_id", how="left")

    df["general_position"] = df.general_position.fillna(df.primary_general_position)
    df["group"] = df.general_position.map(GROUP)
    born = pd.to_datetime(df.birth_date, errors="coerce")
    df["age"] = ((pd.to_datetime(df.season.astype(str) + "-07-01") - born).dt.days / 365.25).round(1)
    df["height_cm"] = ((df.height_ft * 12 + df.height_in) * 2.54).round(0)
    m96 = df.minutes_played / 96
    for c in ["xgoals", "xassists", "key_passes", "shots", "goals", "primary_assists"]:
        df[f"{c}_p96"] = df[c] / m96
    for a in ACTIONS:
        df[f"ga_{a.lower()}_p96"] = df[f"ga_{a.lower()}"] / m96
    gk_cols = [f"gk_{a.lower()}" if a != "Passing" else "gk_passing_ga" for a in GK_ACTIONS]
    for c in gk_cols:
        df[f"{c}_p96"] = df[c] / m96
    outfield = df.group != "Goalkeeper"
    df["gplus_p96"] = np.where(outfield, df[[f"ga_{a.lower()}_p96" for a in ACTIONS]].sum(axis=1),
                               df[[f"{c}_p96" for c in gk_cols]].sum(axis=1))
    return df[df.group.notna() & (df.minutes_played > 0)]


def scout_leagues():
    out = []
    for lg, (name, first_season) in SCOUT_LEAGUES.items():
        _raw[0] = RAW / "asa" / lg
        rows = pd.concat([season_table(s) for s in range(first_season, 2027)], ignore_index=True)
        rows = finish(rows).assign(league=lg, league_name=name)
        out.append(rows)
        print(name, len(rows), "player-seasons")
    _raw[0] = RAW
    return pd.concat(out, ignore_index=True)


if __name__ == "__main__":
    df = finish(pd.concat([season_table(s) for s in SEASONS], ignore_index=True))
    df = df.merge(salaries(), on=["player_id", "season"], how="left")
    df.to_csv(OUT / "player_seasons.csv", index=False)
    scout_leagues().to_csv(OUT / "scout_asa_seasons.csv", index=False)
    cur = df[df.season == 2026]
    print(len(df), "player-seasons;", len(cur), "in 2026 across", cur.team_id.nunique(), "teams")
    print(df.groupby("season").agg(n=("player_id", "size"), salary=("guaranteed_compensation", lambda s: s.notna().mean()), age=("age", lambda s: s.notna().mean())).round(2))
    print(cur.group.value_counts())
