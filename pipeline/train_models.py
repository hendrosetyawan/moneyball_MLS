"""Machine-learning layer: skill percentiles, playing roles, comparable players,
next-season projection and fair-salary model. Writes data/model_outputs.csv and
data/model_report.json.

Models
- Roles: k-means per position on a standardized style profile (900+ minute seasons, 2021-2026),
  clusters named by rule from their centroids.
- Comparable players: cosine similarity on the same profile, any season 2021-2026.
- Projection: LightGBM quantile regression (10th / 50th / 90th percentile) of next-season
  goals added per 96 minutes; trained on season pairs, validated on 2024 -> 2025.
- Fair salary: LightGBM regression of log guaranteed compensation on on-field production,
  age and position only; out-of-fold predictions (grouped by player) give the salary the
  league typically pays for that production.
"""
import json
from pathlib import Path
import numpy as np
import pandas as pd
import warnings
import lightgbm as lgb
warnings.filterwarnings('ignore')
from scipy.stats import spearmanr
from sklearn.cluster import KMeans
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CUR = 2026
MIN_OUT, MIN_GK, MIN_SHOW = 900, 900, 300
rng = 7

df = pd.read_csv(DATA / "player_seasons.csv")
df["passes_p96"] = df.attempted_passes / (df.minutes_played / 96)
df["pos"] = df.general_position.replace({"DM": "CM"})           # DM and CM share role clustering
df["is_gk"] = df.group.eq("Goalkeeper")

# ---------------------------------------------------------------- skill percentiles (within position group and season)
SKILLS = {  # scout-facing name -> (column, higher is better)
    "Finishing": ("ga_shooting_p96", True),
    "Goal threat": ("xgoals_p96", True),
    "Chance creation": ("xassists_p96", True),
    "Passing": ("ga_passing_p96", True),
    "Ball carrying": ("ga_dribbling_p96", True),
    "Movement": ("ga_receiving_p96", True),
    "Defending": ("ga_interrupting_p96", True),
    "Discipline": ("ga_fouling_p96", True),
}
GK_SKILLS = {
    "Shot stopping": ("gk_shotstopping_p96", True),
    "Claiming crosses": ("gk_claiming_p96", True),
    "Handling": ("gk_handling_p96", True),
    "Distribution": ("gk_passing_ga_p96", True),
    "Sweeping": ("gk_sweeping_p96", True),
    "Positioning": ("gk_fielding_p96", True),
}


def pct_within(frame, col, mask_pool):
    """percentile (0-100) of each row vs the qualified pool of its group and season"""
    out = pd.Series(np.nan, index=frame.index)
    for (s, g), idx in frame.groupby(["season", "group"]).groups.items():
        pool = frame.loc[idx][mask_pool.loc[idx]][col].dropna().values
        if len(pool) < 5: continue
        vals = frame.loc[idx, col]
        out.loc[idx] = vals.apply(lambda v: np.nan if pd.isna(v) else 100 * (pool < v).mean() + 50 * (pool == v).mean())
    return out


qualified = np.where(df.is_gk, df.minutes_played >= MIN_GK, df.minutes_played >= MIN_OUT)
qualified = pd.Series(qualified, index=df.index)
for name, (col, _) in {**SKILLS, **GK_SKILLS}.items():
    df[f"pct_{name}"] = pct_within(df, col, qualified)
df["pct_Impact"] = pct_within(df, "gplus_p96", qualified)

# ---------------------------------------------------------------- roles
STYLE = ["ga_dribbling_p96", "ga_fouling_p96", "ga_interrupting_p96", "ga_passing_p96", "ga_receiving_p96", "ga_shooting_p96",
         "xgoals_p96", "xassists_p96", "key_passes_p96", "avg_distance_yds", "avg_vertical_distance_yds", "share_team_touches", "passes_p96"]
GK_STYLE = ["gk_shotstopping_p96", "gk_claiming_p96", "gk_handling_p96", "gk_passing_ga_p96", "gk_sweeping_p96", "gk_fielding_p96"]
# rule-based names: (k, list of (name, scoring function on centroid z-scores)) assigned greedily
ROLE_RULES = {
    "CB": (2, [("Ball-playing centre-back", lambda z: z.ga_passing_p96 + z.passes_p96 + z.avg_distance_yds), ("Stopper", lambda z: 0)]),
    "FB": (2, [("Attacking wing-back", lambda z: z.xassists_p96 + z.ga_receiving_p96 + z.key_passes_p96), ("Defensive full-back", lambda z: 0)]),
    "CM": (3, [("Deep playmaker", lambda z: z.ga_passing_p96 + z.passes_p96 + z.share_team_touches), ("Ball winner", lambda z: z.ga_interrupting_p96 - z.xgoals_p96),
               ("Box-to-box", lambda z: 0)]),
    "AM": (2, [("Creator (No. 10)", lambda z: z.xassists_p96 + z.key_passes_p96 + z.ga_passing_p96), ("Second striker", lambda z: 0)]),
    "W": (3, [("Inside forward", lambda z: z.xgoals_p96 + z.ga_shooting_p96 - z.passes_p96), ("Creative winger", lambda z: z.xassists_p96 + z.key_passes_p96 + z.ga_passing_p96),
              ("Direct dribbler", lambda z: 0)]),
    "ST": (2, [("Poacher", lambda z: z.xgoals_p96 - z.passes_p96 - z.share_team_touches), ("Link-up striker", lambda z: 0)]),
    "GK": (2, [("Sweeper-keeper", lambda z: z.gk_passing_ga_p96 + z.gk_sweeping_p96), ("Shot-stopper", lambda z: 0)]),
}
df["role"] = None
scalers = {}
for pos, (k, rules) in ROLE_RULES.items():
    feats = GK_STYLE if pos == "GK" else STYLE
    rows = df[(df.pos == pos)].dropna(subset=feats)
    fit = rows[rows.minutes_played >= (MIN_GK if pos == "GK" else MIN_OUT)]
    sc = StandardScaler().fit(fit[feats]); scalers[pos] = (sc, feats)
    km = KMeans(k, n_init=20, random_state=rng).fit(sc.transform(fit[feats]))
    cent = pd.DataFrame(km.cluster_centers_, columns=feats)
    names, free = {}, set(range(k))
    for name, score in rules:
        best = max(free, key=lambda c: score(cent.loc[c])); names[best] = name; free.discard(best)
    df.loc[rows.index, "role"] = [names[c] for c in km.predict(sc.transform(rows[feats]))]

# ---------------------------------------------------------------- comparable players (cosine, same position, any season)
df["comps"] = None
for pos, (sc, feats) in scalers.items():
    pool = df[(df.pos == pos) & (df.minutes_played >= MIN_SHOW)].dropna(subset=feats)
    Z = sc.transform(pool[feats]); Z /= np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9
    cur = pool[pool.season == CUR]
    S = sc.transform(cur[feats]); S /= np.linalg.norm(S, axis=1, keepdims=True) + 1e-9
    sim = S @ Z.T
    ids, seasons = pool.player_id.values, pool.season.values
    for i, ridx in enumerate(cur.index):
        order = np.argsort(-sim[i]); comps = []
        for j in order:
            if ids[j] == cur.at[ridx, "player_id"]: continue
            if any(c["id"] == ids[j] for c in comps): continue
            comps.append({"id": ids[j], "season": int(seasons[j]), "sim": round(float(sim[i, j]), 3)})
            if len(comps) == 3: break
        df.at[ridx, "comps"] = comps

# ---------------------------------------------------------------- projection: next-season g+ per 96
# Ridge regression on minutes-shrunk features (several were tested; see README). The 80% range comes from
# held-out residuals of rolling validation (train up to season t-1, test season t), binned by minutes played.
from sklearn.linear_model import RidgeCV
df["pos_code"] = df.pos.astype("category").cat.codes
for lag in (1, 2):
    p = df[["player_id", "season", "gplus_p96", "minutes_played"]].rename(columns={"gplus_p96": f"g_lag{lag}", "minutes_played": f"m_lag{lag}"})
    p["season"] += lag
    df = df.merge(p, on=["player_id", "season"], how="left")
df["prev_gplus_p96"], df["prev_minutes"] = df.g_lag1, df.m_lag1
K = 1500.0


def add_proj_features(X):
    X = X.copy()
    num, den = X.gplus_p96 * X.minutes_played, X.minutes_played + K
    for lag, w in ((1, 0.5), (2, 0.25)):
        ok = X[f"g_lag{lag}"].notna()
        num = num + np.where(ok, X[f"g_lag{lag}"].fillna(0) * X[f"m_lag{lag}"].fillna(0) * w, 0)
        den = den + np.where(ok, X[f"m_lag{lag}"].fillna(0) * w, 0)
    X["w_gplus"] = num / den                                   # multi-season, minutes-weighted, shrunk to average
    for c in ACT_COLS:
        X[f"s_{c}"] = X[c] * X.minutes_played / (X.minutes_played + K)
    X["age_dev2"] = (X.age - 27) ** 2
    return X


ACT_COLS = ["ga_passing_p96", "ga_interrupting_p96", "ga_receiving_p96", "ga_shooting_p96", "ga_dribbling_p96", "ga_fouling_p96", "xgoals_p96", "xassists_p96"]
PROJ_FEATS = ["w_gplus", "age", "age_dev2", "minutes_played", "share_team_touches", "passes_p96"] + [f"s_{c}" for c in ACT_COLS]
df = add_proj_features(df)
nxt = df[["player_id", "season", "gplus_p96", "minutes_played"]].rename(columns={"gplus_p96": "next_gplus_p96", "minutes_played": "next_minutes"})
nxt["season"] -= 1
pairs = df.merge(nxt, on=["player_id", "season"], how="inner")
pairs = pairs[(pairs.minutes_played >= 450) & (pairs.next_minutes >= 450) & ~pairs.is_gk]


def fit_ridge(train):
    return RidgeCV(alphas=np.logspace(-3, 3, 13)).fit(train[PROJ_FEATS].fillna(0), train.next_gplus_p96, sample_weight=np.sqrt(train.next_minutes))


MIN_BINS = [0, 1200, 2000, 10000]
folds, resid = [], []
for test in (2022, 2023, 2024):                               # season pair (test, test+1)
    tr, va = pairs[pairs.season < test], pairs[pairs.season == test]
    m = fit_ridge(tr); p = m.predict(va[PROJ_FEATS].fillna(0)); w = np.sqrt(va.next_minutes)
    mae = lambda q: float(np.average(np.abs(va.next_gplus_p96 - q), weights=w))
    shrink = va.gplus_p96 * va.minutes_played / (va.minutes_played + K)
    folds.append({"test": f"{test}->{test + 1}", "n": int(len(va)), "mae_model": round(mae(p), 4), "mae_same_as_last_season": round(mae(va.gplus_p96), 4),
                  "mae_shrink_to_average": round(mae(shrink), 4), "spearman_model": round(float(spearmanr(p, va.next_gplus_p96).statistic), 3),
                  "spearman_same_as_last_season": round(float(spearmanr(va.gplus_p96, va.next_gplus_p96).statistic), 3)})
    resid.append(pd.DataFrame({"r": va.next_gplus_p96 - p, "bin": pd.cut(va.minutes_played, MIN_BINS, labels=False)}))
resid = pd.concat(resid)
band = resid.groupby("bin").r.quantile([0.1, 0.9]).unstack()
report = {"projection_validation": {"model": "RidgeCV on minutes-shrunk multi-season features + age", "folds": folds,
                                    "interval": "80% range from held-out residual quantiles by minutes band"}}
final = fit_ridge(pairs)
cur_out = df[(df.season == CUR) & ~df.is_gk]
mid = final.predict(cur_out[PROJ_FEATS].fillna(0)); b = pd.cut(cur_out.minutes_played, MIN_BINS, labels=False).values
df.loc[cur_out.index, "proj_mid"] = mid
df.loc[cur_out.index, "proj_lo"] = mid + band.loc[b, 0.1].values
df.loc[cur_out.index, "proj_hi"] = mid + band.loc[b, 0.9].values
# coverage check of the band on the pooled held-out residuals
report["projection_validation"]["interval_80_coverage_heldout"] = round(float(((resid.r >= band.loc[resid.bin, 0.1].values) & (resid.r <= band.loc[resid.bin, 0.9].values)).mean()), 3)
coef = pd.Series(final.coef_, index=PROJ_FEATS)
report["projection_coefficients"] = {k: round(float(v), 4) for k, v in coef.items()}

# projected values -> percentile vs this season's qualified pool of the same group
for col in ("proj_lo", "proj_mid", "proj_hi"):
    vals = pd.Series(np.nan, index=df.index)
    for g, idx in df[df.season == CUR].groupby("group").groups.items():
        pool = df.loc[idx][qualified.loc[idx]].gplus_p96.dropna().values
        vals.loc[idx] = df.loc[idx, col].apply(lambda v: np.nan if pd.isna(v) else 100 * (pool < v).mean())
    df[f"pct_{col}"] = vals

# ---------------------------------------------------------------- fair salary (what the league pays for this production)
SAL_FEATS = ["gplus_p96", "pct_Impact", "xgoals_p96", "xassists_p96", "key_passes_p96", "ga_passing_p96", "ga_interrupting_p96", "ga_receiving_p96",
             "ga_dribbling_p96", "ga_shooting_p96", "share_team_touches", "minutes_played", "count_games", "age", "prev_gplus_p96", "prev_minutes", "pos_code",
             "gk_shotstopping_p96"]
sal = df[(df.guaranteed_compensation > 0) & (df.minutes_played >= MIN_SHOW)].copy()
y = np.log(sal.guaranteed_compensation)
oof = np.zeros(len(sal))
for trn, tst in GroupKFold(5).split(sal, y, sal.player_id):
    m = lgb.LGBMRegressor(objective="huber", learning_rate=0.03, n_estimators=700, num_leaves=15, min_child_samples=25, subsample=0.8, subsample_freq=1,
                          colsample_bytree=0.8, verbose=-1, random_state=rng).fit(sal.iloc[trn][SAL_FEATS], y.iloc[trn])
    oof[tst] = m.predict(sal.iloc[tst][SAL_FEATS])
sal["fair_salary"] = np.exp(oof)
floor = df[df.guaranteed_compensation > 0].groupby("season").guaranteed_compensation.min()   # league minimum actually paid that season
sal["fair_salary"] = np.maximum(sal.fair_salary, sal.season.map(floor))
r2 = 1 - ((y - oof) ** 2).sum() / ((y - y.mean()) ** 2).sum()
report["fair_salary_model"] = {"target": "log guaranteed compensation (MLSPA)", "cv": "5-fold grouped by player, 2021-2026", "n": int(len(sal)),
                               "r2_log_oof": round(float(r2), 3), "median_abs_ratio_error": round(float(np.median(np.exp(np.abs(y - oof)))), 2)}
df = df.merge(sal[["player_id", "season", "fair_salary"]], on=["player_id", "season"], how="left")
df["value_ratio"] = df.fair_salary / df.guaranteed_compensation


def value_tag(r):
    if pd.isna(r.value_ratio): return "Unknown"
    if r.value_ratio >= 2.0 and r.pct_Impact >= 50: return "Bargain"
    if r.value_ratio <= 0.5 and r.pct_Impact < 80: return "Premium"
    return "Fair"


df["value_tag"] = df.apply(value_tag, axis=1)

out_cols = ["player_id", "season", "role", "comps", "proj_lo", "proj_mid", "proj_hi", "pct_proj_lo", "pct_proj_mid", "pct_proj_hi", "fair_salary", "value_ratio",
            "value_tag", "pct_Impact"] + [f"pct_{k}" for k in {**SKILLS, **GK_SKILLS}]
df[out_cols].to_json(DATA / "model_outputs.json", orient="records")
cur = df[(df.season == CUR) & (df.minutes_played >= MIN_SHOW)]
report["current_season"] = {"players_shown": int(len(cur)), "teams": int(cur.team_id.nunique()), "value_tags": cur.value_tag.value_counts().to_dict(),
                            "roles": cur.role.value_counts().to_dict()}
(DATA / "model_report.json").write_text(json.dumps(report, indent=1))
print(json.dumps(report, indent=1))
