"""Fetch Canadian Premier League player seasons from StatsCrew team pages into data/raw/cpl/ (cached).

ESPN does not carry the CPL, so this adds basic per-player stats (games, starts, minutes, goals, assists,
fouls, cards, offsides, shots, shots on goal) for 2023-2026, honouring the site's 5-second crawl delay.
Usage: python3 pipeline/fetch_cpl.py [--refresh]
"""
import json, re, sys, time, urllib.request
from html.parser import HTMLParser
from pathlib import Path

RAW = Path(__file__).resolve().parents[1] / "data" / "raw" / "cpl"
BASE = "https://www.statscrew.com/minorsoccer"
SEASONS = [2023, 2024, 2025, 2026]
REFRESH = "--refresh" in sys.argv


def get(url):
    time.sleep(5)  # robots.txt Crawl-Delay
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (moneyball_MLS educational scouting project)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "ignore")


class Tables(HTMLParser):
    """collect every table as rows of cell text"""
    def __init__(self):
        super().__init__(); self.tables, self.row, self.cell, self.inside = [], None, None, False

    def handle_starttag(self, tag, attrs):
        if tag == "table": self.tables.append([])
        elif tag == "tr" and self.tables: self.row = []
        elif tag in ("td", "th") and self.row is not None: self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None: self.row.append(" ".join("".join(self.cell).split())); self.cell = None
        elif tag == "tr" and self.row is not None: self.tables[-1].append(self.row); self.row = None

    def handle_data(self, data):
        if self.cell is not None: self.cell.append(data)


def team_page(code, season):
    p = Tables(); html = get(f"{BASE}/stats/t-{code}/y-{season}"); p.feed(html)
    name = re.search(r"<title>(.*?)</title>", html, re.S)
    out = []
    for t in p.tables:
        if not t or t[0][:2] != ["Player", "Pos"]: continue
        head = t[0]
        for r in t[1:]:
            if len(r) == len(head) and r[0]: out.append(dict(zip(head, r)))
    return {"code": code, "title": name and " ".join(name.group(1).split()), "players": out}


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    for s in SEASONS:
        out = RAW / f"{s}.json"
        if out.exists() and not REFRESH: print("cached", out.name); continue
        codes = sorted(set(re.findall(r"t-(CPL[A-Z]+)", get(f"{BASE}/standings/l-CPL/y-{s}"))))
        teams = [team_page(c, s) for c in codes]
        out.write_text(json.dumps({"league": "Canadian Premier League", "season": s, "source": "statscrew.com", "teams": teams}, ensure_ascii=False))
        print(s, len(teams), "teams,", sum(len(t["players"]) for t in teams), "player rows")
