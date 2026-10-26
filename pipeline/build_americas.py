"""Build the Americas scouting tables from the raw ESPN, StatsCrew (CPL) and ASA files.

- data/scout_espn_seasons.csv  one row per ESPN athlete, league and season: regular-phase totals, per-90 rates,
                               data tier (rich = passing and defending recorded, basic = box score only)
- data/scout_cpl_seasons.csv   Canadian Premier League player seasons (basic box score)
- data/national_caps.csv       national-team appearances in 2023-2026 competitions (World Cup 2026, Gold Cup 2025,
                               Nations League, World Cup qualifying, Copa America 2024), Americas nations only
- data/id_links.csv            ESPN athlete id <-> ASA player id (MLS, USL, MLS NEXT Pro) by name and birth date
"""
import json, re, sys, unicodedata
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "data" / "raw", ROOT / "data"
sys.path.insert(0, str(Path(__file__).parent))
from fetch_espn import LEAGUES, NATIONAL  # noqa: E402

AMERICAS = {"United States", "USA", "Canada", "Mexico", "Costa Rica", "Panama", "Honduras", "Jamaica", "El Salvador", "Guatemala", "Haiti",
            "Curaçao", "Curacao", "Trinidad and Tobago", "Nicaragua", "Suriname", "Cuba", "Dominican Republic", "Guadeloupe", "Martinique",
            "Bermuda", "Puerto Rico", "Belize", "Grenada", "Guyana", "Saint Kitts and Nevis", "Antigua and Barbuda", "Barbados",
            "Brazil", "Argentina", "Uruguay", "Colombia", "Chile", "Ecuador", "Paraguay", "Peru", "Venezuela", "Bolivia"}
COUNT = ["minutes", "appearances", "starts", "subIns", "totalGoals", "goalAssists", "secondAssists", "totalShots", "shotsOnTarget", "foulsCommitted", "foulsSuffered",
         "yellowCards", "redCards", "offsides", "goalDifference", "goalsConceded", "totalPasses", "accuratePasses", "totalLongBalls", "accurateLongBalls",
         "totalCrosses", "accurateCrosses", "shotAssists", "totalThroughBalls", "effectiveTackles", "totalTackles", "interceptions", "totalClearance",
         "blockedShots", "saves", "shotsFaced", "cleanSheet", "touches"]
GROUP = {"Goalkeeper": "Goalkeeper", "Defender": "Defender", "Midfielder": "Midfielder", "Forward": "Attacker"}
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^a-z ]", "", unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower())).strip()


def espn_rows(slug, league_name):
    rows = []
    for f in sorted((RAW / "espn" / slug).glob("*.json")):
        d = json.loads(f.read_text())
        for a in d["athletes"]:
            tot = {c: sum(st.get(c, 0) or 0 for st in a["stages"].values()) for c in COUNT}
            if tot["minutes"] <= 0: continue
            team = d["teams"].get(a.get("team") or "", {})
            rows.append({"eid": a["id"], "name": a["n"], "dob": a.get("dob"), "nationality": a.get("cit"), "pos_espn": a.get("pos"),
                         "height_cm": round(a["h"] * 2.54) if a.get("h") else None, "league": slug, "league_name": league_name, "season": d["season"],
                         "team": team.get("name"), "team_short": team.get("short") or team.get("name"), **tot})
    return rows


BOX = ["totalGoals_p90", "primaryAssists_p90", "totalShots_p90", "shotsOnTarget_p90", "foulsCommitted_p90", "foulsSuffered_p90", "yellowCards_p90", "redCards_p90"]


def per90(df):
    m90 = df.minutes / 90
    # MLS on ESPN credits secondary assists too: primary assists = assists - secondary assists, for every league
    df["primaryAssists"] = (df.goalAssists - df.get("secondAssists", 0).fillna(0)).clip(lower=0) if "secondAssists" in df else df.goalAssists
    df["primaryAssists_p90"] = df.primaryAssists / m90
    for c in ["totalGoals", "goalAssists", "totalShots", "shotsOnTarget", "foulsCommitted", "foulsSuffered", "yellowCards", "redCards", "offsides",
              "goalDifference", "goalsConceded", "totalPasses", "accuratePasses", "totalLongBalls", "accurateLongBalls", "totalCrosses", "accurateCrosses",
              "shotAssists", "totalThroughBalls", "effectiveTackles", "interceptions", "totalClearance", "blockedShots", "saves"]:
        if c in df: df[f"{c}_p90"] = df[c] / m90
    df["sot_rate"] = np.where(df.totalShots > 0, df.shotsOnTarget / df.totalShots.clip(lower=1), np.nan)
    df["start_share"] = df.starts / df.appearances.clip(lower=1)
    df["min_per_app"] = df.minutes / df.appearances.clip(lower=1)
    if "totalPasses" in df:
        df["pass_pct"] = np.where(df.totalPasses > 0, df.accuratePasses / df.totalPasses.clip(lower=1), np.nan)
        df["long_pct"] = np.where(df.totalLongBalls > 0, df.accurateLongBalls / df.totalLongBalls.clip(lower=1), np.nan)
    return df


def mark_unrecorded(df, cols, key=("league", "season")):
    """a stat counts as recorded in a league-season when its mean (900+ minute outfield players) is at least 25% of the MLS mean;
    otherwise ESPN did not collect it there and the values become blank instead of zero"""
    reg = df[(df.minutes >= 900) & (df.group != "Goalkeeper")]
    ref = reg[reg.league == "usa.1"][cols].mean()
    means = reg.groupby(list(key))[cols].mean()
    ok = means.ge(0.25 * ref)
    for c in cols:
        bad = {k for k, v in ok[c].items() if not v}
        if bad:
            m = df.set_index(list(key)).index.isin(list(bad))
            df.loc[m, c] = np.nan
    return df, ok


def build_espn():
    df = pd.DataFrame([r for slug, meta in LEAGUES.items() for r in espn_rows(slug, meta[0])])
    df["group"] = df.pos_espn.map(GROUP)
    df = df[df.group.notna()].copy()
    born = pd.to_datetime(df.dob, errors="coerce")
    split = df.league.map(lambda s: LEAGUES[s][4])
    mid = pd.to_datetime(np.where(split, (df.season + 1).astype(str) + "-01-01", df.season.astype(str) + "-07-01"))  # middle of the season
    df["age"] = ((mid - born).dt.days / 365.25).round(1)
    df = per90(df)
    df, _ = mark_unrecorded(df, BOX)
    # a league-season counts as "rich" when its players have passing and defending recorded
    rich_share = df[df.minutes >= 450].assign(r=lambda x: x.totalPasses > 0).groupby(["league", "season"]).r.mean()
    df["tier"] = np.where(df.set_index(["league", "season"]).index.map(rich_share).fillna(0).values >= 0.6, np.where(df.totalPasses > 0, "rich", "basic"), "basic")
    df["region"] = df.league.map(lambda s: LEAGUES[s][2])
    df["country"] = df.league.map(lambda s: LEAGUES[s][1])
    df["league_tier"] = df.league.map(lambda s: LEAGUES[s][3])
    # a player who changed clubs inside the league appears once per league-season (ESPN totals are per league)
    df = df.sort_values("minutes", ascending=False).drop_duplicates(["eid", "league", "season"])
    return df


def build_cpl():
    rows = []
    for f in sorted((RAW / "cpl").glob("*.json")):
        d = json.loads(f.read_text())
        for t in d["teams"]:
            club = re.sub(r"^\d{4}\s+", "", (t["title"] or "").split(" Division")[0]).strip()
            for p in t["players"]:
                num = lambda k: pd.to_numeric(p.get(k, ""), errors="coerce")
                r = {"name": p["Player"], "pos_raw": p["Pos"], "season": d["season"], "team": club, "team_short": club,
                     "appearances": num("GP"), "starts": num("GS"), "minutes": num("Min"), "totalGoals": num("G"), "goalAssists": num("A"), "secondAssists": 0,
                     "foulsCommitted": num("FC"), "foulsSuffered": num("FS"), "yellowCards": num("Y"), "redCards": num("R"), "offsides": num("OFF"),
                     "totalShots": num("Shts"), "shotsOnTarget": num("SOG")}
                # some rows lose the fouls columns and shift shots left: shots land in SOG, shot% in SG%
                if (r["totalShots"] == 0 or pd.isna(r["totalShots"])) and not p.get("S%") and (r["shotsOnTarget"] or 0) > 0:
                    r["totalShots"], r["shotsOnTarget"], r["foulsCommitted"], r["foulsSuffered"] = r["shotsOnTarget"], np.nan, np.nan, np.nan
                rows.append(r)
    df = pd.DataFrame(rows)
    df = df[df.minutes > 0].copy()
    df["group"] = df.pos_raw.map({"G": "Goalkeeper", "GK": "Goalkeeper", "D": "Defender", "M": "Midfielder", "F": "Attacker"})
    df = df[df.group.notna()]
    df["league"], df["league_name"], df["region"], df["country"], df["league_tier"], df["tier"] = "can.1", "Canadian Premier League", "USA & Canada", "Canada", 1, "cpl"
    df["eid"] = "cpl:" + df.name.map(norm).str.replace(" ", "-")
    for c in ["goalDifference", "goalsConceded"]: df[c] = np.nan
    return per90(df)


def build_national():
    rows = []
    for slug, (comp, seasons) in NATIONAL.items():
        for s in seasons:
            f = RAW / "espn" / slug / f"{s}.json"
            if not f.exists(): continue
            d = json.loads(f.read_text())
            for a in d["athletes"]:
                team = d["teams"].get(a.get("team") or "", {}).get("name")
                if team not in AMERICAS: continue
                tot = {c: sum(st.get(c, 0) or 0 for st in a["stages"].values()) for c in ["appearances", "minutes", "totalGoals", "goalAssists"]}
                if tot["appearances"] <= 0: continue
                rows.append({"eid": a["id"], "name": a["n"], "dob": a.get("dob"), "pos_espn": a.get("pos"), "nation": "United States" if team == "USA" else team,
                             "competition": comp, "season": s, **tot})
    return pd.DataFrame(rows, columns=["eid", "name", "dob", "pos_espn", "nation", "competition", "season", "appearances", "minutes", "totalGoals", "goalAssists"])


def link_ids(espn, national):
    """ESPN athlete id -> ASA player id, by normalized name + birth date (fallbacks: first or last name + birth date)"""
    asa = [pd.read_csv(OUT / "player_seasons.csv", usecols=["player_id", "player_name", "birth_date"])]
    asa.append(pd.read_csv(OUT / "scout_asa_seasons.csv", usecols=["player_id", "player_name", "birth_date"]))
    asa = pd.concat(asa).drop_duplicates("player_id").dropna(subset=["birth_date"])
    asa["k"], asa["dob"] = asa.player_name.map(norm), asa.birth_date.str[:10]
    people = pd.concat([espn[["eid", "name", "dob"]], national[["eid", "name", "dob"]]]).drop_duplicates("eid").dropna(subset=["dob"])
    people["k"] = people.name.map(norm)
    out = people.merge(asa[["player_id", "k", "dob"]], on=["k", "dob"])
    for part in (lambda s: s.split()[0] if s else "", lambda s: s.split()[-1] if s else ""):
        left = people[~people.eid.isin(out.eid)].assign(p=lambda x: x.k.map(part))
        cand = asa.assign(p=asa.k.map(part))
        m = left.merge(cand[["player_id", "p", "dob"]], on=["p", "dob"])
        m = m[~m.duplicated("eid", keep=False)]           # only unambiguous matches
        out = pd.concat([out, m[out.columns]])
    return out[["eid", "player_id"]].drop_duplicates("eid")


if __name__ == "__main__":
    espn = build_espn()
    espn.to_csv(OUT / "scout_espn_seasons.csv", index=False)
    cpl = build_cpl()
    cpl.to_csv(OUT / "scout_cpl_seasons.csv", index=False)
    nat = build_national()
    nat.to_csv(OUT / "national_caps.csv", index=False)
    links = link_ids(espn, nat)
    links.to_csv(OUT / "id_links.csv", index=False)
    mls_rows = espn[espn.league == "usa.1"]
    print(len(espn), "ESPN player-seasons;", len(cpl), "CPL;", len(nat), "national-team rows;", len(links), "ESPN-ASA links",
          f"(MLS link rate {mls_rows.eid.isin(links.eid).mean():.3f})")
    print(espn.groupby(["league", "season"]).agg(n=("eid", "size"), rich=("tier", lambda t: (t == "rich").mean())).round(2).unstack().to_string())
