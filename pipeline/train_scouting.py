"""Americas scouting layer: rate players outside MLS on the MLS scale.

Two data paths, both answering "how good would he be in MLS next season?" as a 0-100 rating on the same scale
as the MLS board (share of MLS players in his position group he would beat):

- Same-metric leagues (USL Championship, USL League One, MLS NEXT Pro; American Soccer Analysis goals added):
  a ridge model trained on every player who moved from one of these leagues to MLS the next season predicts his
  MLS goals added per 96 minutes from his goals added, style and age in the lower league.
- Box-score leagues (ESPN: Liga MX, Brazil A/B, Argentina, Colombia, Chile, Ecuador, Paraguay, Peru, USL via ESPN;
  CPL via StatsCrew): a model trained inside MLS maps box-score stats per 90 to MLS goals added; a league-strength
  model estimated from every player who moved between any two covered leagues converts each league's numbers to
  the MLS level; a calibration fitted on movers into MLS shrinks toward the average. Validation holds out players.

Writes data/scouting_outputs.json and data/scouting_report.json.
"""
import json, pickle, re, unicodedata
from pathlib import Path
import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings("ignore")
from scipy.stats import spearmanr
from sklearn.linear_model import RidgeCV
from sklearn.model_selection import GroupKFold

ROOT = Path(__file__).resolve().parents[1]
DATA, RAW = ROOT / "data", ROOT / "data" / "raw"
CUR, K = 2026, 1500.0
MIN_TARGET, MIN_POOL = 600, 900
MIN_BINS = [0, 1200, 2000, 10000]
report = {}

# ---------------------------------------------------------------- MLS reference (ASA)
mls = pd.read_csv(DATA / "player_seasons.csv")
mls = mls.merge(pd.read_json(DATA / "model_outputs.json")[["player_id", "season", "pct_Impact", "role"]], on=["player_id", "season"], how="left")
mls["passes_p96"] = mls.attempted_passes / (mls.minutes_played / 96)
mls["pos"] = mls.general_position.replace({"DM": "CM"})
qual = lambda d: np.where(d.group.eq("Goalkeeper"), d.minutes_played >= MIN_POOL, d.minutes_played >= MIN_POOL)
MLS_POOL = {(s, g): np.sort(x.gplus_p96.dropna().values) for (s, g), x in mls[qual(mls)].groupby(["season", "group"])}


def mls_pct(value, group, season=CUR):
    """rating 0-100: share of the MLS qualified pool of that group and season the value beats"""
    pool = MLS_POOL.get((season, group))
    if pool is None or value is None or np.isnan(value): return np.nan
    return 100 * np.searchsorted(pool, value, side="left") / len(pool)


def pct_in(frame, col, keys, pool_mask):
    out = pd.Series(np.nan, index=frame.index)
    for _, idx in frame.groupby(keys).groups.items():
        pool = frame.loc[idx][pool_mask.loc[idx]][col].dropna().values
        if len(pool) < 8: continue
        out.loc[idx] = frame.loc[idx, col].apply(lambda v: np.nan if pd.isna(v) else 100 * (pool < v).mean() + 50 * (pool == v).mean())
    return out


def band_from(resid, minutes):
    r = pd.DataFrame({"r": resid, "bin": pd.cut(minutes, MIN_BINS, labels=False)})
    q = r.groupby("bin").r.quantile([0.1, 0.9]).unstack()
    cover = float(((r.r >= q.loc[r.bin, 0.1].values) & (r.r <= q.loc[r.bin, 0.9].values)).mean())
    return q, cover


# ---------------------------------------------------------------- path 1: same-metric leagues (ASA)
SK = {"Finishing": "ga_shooting_p96", "Goal threat": "xgoals_p96", "Chance creation": "xassists_p96", "Passing": "ga_passing_p96",
      "Ball carrying": "ga_dribbling_p96", "Movement": "ga_receiving_p96", "Defending": "ga_interrupting_p96", "Discipline": "ga_fouling_p96"}
ACT = ["ga_passing_p96", "ga_interrupting_p96", "ga_receiving_p96", "ga_shooting_p96", "ga_dribbling_p96", "ga_fouling_p96", "xgoals_p96", "xassists_p96"]
LEAGUES_ASA = ["uslc", "usl1", "mlsnp"]

sc = pd.read_csv(DATA / "scout_asa_seasons.csv")
sc["passes_p96"] = sc.attempted_passes / (sc.minutes_played / 96)
sc["pos"] = sc.general_position.replace({"DM": "CM"})
prev = sc[["player_id", "league", "season", "gplus_p96", "minutes_played"]].rename(columns={"gplus_p96": "g_lag1", "minutes_played": "m_lag1"})
prev["season"] += 1
sc = sc.merge(prev, on=["player_id", "league", "season"], how="left")
num = sc.gplus_p96 * sc.minutes_played + np.where(sc.g_lag1.notna(), sc.g_lag1.fillna(0) * sc.m_lag1.fillna(0) * 0.5, 0)
den = sc.minutes_played + K + np.where(sc.g_lag1.notna(), sc.m_lag1.fillna(0) * 0.5, 0)
sc["w_gplus"] = num / den
for c in ACT: sc[f"s_{c}"] = sc[c] * sc.minutes_played / (sc.minutes_played + K)
sc["age_dev2"] = (sc.age - 25) ** 2
sc["log_min"] = np.log1p(sc.minutes_played)
for lg in LEAGUES_ASA:
    sc[f"L_{lg}"] = (sc.league == lg).astype(float)
    sc[f"Lg_{lg}"] = sc[f"L_{lg}"] * sc.w_gplus
for g in ["Defender", "Midfielder", "Attacker"]: sc[f"G_{g}"] = (sc.group == g).astype(float)
FEATS_ASA = ["w_gplus", "age", "age_dev2", "log_min", "share_team_touches", "passes_p96"] + [f"s_{c}" for c in ACT] + \
            [f"L_{l}" for l in LEAGUES_ASA] + [f"Lg_{l}" for l in LEAGUES_ASA] + ["G_Defender", "G_Midfielder"]

nxt = mls[["player_id", "season", "gplus_p96", "minutes_played", "group"]].rename(columns={"gplus_p96": "y", "minutes_played": "y_min", "group": "y_group"})
nxt["season"] -= 1
movers = sc[(sc.group != "Goalkeeper") & (sc.minutes_played >= 450)].merge(nxt, on=["player_id", "season"])
movers = movers[(movers.y_min >= 450) & (movers.season <= CUR - 1)].copy()
movers["y_pct"] = [mls_pct(v, g, s + 1) for v, g, s in zip(movers.y, movers.y_group, movers.season)]
oof = np.full(len(movers), np.nan)
for tr, te in GroupKFold(5).split(movers, groups=movers.player_id):
    m = RidgeCV(alphas=np.logspace(-3, 3, 13)).fit(movers.iloc[tr][FEATS_ASA].fillna(0), movers.iloc[tr].y, sample_weight=np.sqrt(movers.iloc[tr].y_min))
    oof[te] = m.predict(movers.iloc[te][FEATS_ASA].fillna(0))
movers["oof"] = oof
w = np.sqrt(movers.y_min)
mae = lambda p: round(float(np.average(np.abs(movers.y - p), weights=w)), 4)
lg_mean = movers.groupby("league").y.transform("mean")
q_asa, cover = band_from(movers.y - movers.oof, movers.minutes_played)
oof_pct = np.array([mls_pct(v, g, s + 1) for v, g, s in zip(movers.oof, movers.y_group, movers.season)])
report["same_metric_leagues"] = {
    "model": "RidgeCV, one model for USL Championship, USL League One and MLS NEXT Pro (league terms and league x goals-added slopes)",
    "target": "MLS goals added per 96 minutes in the next season", "validation": "5-fold, grouped by player (no player in both train and test)",
    "movers": int(len(movers)), "movers_by_league": movers.league.value_counts().to_dict(),
    "mae_model": mae(movers.oof), "mae_same_goals_added_as_lower_league": mae(movers.gplus_p96), "mae_league_average_of_movers": mae(lg_mean),
    "spearman_model": round(float(spearmanr(movers.oof, movers.y).statistic), 3),
    "spearman_lower_league_goals_added": round(float(spearmanr(movers.gplus_p96, movers.y).statistic), 3),
    "rating_mae_points": round(float(np.nanmean(np.abs(oof_pct - movers.y_pct))), 1), "interval_80_coverage_heldout": round(cover, 3)}
final_asa = RidgeCV(alphas=np.logspace(-3, 3, 13)).fit(movers[FEATS_ASA].fillna(0), movers.y, sample_weight=np.sqrt(movers.y_min))

# current season: the targets
cur = sc[(sc.season == CUR)].copy()
pool_mask = sc.minutes_played >= MIN_POOL
sc["pct_league"] = pct_in(sc, "gplus_p96", ["league", "season", "group"], pool_mask)
for k, col in SK.items(): sc[f"sk_{k}"] = pct_in(sc, col, ["league", "season", "group"], pool_mask)
cur = sc[(sc.season == CUR) & (sc.minutes_played >= MIN_TARGET)].copy()
out_f = cur.group != "Goalkeeper"
mid = final_asa.predict(cur.loc[out_f, FEATS_ASA].fillna(0)); bins = pd.cut(cur.loc[out_f].minutes_played, MIN_BINS, labels=False).values
cur.loc[out_f, "mls_g"], cur.loc[out_f, "mls_lo"], cur.loc[out_f, "mls_hi"] = mid, mid + q_asa.loc[bins, 0.1].values, mid + q_asa.loc[bins, 0.9].values
for c in ("g", "lo", "hi"): cur[f"mls_{c}_pct"] = [mls_pct(v, g) for v, g in zip(cur[f"mls_{c}"], cur.group)]

# roles and MLS comparables with the MLS models (same style features)
RM = pickle.loads((DATA / "role_models.pkl").read_bytes())
cur["role"], cur["comps"] = None, None
for pos, rm in RM.items():
    rows = cur[cur.pos == pos].dropna(subset=rm["feats"])
    if not len(rows): continue
    Z = rm["scaler"].transform(rows[rm["feats"]])
    cur.loc[rows.index, "role"] = [rm["names"][c] for c in rm["kmeans"].predict(Z)]
    pool = mls[(mls.pos == pos) & (mls.minutes_played >= 900) & (mls.season >= CUR - 3)].dropna(subset=rm["feats"])
    P = rm["scaler"].transform(pool[rm["feats"]]); P /= np.linalg.norm(P, axis=1, keepdims=True) + 1e-9
    Zn = Z / (np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9)
    sim = Zn @ P.T
    for i, ridx in enumerate(rows.index):
        comps = []
        for j in np.argsort(-sim[i]):
            pid = pool.player_id.values[j]
            if pid == cur.at[ridx, "player_id"] or any(c["id"] == pid for c in comps): continue
            comps.append({"id": pid, "season": int(pool.season.values[j]), "sim": round(float(sim[i, j]), 3), "i": None if pd.isna(pool.pct_Impact.values[j]) else int(round(pool.pct_Impact.values[j])),
                          "n": pool.player_name.values[j], "t": pool.team_abbreviation.values[j]})
            if len(comps) == 3: break
        cur.at[ridx, "comps"] = comps
asa_targets = cur
print(json.dumps(report["same_metric_leagues"], indent=1))


# ---------------------------------------------------------------- path 2: box-score leagues (ESPN, CPL)
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^a-z ]", "", unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower())).strip()
BASIC_F = ["totalGoals_p90", "primaryAssists_p90", "totalShots_p90", "shotsOnTarget_p90", "foulsCommitted_p90", "foulsSuffered_p90", "yellowCards_p90",
           "redCards_p90", "start_share", "min_per_app"]
RICH_F = BASIC_F + ["totalPasses_p90", "pass_pct", "accuratePasses_p90", "totalLongBalls_p90", "long_pct", "totalCrosses_p90", "accurateCrosses_p90",
                    "shotAssists_p90", "totalThroughBalls_p90", "effectiveTackles_p90", "interceptions_p90", "totalClearance_p90", "blockedShots_p90"]
EXTRA = ["G_Defender", "G_Midfielder", "age", "log_min"]
CPL_F = BASIC_F                                    # kept for the comparables below

E = pd.concat([pd.read_csv(DATA / "scout_espn_seasons.csv"), pd.read_csv(DATA / "scout_cpl_seasons.csv")], ignore_index=True)
E["eid"] = E.eid.astype(str)
links = pd.read_csv(DATA / "id_links.csv").astype({"eid": str})
E = E.merge(links, on="eid", how="left")
# CPL players have no ESPN id: link them to ASA players by name (MLS, USL, NEXT Pro), only when the name is unique
asa_names = pd.concat([mls[["player_id", "player_name"]], sc[["player_id", "player_name"]]]).drop_duplicates("player_id")
asa_names["k"] = asa_names.player_name.map(norm)
uniq = asa_names[~asa_names.k.duplicated(keep=False)].set_index("k").player_id
cpl_rows = E.league.eq("can.1")
E.loc[cpl_rows, "player_id"] = E.loc[cpl_rows, "name"].map(norm).map(uniq)
E["person"] = np.where(E.player_id.notna(), "a:" + E.player_id.astype(str), "e:" + E.eid)   # one id per person across sources
for g in ["Defender", "Midfielder"]: E[f"G_{g}"] = (E.group == g).astype(float)
E["log_min"] = np.log(E.minutes.clip(lower=1))
E["age"] = E.age.fillna(E.age.median())


def design(X, F):
    X = X[F + EXTRA].copy()
    for g in ["G_Defender", "G_Midfielder"]:
        for f in F: X[f"{f}*{g}"] = X[f] * X[g]
    return X


# ESPN does not record every stat in every league-season (e.g. no shots or fouls in Argentina's Primera Nacional). Each
# league-season gets the models trained in MLS on exactly the stats it records, and two leagues are compared on the
# stats both record.
reg = E[(E.minutes >= 900) & (E.group != "Goalkeeper")]
AVAIL = {k: tuple(f for f in BASIC_F if x[f].notna().mean() > 0.5) for k, x in reg.groupby(["league", "season"])}
E["sig"] = [AVAIL.get((l, s_), tuple(BASIC_F)) for l, s_ in zip(E.league, E.season)]
nxt_mls = mls[["player_id", "season", "gplus_p96", "minutes_played", "group"]].rename(columns={"gplus_p96": "y", "minutes_played": "y_min", "group": "y_group"}).assign(season=lambda x: x.season - 1)
train = E[(E.league == "usa.1") & (E.group != "Goalkeeper") & (E.minutes >= 450)].merge(mls[["player_id", "season", "gplus_p96"]], on=["player_id", "season"])
CAL_F = lambda x, d: np.c_[x, d.G_Defender, d.G_Midfielder, d.age - 25, (d.age - 25) ** 2]
BUNDLES = {}


def bundle(feats, rich=False):
    """MLS-trained models for one set of recorded stats: box score -> goals added (f), and the calibration from
    MLS-level production to next-season MLS goals added (with its held-out 80% band)"""
    key = (tuple(feats), rich)
    if key in BUNDLES: return BUNDLES[key]
    feats = list(feats)
    sub = (train[train.tier == "rich"] if rich else train).reset_index(drop=True)
    med = sub[feats + EXTRA].median()
    X = design(sub.fillna(med), feats); y = sub.gplus_p96; w = np.sqrt(sub.minutes)
    oof = np.zeros(len(sub))
    mk = lambda: make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-2, 4, 13)))
    for tr, te in GroupKFold(5).split(X, groups=sub.player_id):
        oof[te] = mk().fit(X.iloc[tr], y.iloc[tr], ridgecv__sample_weight=w.iloc[tr]).predict(X.iloc[te])
    f = mk().fit(X, y, ridgecv__sample_weight=w)
    r2 = 1 - np.average((y - oof) ** 2, weights=w) / np.average((y - np.average(y, weights=w)) ** 2, weights=w)
    # calibration on MLS consecutive seasons, using out-of-fold production so it is not flattered by the fit
    cr = sub.assign(P=oof)[sub.minutes >= 600].merge(nxt_mls, on=["player_id", "season"])
    cr = cr[cr.y_min >= 450].reset_index(drop=True)
    cal_oof = np.zeros(len(cr))
    for tr, te in GroupKFold(5).split(cr, groups=cr.player_id):
        cal_oof[te] = RidgeCV(alphas=np.logspace(-3, 2, 6)).fit(CAL_F(cr.P.iloc[tr], cr.iloc[tr]), cr.y.iloc[tr], sample_weight=np.sqrt(cr.y_min.iloc[tr])).predict(CAL_F(cr.P.iloc[te], cr.iloc[te]))
    cal = RidgeCV(alphas=np.logspace(-3, 2, 6)).fit(CAL_F(cr.P, cr), cr.y, sample_weight=np.sqrt(cr.y_min))
    q, cover = band_from(cr.y - cal_oof, cr.minutes)
    b = {"feats": feats, "f": f, "med": med, "cal": cal, "q": q, "r2": round(float(r2), 3), "spearman": round(float(spearmanr(oof, y).statistic), 3), "n": int(len(sub)),
         "cal_rows": int(len(cr)), "cal_spearman": round(float(spearmanr(cal_oof, cr.y).statistic), 3), "cal_cover": round(cover, 3),
         "mad": float(np.median(np.abs(cr.y - cal_oof)))}
    BUNDLES[key] = b
    return b


def production(frame, b):
    return b["f"].predict(design(frame.fillna(b["med"]), b["feats"]))


report["box_score_to_goals_added"] = {}
for name, (feats, rich) in {"basic": (BASIC_F, False), "rich": (RICH_F, True)}.items():
    b = bundle(feats, rich)
    report["box_score_to_goals_added"][name] = {"n": b["n"], "r2_oof": b["r2"], "spearman_oof": b["spearman"], "features": len(feats),
                                                "cv": "5-fold grouped by player, MLS 2023-2026, outfield, 450+ minutes"}

# production on the MLS goals-added scale for every row, with the best model its data allows
out_mask = E.group != "Goalkeeper"
E["P"], E["bkey"] = np.nan, None
for sig, idx in E[out_mask].groupby("sig").groups.items():
    E.loc[idx, "P"] = production(E.loc[idx], bundle(sig))
    E.loc[idx, "bkey"] = pd.Series([("basic", sig)] * len(idx), index=idx)
rich_rows = out_mask & E.tier.eq("rich") & E[RICH_F[len(BASIC_F):]].notna().all(axis=1) & E.sig.map(len).eq(len(BASIC_F))
if rich_rows.any():
    E.loc[rich_rows, "P"] = production(E[rich_rows], bundle(RICH_F, True))
    E.loc[rich_rows, "bkey"] = pd.Series([("rich", tuple(RICH_F))] * int(rich_rows.sum()), index=E.index[rich_rows])
get_bundle = lambda k: bundle(k[1], k[0] == "rich")

# 2. league strength from every player who moved between two covered leagues (consecutive seasons), each pair
#    compared on the stats both league-seasons record
LEAGUE_IDS = sorted(E.league.unique())
OTHERS = [l for l in LEAGUE_IDS if l != "usa.1"]


def pairs_from(frame):
    a = frame[(frame.minutes >= 600) & out_mask.loc[frame.index]].copy()
    a["row"] = a.index
    b = a[["person", "league", "season", "minutes", "row", "sig"]].rename(columns={"league": "lb", "minutes": "mb", "row": "row_b", "sig": "sig_b"}).assign(season=lambda x: x.season - 1)
    pr = a[["person", "league", "season", "minutes", "age", "row", "sig"]].merge(b, on=["person", "season"])
    pr["inter"] = [tuple(f for f in BASIC_F if f in sa and f in sb) for sa, sb in zip(pr.sig, pr.sig_b)]
    pr["Pa"], pr["Pb"] = np.nan, np.nan
    for inter, x in pr.groupby("inter"):
        if len(inter) < 3: continue
        bd = bundle(inter)
        pr.loc[x.index, "Pa"] = production(E.loc[x.row], bd)
        pr.loc[x.index, "Pb"] = production(E.loc[x.row_b], bd)
    return pr.dropna(subset=["Pa", "Pb"])


def fit_offsets(pr, pseudo=8.0):
    """Pb - Pa = off_a - off_b + beta*(age_a - 25) + beta2*(age_a - 25)^2 with off(MLS) = 0, weighted ridge.
    Leagues with few moves are shrunk toward the typical covered league (not toward MLS level)."""
    idx = {l: i for i, l in enumerate(OTHERS)}
    X = np.zeros((len(pr), len(OTHERS) + 2)); y = (pr.Pb - pr.Pa).values
    for r, (la, lb) in enumerate(zip(pr.league, pr.lb)):
        if la in idx: X[r, idx[la]] += 1
        if lb in idx: X[r, idx[lb]] -= 1
    X[:, -2], X[:, -1] = pr.age - 25, (pr.age - 25) ** 2
    w = np.sqrt(np.minimum(pr.minutes, pr.mb)).values
    lam = pseudo * float(np.median(w))                        # prior worth about `pseudo` typical moves
    links_n = {l: int(((pr.league == l) | (pr.lb == l)).sum() - ((pr.league == l) & (pr.lb == l)).sum()) for l in LEAGUE_IDS}
    prior = np.zeros(len(OTHERS) + 2)
    for _ in range(2):                                     # pass 1: shrink to MLS; pass 2: shrink to the median well-linked league
        A = X.T @ (X * w[:, None]) + lam * np.diag([1.0] * len(OTHERS) + [0.0, 0.0])
        coef = np.linalg.solve(A, X.T @ (w * y) + lam * prior)
        good = [coef[i] for l, i in idx.items() if links_n[l] >= 30]
        prior[:len(OTHERS)] = np.median(good) if good else 0.0
    off = {"usa.1": 0.0, **{l: float(coef[i]) for l, i in idx.items()}}
    return off, links_n, coef[-2:]


PAIRS = pairs_from(E)
LINKS_N = {l: int(((PAIRS.league == l) ^ (PAIRS.lb == l)).sum()) for l in LEAGUE_IDS}
NET_OFF, _, AGE_B = fit_offsets(PAIRS)                       # box-score method, reported for comparison only

# league strength from results: team ratings (goal difference, home advantage, recent matches weigh more) from every
# domestic match and every cross-league competition (Leagues Cup, Concacaf Champions Cup, Libertadores, Sudamericana,
# Club World Cup); a league's strength is the average rating of its clubs in 2025-2026
games = {}
for f in (RAW / "espn_results").glob("*/*.json"):
    for g in json.loads(f.read_text()): games[g["id"]] = g
GM = pd.DataFrame(games.values())
TEAMS_R = sorted(set(GM.home) | set(GM.away)); tix = {t: i for i, t in enumerate(TEAMS_R)}
gw = 0.5 ** ((pd.Timestamp(f"{CUR}-10-26") - pd.to_datetime(GM.date)).dt.days / 365.0).values
Xr = np.zeros((len(GM), len(TEAMS_R) + 1))
Xr[np.arange(len(GM)), GM.home.map(tix)] = 1; Xr[np.arange(len(GM)), GM.away.map(tix)] = -1; Xr[:, -1] = (~GM.neutral.astype(bool)).astype(float)
yr = (GM.hg - GM.ag).clip(-3, 3).values
coef_r = np.linalg.solve(Xr.T @ (Xr * gw[:, None]) + 5.0 * np.diag([1.0] * len(TEAMS_R) + [0.0]), Xr.T @ (gw * yr))
TEAM_RATING = dict(zip(TEAMS_R, coef_r[:-1]))
TEAM_NAME = dict(zip(GM.home, GM.hn)) | dict(zip(GM.away, GM.an))
league_teams = {}
for lg in LEAGUE_IDS:
    for f in (RAW / "espn" / lg).glob("202[56].json") if lg != "can.1" else []:
        league_teams.setdefault(lg, set()).update(t for t in json.loads(f.read_text())["teams"] if t in TEAM_RATING)
STRENGTH = {lg: float(np.mean([TEAM_RATING[t] for t in ts])) for lg, ts in league_teams.items() if ts}
# CPL has no domestic results here: its Concacaf Champions Cup clubs, minus the usual gap between a league's
# continental clubs and its average (measured on the other leagues)
cup_teams = set(GM[~GM.comp.isin(LEAGUE_IDS)].home) | set(GM[~GM.comp.isin(LEAGUE_IDS)].away)
gaps = [np.mean([TEAM_RATING[t] for t in ts & cup_teams]) - STRENGTH[lg] for lg, ts in league_teams.items() if len(ts & cup_teams) >= 2]
CPL_CLUBS = ("Cavalry", "Forge", "Pacific FC", "Atlético Ottawa", "Atletico Ottawa", "HFX", "York United", "Vancouver FC", "Valour", "Inter Toronto")
cpl_t = [t for t in TEAMS_R if any(k in (TEAM_NAME.get(t) or "") for k in CPL_CLUBS)]
if cpl_t: STRENGTH["can.1"] = float(np.mean([TEAM_RATING[t] for t in cpl_t]) - np.median(gaps))
DS = {lg: STRENGTH.get(lg, np.nan) - STRENGTH["usa.1"] for lg in LEAGUE_IDS}


# production relative to the player's own league-season (players in weaker leagues post bigger numbers): centred on
# the league-season average of regulars, then placed at MLS average; league strength is added back from results
MLS_MU = {}
mls_reg = E[out_mask & (E.league == "usa.1") & (E.minutes >= 900)]
E["Prel"] = np.nan
for (lg, s_, k), x in E[out_mask].groupby(["league", "season", "bkey"]):
    b = get_bundle(k)
    regs = x[x.minutes >= 900]
    mu_l = regs.P.mean() if len(regs) >= 15 else x.P.mean()
    if k not in MLS_MU: MLS_MU[k] = float(production(mls_reg, b).mean())
    E.loc[x.index, "Prel"] = x.P - mu_l + MLS_MU[k]


def mls_ready(frame, off, col="Prel"):
    """next-season MLS goals added: calibration of the row's own model applied to production + league strength"""
    out = pd.Series(np.nan, index=frame.index)
    for k, x in frame.groupby("bkey"):
        b = get_bundle(k)
        out.loc[x.index] = b["cal"].predict(CAL_F(x[col] + x.league.map(off).fillna(0), x))
    return out


# 3. one scale factor turns league strength (goals per match vs MLS) into goals added per 96: fitted on the real movers
#    into MLS; the check refits it without each mover
mv = E[(E.league != "usa.1") & out_mask & (E.minutes >= 600)].merge(nxt_mls, on=["player_id", "season"])
mv = mv[mv.y_min >= 450].reset_index(drop=True)
mv = mv[mv.league.map(DS).notna()].reset_index(drop=True)
slope = np.array([get_bundle(k)["cal"].coef_[0] for k in mv.bkey])          # how production moves the prediction
ds = mv.league.map(DS).values
KAPPAS = np.linspace(0, 1.0, 201)


def loo(col):
    """fit the strength scale on the movers (minimum weighted absolute error); check with each mover left out"""
    base = mls_ready(mv, {l: 0.0 for l in LEAGUE_IDS}, col).values
    def best(mask):
        wv = np.sqrt(mv.y_min.values[mask])
        return float(KAPPAS[int(np.argmin([np.average(np.abs(mv.y.values[mask] - (base[mask] + slope[mask] * k * ds[mask])), weights=wv) for k in KAPPAS]))])
    k_all = best(np.ones(len(mv), bool))
    pred = np.array([base[i] + slope[i] * best(np.arange(len(mv)) != i) * ds[i] for i in range(len(mv))])
    return k_all, pred, base


METHODS = {"relative to own league + results strength": "Prel", "raw production + results strength": "P"}
trial = {name: loo(col) for name, col in METHODS.items()}
wv_all = np.sqrt(mv.y_min)
trial_mae = {name: float(np.average(np.abs(mv.y - t[1]), weights=wv_all)) for name, t in trial.items()}
METHOD = min(trial_mae, key=trial_mae.get)
PCOL = METHODS[METHOD]
KAPPA, oof, base0 = trial[METHOD]
OFF = {lg: (KAPPA * d if not np.isnan(d) else KAPPA * np.nanmedian(list(DS.values()))) for lg, d in DS.items()}
report["box_score_method_choice"] = {n: {"mae": round(v, 4), "kappa": round(trial[n][0], 3), "spearman": round(float(spearmanr(trial[n][1], mv.y).statistic), 3)} for n, v in trial_mae.items()}
report["box_score_method_choice"]["chosen"] = METHOD
base_mad = np.median([get_bundle(k)["mad"] for k in mv.bkey]) if len(mv) else 1
widen = float(np.clip(np.median(np.abs(mv.y - oof)) / base_mad, 1.0, 2.0)) if len(mv) >= 10 else 1.0
band_lo = lambda k, b: get_bundle(k)["q"].loc[b, 0.1] * widen
band_hi = lambda k, b: get_bundle(k)["q"].loc[b, 0.9] * widen
mv_bins = pd.cut(mv.minutes, MIN_BINS, labels=False)
cover_box = float(np.mean([(r >= band_lo(k, b)) & (r <= band_hi(k, b)) for r, k, b in zip(mv.y - oof, mv.bkey, mv_bins)])) if len(mv) else None
w = np.sqrt(mv.y_min)
mae = lambda p: round(float(np.average(np.abs(mv.y - p), weights=w)), 4) if len(mv) else None
lg_avg = mv.groupby("league").y.transform("mean")
mls_avg = np.average(nxt_mls.y[nxt_mls.y_min >= 450], weights=np.sqrt(nxt_mls.y_min[nxt_mls.y_min >= 450]))
oof_pct = np.array([mls_pct(v, g, s + 1) for v, g, s in zip(oof, mv.y_group, mv.season)])
y_pct = np.array([mls_pct(v, g, s + 1) for v, g, s in zip(mv.y, mv.y_group, mv.season)])
bb = bundle(BASIC_F)
report["box_score_calibration"] = {"rows": bb["cal_rows"], "source": "MLS consecutive seasons 2023-2026 (box score in season t, goals added in t+1)",
                                   "spearman_oof": bb["cal_spearman"], "interval_80_coverage_mls_heldout": bb["cal_cover"], "range_widening_for_movers": round(widen, 2),
                                   "stat_sets": len(BUNDLES)}
report["box_score_leagues"] = {
    "league_strength": "team ratings from 2023-2026 results (domestic leagues + Leagues Cup, Concacaf Champions Cup, Libertadores, Sudamericana, Club World Cup), league = average club rating 2025-2026; scaled to goals added by one factor fitted on movers into MLS",
    "matches": int(len(GM)), "kappa": round(KAPPA, 3), "strength_goals_per_match_vs_mls": {k: round(v, 3) for k, v in DS.items() if not np.isnan(v)},
    "box_score_network_offsets_not_used": {k: round(v, 4) for k, v in NET_OFF.items()},
    "pairs": int(len(PAIRS)), "cross_league_pairs": int((PAIRS.league != PAIRS.lb).sum()),
    "movers_into_mls": int(len(mv)), "movers_by_league": mv.league.value_counts().to_dict(),
    "validation": "each mover into MLS left out of the league-strength fit, then predicted (calibration comes from MLS players only)",
    "mae_model": mae(oof), "mae_without_league_strength": mae(base0) if len(mv) else None,
    "mae_league_average_of_movers": mae(lg_avg), "mae_mls_average": mae(np.full(len(mv), mls_avg)),
    "spearman_model": round(float(spearmanr(oof, mv.y).statistic), 3) if len(mv) >= 8 else None,
    "spearman_box_score_only": round(float(spearmanr(mv.P, mv.y).statistic), 3) if len(mv) >= 8 else None,
    "spearman_without_league_strength": round(float(spearmanr(base0, mv.y).statistic), 3) if len(mv) >= 8 else None,
    "rating_mae_points": round(float(np.nanmean(np.abs(oof_pct - y_pct))), 1) if len(mv) else None,
    "interval_80_coverage_heldout": round(cover_box, 3) if cover_box is not None else None}
print(json.dumps({k: report[k] for k in ("box_score_method_choice", "box_score_leagues")}, indent=1))
print({l: round(v, 4) for l, v in sorted(OFF.items(), key=lambda kv: -kv[1])}, LINKS_N)

# 4. ratings for the current pool of box-score players
E["pct_league"] = np.nan
pool_ok = E.minutes >= MIN_POOL
E.loc[out_mask, "pct_league"] = pct_in(E[out_mask], "P", ["league", "season", "group"], pool_ok[out_mask])
E["gk_score"] = -E.goalsConceded_p90
gk_mask = E.group == "Goalkeeper"
E.loc[gk_mask, "pct_league"] = pct_in(E[gk_mask], "gk_score", ["league", "season", "group"], pool_ok[gk_mask])
E["creating"] = E.primaryAssists_p90 + E.shotAssists_p90.fillna(0)
E["defending"] = E.effectiveTackles_p90 + E.interceptions_p90
E["clearing"] = E.totalClearance_p90 + E.blockedShots_p90
E["discipline"] = -(E.foulsCommitted_p90.fillna(0) + 3 * E.yellowCards_p90.fillna(0) + 8 * E.redCards_p90.fillna(0))
E["clean_rate"] = E.cleanSheet / E.appearances.clip(lower=1)
SKILLS_BOX = {"basic": {"Scoring": "totalGoals_p90", "Shooting": "totalShots_p90", "Accuracy": "sot_rate", "Creating": "primaryAssists_p90",
                        "Fouls won": "foulsSuffered_p90", "Discipline": "discipline"},
              "rich": {"Scoring": "totalGoals_p90", "Shooting": "totalShots_p90", "Chance creation": "creating", "Passing": "accuratePasses_p90",
                       "Crossing": "accurateCrosses_p90", "Defending": "defending", "Clearing": "clearing", "Discipline": "discipline"},
              "gk": {"Goals allowed": "gk_score", "Clean sheets": "clean_rate", "Discipline": "discipline"}}
for skills in SKILLS_BOX.values():
    for k, col in skills.items():
        if f"bx_{col}" not in E: E[f"bx_{col}"] = pct_in(E, col, ["league", "season", "group"], pool_ok)

in_mls_now = set("a:" + mls[mls.season == CUR].player_id.astype(str)) | set(E[(E.league == "usa.1") & (E.season == CUR)].person)
asa_now = set("a:" + asa_targets.player_id.astype(str))
cand = E[(E.league != "usa.1") & (E.season >= CUR - 1) & (E.minutes >= MIN_TARGET) & ~E.person.isin(in_mls_now | asa_now)]
# stats season: the latest one if it has 1,200+ minutes, otherwise the one with the most minutes; club: the latest one
cand = cand.assign(pref=np.where(cand.minutes >= 1200, cand.season * 10000 + cand.minutes, cand.minutes))
latest_club = cand.sort_values("season").groupby("person").agg(cur_team=("team_short", "last"), cur_team_full=("team", "last"), cur_league=("league", "last"))
box_targets = cand.sort_values("pref", ascending=False).drop_duplicates("person").join(latest_club, on="person").copy()
same = box_targets.cur_league.eq(box_targets.league)                 # only when he is still in the same league
box_targets.loc[same, "team_short"], box_targets.loc[same, "team"] = box_targets.loc[same, "cur_team"], box_targets.loc[same, "cur_team_full"]
bo = box_targets.group != "Goalkeeper"
mid = mls_ready(box_targets[bo], OFF, PCOL)
bins = pd.cut(box_targets.loc[bo, "minutes"], MIN_BINS, labels=False)
box_targets.loc[bo, "mls_g"] = mid
box_targets.loc[bo, "mls_lo"] = mid + [band_lo(k, b) for k, b in zip(box_targets.loc[bo, "bkey"], bins)]
box_targets.loc[bo, "mls_hi"] = mid + [band_hi(k, b) for k, b in zip(box_targets.loc[bo, "bkey"], bins)]
for c in ("g", "lo", "hi"): box_targets[f"mls_{c}_pct"] = [mls_pct(v, g) for v, g in zip(box_targets[f"mls_{c}"], box_targets.group)]

# MLS players with the closest box-score profile (same position group, MLS 2024-2026)
mls_box = E[(E.league == "usa.1") & (E.minutes >= MIN_POOL) & (E.season >= CUR - 2) & E.player_id.notna()].merge(
    mls[["player_id", "season", "pct_Impact", "team_abbreviation", "player_name"]], on=["player_id", "season"])
box_targets["comps"] = None
for (g, tier), rows in box_targets.groupby(["group", box_targets.tier.where(box_targets.tier == "rich", "basic")]):
    F = (RICH_F if tier == "rich" else CPL_F) if g != "Goalkeeper" else ["goalsConceded_p90", "clean_rate", "min_per_app"]
    pool = mls_box[(mls_box.group == g) & ((mls_box.tier == "rich") if tier == "rich" else True)].dropna(subset=F)
    rows = rows.dropna(subset=F)
    if len(pool) < 10 or not len(rows): continue
    mu, sd = pool[F].mean(), pool[F].std().replace(0, 1)
    P_ = ((pool[F] - mu) / sd).values; P_ /= np.linalg.norm(P_, axis=1, keepdims=True) + 1e-9
    Z = ((rows[F] - mu) / sd).values; Z /= np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9
    sim = Z @ P_.T
    for i, ridx in enumerate(rows.index):
        comps = []
        for j in np.argsort(-sim[i]):
            pid = pool.player_id.values[j]
            if any(c["id"] == pid for c in comps): continue
            comps.append({"id": pid, "season": int(pool.season.values[j]), "sim": round(float(sim[i, j]), 3), "n": pool.player_name.values[j],
                          "t": pool.team_abbreviation.values[j], "i": None if pd.isna(pool.pct_Impact.values[j]) else int(round(pool.pct_Impact.values[j]))})
            if len(comps) == 3: break
        box_targets.at[ridx, "comps"] = comps

# ---------------------------------------------------------------- national teams (Americas nations, 2023-2026 competitions)
nat = pd.read_csv(DATA / "national_caps.csv").astype({"eid": str}) if (DATA / "national_caps.csv").stat().st_size > 120 else pd.DataFrame(columns=["eid", "name", "nation", "competition", "season", "appearances", "minutes", "totalGoals", "goalAssists", "dob", "pos_espn"])
nat = nat.merge(links, on="eid", how="left")
nat_k = nat.assign(k=nat.name.map(norm)).drop_duplicates(["k", "eid"])
uniq_nat = nat_k[~nat_k.k.duplicated(keep=False)].set_index("k").eid


def caps_for(eid=None, player_id=None, name=None):
    rows = nat[(nat.eid == str(eid))] if eid and not str(eid).startswith("cpl:") else nat.iloc[0:0]
    if not len(rows) and player_id is not None and not pd.isna(player_id): rows = nat[nat.player_id == player_id]
    if not len(rows) and name: e = uniq_nat.get(norm(name)); rows = nat[nat.eid == e] if e else rows
    if not len(rows): return None
    return {"nation": rows.nation.mode().iloc[0], "apps": int(rows.appearances.sum()), "min": int(rows.minutes.sum()), "goals": int(rows.totalGoals.sum()),
            "comps": [{"c": c, "apps": int(x.appearances.sum()), "min": int(x.minutes.sum()), "g": int(x.totalGoals.sum())} for c, x in rows.groupby("competition")]}


# ---------------------------------------------------------------- output records
r0 = lambda v: None if v is None or pd.isna(v) else int(round(float(v)))
r2 = lambda v, k=3: None if v is None or pd.isna(v) else round(float(v), k)
BROAD = {"Defender": "DEF", "Midfielder": "MID", "Attacker": "FWD", "Goalkeeper": "GK"}
LEAGUE_NAME = {**{l: n for l, n in E[["league", "league_name"]].drop_duplicates().values}, "uslc": "USL Championship", "usl1": "USL League One", "mlsnp": "MLS NEXT Pro"}
season_label = lambda lg, s: f"{s}-{str(s + 1)[2:]}" if lg in ("mex.1",) else str(s)


def history(person, player_id):
    h = []
    for _, r in E[E.person == person].iterrows():
        h.append({"s": int(r.season), "lg": r.league, "t": r.team_short, "min": int(r.minutes), "r": r0(r.pct_league)})
    if player_id is not None and not pd.isna(player_id):
        for _, r in sc[(sc.player_id == player_id) & (sc.minutes_played >= 300)].iterrows():
            h.append({"s": int(r.season), "lg": r.league, "t": r.team_abbreviation, "min": int(r.minutes_played), "r": r0(r.pct_league)})
        for _, r in mls[(mls.player_id == player_id) & (mls.minutes_played >= 300)].iterrows():
            h.append({"s": int(r.season), "lg": "mls", "t": r.team_abbreviation, "min": int(r.minutes_played), "r": r0(r.pct_Impact)})
    h = {(x["s"], x["lg"]): x for x in h}.values()
    return sorted([x for x in h if x["s"] >= CUR - 4], key=lambda x: (x["s"], x["lg"]))


records = []
for _, r in asa_targets.iterrows():
    gk = r.group == "Goalkeeper"
    records.append({"id": f"x:{r.player_id}", "src": "asa", "tier": "full", "n": r.player_name, "lg": r.league, "t": r.team_short_name or r.team_name, "tn": r.team_name,
                    "pos": r.general_position, "g": r.group, "role": r.role, "age": r2(r.age, 1), "nat": r.nationality if isinstance(r.nationality, str) else None,
                    "cm": r0(r.height_cm), "min": int(r.minutes_played), "gp": r0(r.count_games), "season": str(CUR),
                    "mr": None if gk else r0(r.mls_g_pct), "mrLo": None if gk else r0(r.mls_lo_pct), "mrHi": None if gk else r0(r.mls_hi_pct), "lr": r0(r.pct_league),
                    "sk": None if gk else {k: r0(r[f"sk_{k}"]) for k in SK},
                    "box": {"goals": r0(r.goals), "assists": r0(r.primary_assists), "xg": r2(r.xgoals, 1), "xa": r2(r.xassists, 1), "gplus": r2(r.gplus_p96)},
                    "comps": r.comps if isinstance(r.comps, list) else [], "nt": caps_for(player_id=r.player_id, name=r.player_name),
                    "hist": history(f"a:{r.player_id}", r.player_id)})
for _, r in box_targets.iterrows():
    gk = r.group == "Goalkeeper"
    tier = "gk" if gk else ("rich" if r.tier == "rich" else "basic")
    records.append({"id": f"x:{r.person}", "src": "cpl" if r.league == "can.1" else "espn", "tier": "basic" if gk else tier, "n": r["name"], "lg": r.league, "t": r.team_short, "tn": r.team,
                    "pos": BROAD[r.group], "g": r.group, "role": None, "age": r2(r.age, 1), "nat": r.nationality if isinstance(r.nationality, str) else None,
                    "cm": r0(r.height_cm), "min": int(r.minutes), "gp": r0(r.appearances), "season": season_label(r.league, int(r.season)),
                    "mr": None if gk else r0(r.get("mls_g_pct")), "mrLo": None if gk else r0(r.get("mls_lo_pct")), "mrHi": None if gk else r0(r.get("mls_hi_pct")), "lr": r0(r.pct_league),
                    "sk": {k: r0(r[f"bx_{col}"]) for k, col in SKILLS_BOX[tier].items()},
                    "box": {"goals": r0(r.totalGoals), "assists": r0(r.goalAssists), "shots": r0(r.totalShots), "sot": r0(r.shotsOnTarget),
                            "passes": r0(r.totalPasses) if r.tier == "rich" else None, "passPct": r2(r.pass_pct, 3) if r.tier == "rich" else None,
                            "tackles": r0(r.effectiveTackles) if r.tier == "rich" else None, "inter": r0(r.interceptions) if r.tier == "rich" else None},
                    "comps": r.comps if isinstance(r.comps, list) else [], "nt": caps_for(eid=r.eid, player_id=r.player_id, name=r["name"]),
                    "hist": history(r.person, r.player_id)})

# league table: strength on the MLS scale = rating of an average regular (median production) of that league if he moved to MLS
leagues = []
for lg in LEAGUE_IDS + LEAGUES_ASA:
    if lg == "usa.1": continue
    if lg in LEAGUES_ASA:
        regs = asa_targets[(asa_targets.league == lg) & (asa_targets.group != "Goalkeeper")]
        level = r0(regs.mls_g_pct.median()) if len(regs) else None
        n_mv = int((movers.league == lg).sum())
    else:
        regs = box_targets[(box_targets.league == lg) & (box_targets.group != "Goalkeeper")]
        level = r0(regs.mls_g_pct.median()) if "mls_g_pct" in regs and len(regs) else None
        n_mv = int((mv.league == lg).sum())
    region = "USA & Canada" if lg in LEAGUES_ASA else E[E.league == lg].region.iloc[0]
    leagues.append({"id": lg, "name": LEAGUE_NAME.get(lg, lg), "region": region, "players": int(sum(1 for x in records if x["lg"] == lg)),
                    "level": level, "offset": r2(OFF.get(lg), 4) if lg in OFF else None, "strength": r2(DS.get(lg), 3) if lg in DS and not np.isnan(DS.get(lg, np.nan)) else None, "links": LINKS_N.get(lg), "movers_to_mls": n_mv,
                    "data": "goals added (same as MLS)" if lg in LEAGUES_ASA else ("box score (StatsCrew)" if lg == "can.1" else
                            ("box score + passing/defending" if (E[(E.league == lg) & (E.season >= CUR - 1)].tier == "rich").mean() > 0.5 else "box score"))})

# moves between leagues (for the flow chart): every consecutive-season move between two covered leagues incl. MLS
mv_all = pd.concat([PAIRS[PAIRS.league != PAIRS.lb][["league", "lb"]].rename(columns={"league": "a", "lb": "b"}),
                    movers.assign(b="usa.1")[["league", "b"]].rename(columns={"league": "a"})])
flows = mv_all.groupby(["a", "b"]).size().reset_index(name="n")
national_pool = nat.groupby("eid").agg(name=("name", "first"), nation=("nation", "first"), pos=("pos_espn", "first"), dob=("dob", "first"),
                                       apps=("appearances", "sum"), min=("minutes", "sum"), goals=("totalGoals", "sum"), player_id=("player_id", "first")).reset_index()
pd.Series(records).to_json(DATA / "scouting_outputs.json", orient="values")
(DATA / "scouting_extra.json").write_text(json.dumps({"leagues": leagues, "flows": flows.to_dict("records"), "national": national_pool.to_dict("records"),
                                                      "offsets": OFF, "age_curve": [float(x) for x in AGE_B]}, default=lambda o: None if pd.isna(o) else str(o)))
(DATA / "scouting_report.json").write_text(json.dumps(report, indent=1))
print(len(records), "targets:", pd.Series([x["lg"] for x in records]).value_counts().to_dict())
