# Moneyball MLS

**A machine-learning scouting board for all 30 Major League Soccer clubs, with a scouting pool across the Americas.** It shows each player's role, skill shape, comparable players, next-season outlook and contract value as pictures and plain words instead of spreadsheets, and rates players in USL, MLS NEXT Pro, the Canadian Premier League, Liga MX and South America on the same MLS scale, so a club can see who would be good enough to sign.

**Live app:** https://moneyball-mls.web.app

![Scout board](docs/board.png)

## What a scout sees

| View | What it answers |
|---|---|
| **Scout board** | Player cards: role, a skill-shape radar, top skills with their exact rating, the overall rating for this season plus projections for the next three seasons (each with its 80% range), contract tag (Bargain / Fair / Premium) and sample-size dots. Filter by tapping positions on a pitch, age, budget, role, club or "quick looks" (Moneyball picks, hidden gems U23, ready now, upside). |
| **Player profile** | A one-paragraph scouting summary; skill shape and exact skill ratings; *where he adds value* on a pitch (bubbles for winning the ball, passing, carrying, getting on the ball, shooting); a rating timeline of the last five seasons and the next three with labelled numbers and a widening 80% range; pay vs what the production usually earns; three players with the closest style since 2015. |
| **Value map** | Level vs pay for every player. The gold corner is where bargains live. |
| **Clubs** | Each club's most-used XI on a pitch (ring = level, fill = contract value) plus its bargains and full squad. |
| **Shortlist** | Saved players (MLS and Americas targets), with up to three skill shapes overlaid for comparison. |
| **Scout pool: Americas targets** | Switch the board from *MLS squads* to *Americas targets* (or *Both*). Every player outside MLS gets his rating inside his own league and an **MLS-ready rating**: the 0–100 MLS rating he would likely have next season, with an 80% range. Filter by region, league, lowest MLS-ready rating, under-23 upside, national-team players or US/Canadian passport. The value map becomes *age vs level*. |
| **Clubs: upgrade targets** | For each club's three weakest XI slots, players outside MLS whose MLS-ready rating beats the current starter by 10+. |
| **Leagues & nations** | Each league's strength on the MLS scale, where MLS players come from (player moves into MLS by league), and the national-team pools of every Americas nation (2026 World Cup, 2025 Gold Cup, Nations League, World Cup qualifying, 2024 Copa América). |

**Ratings run 0–100**: the share of players in the same position group this season that the player beats (89 = better than 89% of attackers). Colours mark five bands: 90+ Elite, 70–89 Strong, 40–69 Solid, 20–39 Developing, under 20 Weak.

![Player profile](docs/profile.png)

## Machine learning

| Model | Method | Validation |
|---|---|---|
| **Playing roles** | k-means within each position (CB, FB, DM/CM, AM, W, ST, GK) on a 13-feature style profile, 900+ minute seasons 2015–2026. Clusters are named by rules on their centroids, for example ball-playing centre-back vs stopper. | Centroids inspected; 16 roles |
| **Plays like** | Cosine similarity on the same standardized style profile, searching every MLS season since 2015 | – |
| **Next three seasons** | One ridge regression per horizon (2027, 2028, 2029) on minutes-weighted, multi-season goals added (shrunk toward the position average), style and age, trained on MLS 2015–2025. LightGBM quantile models and simple shrinkage were tested and did worse. Each 80% range comes from held-out residuals by minutes band. | Rolling, honest splits (see below) |
| **Contract value** | LightGBM on production, age and position predicting log guaranteed pay (what MLS usually pays for that production); out-of-fold predictions grouped by player, floored at the league minimum, 2021–2026 | R² 0.523 on log pay (5-fold, 3,783 player-seasons); typical miss ×1.62 |

Projection error (minutes-weighted MAE in goals added per 96 minutes, averaged over test seasons; lower is better). Each model is trained only on pairs whose target season is no later than the forecast season:

| Projection | Test seasons | Ridge model | Same as last season | Shrink to average | Rank corr. | 80% range hit |
|---|---|---|---|---|---|---|
| 2027 (1 season ahead) | 6 | **0.0416** | 0.0512 | 0.043 | 0.429 | 80% |
| 2028 (2 seasons ahead) | 5 | **0.0431** | 0.0528 | 0.0441 | 0.381 | 80% |
| 2029 (3 seasons ahead) | 3 | **0.0456** | 0.0574 | 0.047 | 0.216 | 80% |

The model beats both baselines at every horizon, but ranking accuracy falls with distance, so the ranges widen. Treat 2029 as a rough guide. Projections assume the player is still in MLS with regular minutes.

Tags: **Bargain** means paid less than half of the model's fair pay while performing at least at Solid level. **Premium** means paid more than twice the fair pay and not Elite. **★ Moneyball pick** means a Bargain expected to stay at least Solid next season. With the April 2026 MLSPA release, that gives 41 bargains among 637 players.

## Scouting the Americas

| League group | Source | Data | How the MLS-ready rating is made |
|---|---|---|---|
| USL Championship, USL League One, MLS NEXT Pro | American Soccer Analysis | goals added, xG, xPass (same as MLS) | Ridge model trained on every player who moved from these leagues to MLS the next season |
| Liga MX, Brasileirão A and B, Argentina (Liga Profesional, Primera Nacional), Colombia, Chile, Ecuador, Paraguay, Peru | ESPN public soccer data (regular phases only, playoffs excluded) | box score (primary assists; stats a league does not record are left out); passing and defending where recorded | Box score → goals added (learned inside MLS), league strength from club results 2023–2026 incl. Leagues Cup, Concacaf Champions Cup, Libertadores, Sudamericana and Club World Cup, scaled by one factor fitted on players who moved to MLS; calibration from MLS players' consecutive seasons |
| Canadian Premier League | StatsCrew team pages (crawl delay respected) | box score | Same as ESPN leagues, with the shared box-score features |
| National teams of the Americas | ESPN | appearances, minutes, goals | Shown as caps on every card and as national-team pools |

Validation numbers for each step are in the app (*How it works*) and in `data/scouting_report.json`. Leagues without published player statistics (Uruguay, Venezuela, Bolivia, Central America, Liga de Expansión MX) appear only through national teams. There is no salary or transfer-fee data outside MLS, so targets have no contract tag.

## Data

* [American Soccer Analysis](https://www.americansocceranalysis.com/) public API: xGoals, xPass and goals added (g+) for players and goalkeepers, MLS 2015–2026 (2026 season to date, fetched 10 Oct 2026).
* Guaranteed compensation from MLS Players Association salary releases, as provided by ASA (latest: 16 Apr 2026).
* 30 clubs in 2026, including San Diego FC; 637 players with 300+ minutes are shown.

Raw API responses are cached in `data/raw/` and are not committed. Run the pipeline to rebuild everything.

## Rebuild

```bash
pip install pandas numpy scikit-learn lightgbm scipy
python3 pipeline/fetch_asa.py        # ASA API -> data/raw/ (cached)
python3 pipeline/build_dataset.py    # -> data/player_seasons.csv (one row per player-season)
python3 pipeline/train_models.py     # roles, comps, projection, fair salary -> data/model_outputs.json, data/model_report.json
python3 pipeline/fetch_asa.py --league all   # USL Championship, USL League One, MLS NEXT Pro -> data/raw/asa/
python3 pipeline/fetch_espn.py       # Americas leagues + national teams (ESPN public data) -> data/raw/espn/ (slow, cached)
python3 pipeline/fetch_cpl.py        # Canadian Premier League (StatsCrew) -> data/raw/cpl/
python3 pipeline/fetch_results.py    # club results incl. cross-league cups (ESPN) -> data/raw/espn_results/
python3 pipeline/build_americas.py   # -> data/scout_espn_seasons.csv, scout_cpl_seasons.csv, national_caps.csv, id_links.csv
python3 pipeline/train_scouting.py   # MLS-ready ratings, league strength, comparables -> data/scouting_outputs.json
python3 pipeline/export_web.py       # -> website/data/*.json (targets.json + per-league details in website/data/targets/)
python3 -m http.server 8000 --directory website
```

Deploy: `firebase deploy --only hosting:moneyball-mls --project moneyball-3-1`.

## Limits

* Event data does not see off-ball work, pressing, character, injuries or tactical fit. Use it to decide whom to watch, not whom to sign.
* Small samples (one filled dot = under 900 minutes) swing a lot. Goalkeepers have levels and roles but no next-season projection yet.
* Contract tags ignore transfer fees, allocation money, roster designations and how a player was acquired.
* Goals added is ASA's model; its values are above average for the player's position.
* MLS-ready ratings assume regular MLS minutes. Movers who never got minutes are not in the training data, and box-score leagues predict less well than leagues with goals-added data (see the validation in the app). Style, adaptation, injuries and roster rules (international slots) are not in the data.
* ESPN's soccer endpoints are public but undocumented; coverage varies by league and season.

## Project history

This repository started as *Moneyball 3.1* (undervalued MLB hitters, Oct 2026) and was reworked into an MLS machine-learning project.

Built by Hendro Setyawan. Not affiliated with Major League Soccer, the MLSPA, American Soccer Analysis, ESPN or StatsCrew.
