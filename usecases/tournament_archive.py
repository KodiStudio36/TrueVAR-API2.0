"""
Groups archived tournaments into the series → season → day → event tree
that templates/past_tournaments.html renders, and picks the home-page
showcase from it.

Firestore has no "series" concept, so a series is derived from the title:
    "18th International Ilyo Cup 2026 Kyorugi Day 2"
        series      → "International Ilyo Cup"
        edition     → "18th edition"
        discipline  → "Kyorugi"
A tournament can override this with a `series` / `seriesName` attribute.

Days are numbered by calendar date inside a season (first date = Day 1),
so "Day N" in the title doesn't have to be right — or present at all.
"""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

_ORDINAL = re.compile(r"^\s*(\d+)\s*(st|nd|rd|th)\.?\s+", re.I)
_YEAR = re.compile(r"\b(19|20)\d{2}\b")
_DAY = re.compile(r"\bday\s*\d+\b", re.I)
_DISCIPLINES = ("kyorugi", "poomsae", "kyorugi & poomsae", "kyorugi and poomsae")
_DISCIPLINE = re.compile(
    r"\b(" + "|".join(sorted((re.escape(d) for d in _DISCIPLINES), key=len, reverse=True)) + r")\b",
    re.I,
)
_TRIM = " \t-–—·,:|/"


# ── helpers ───────────────────────────────────────────────────────────────

def _attr(t: Any, *names: str, default=None):
    """Read the first present attribute (works for models and dicts)."""
    for n in names:
        v = t.get(n) if isinstance(t, dict) else getattr(t, n, None)
        if v not in (None, ""):
            return v
    return default


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def parse_title(title: str) -> dict:
    """Split a tournament title into series name, edition, discipline, year."""
    title = (title or "").strip()
    edition = None
    m = _ORDINAL.match(title)
    if m:
        edition = f"{m.group(1)}{m.group(2).lower()} edition"
        title = title[m.end():]

    year_m = _YEAR.search(title)
    disc_m = _DISCIPLINE.search(title)
    discipline = None
    if disc_m:
        d = disc_m.group(1).lower()
        discipline = "Kyorugi & Poomsae" if "&" in d or " and " in d else d.capitalize()

    name = _DAY.sub(" ", title)
    name = _DISCIPLINE.sub(" ", name)
    name = _YEAR.sub(" ", name)
    name = re.sub(r"\s+", " ", name).strip(_TRIM)

    return {
        "name": name or (title or "Untitled"),
        "edition": edition,
        "discipline": discipline,
        "year": int(year_m.group(0)) if year_m else None,
    }


def _replay_url(t: Any) -> Optional[str]:
    """Replay link stored on the tournament (replayUrl / replay_url), if any."""
    v = _attr(t, "replayUrl", "replay_url")
    return v.strip() if isinstance(v, str) and v.strip() else None


# ── archive tree ──────────────────────────────────────────────────────────

def build_series(tournaments: Iterable[Any]) -> list[dict]:
    """
    Returns, newest series first:
      [{ name, slug, sport, location, latest (datetime|None),
         seasons: [{ year, edition, days: [{ label, date, date_obj,
             events: [{ id, name, replay, replay_url, dateTime }] }] }] }]
    """
    groups: dict[tuple, list] = defaultdict(list)
    parsed: dict[int, dict] = {}

    for t in tournaments:
        p = parse_title(_attr(t, "title", default=""))
        override = _attr(t, "series", "seriesName")
        if override:
            p["name"] = override
        sport = (_attr(t, "sport", default="") or "").lower() or "multi-sport"
        parsed[id(t)] = p
        groups[(slugify(p["name"]), sport)].append(t)

    series = []
    for (slug, sport), items in groups.items():
        seasons_map: dict[Optional[int], list] = defaultdict(list)
        for t in items:
            dt = _as_utc(_attr(t, "dateTime"))
            year = dt.year if dt else parsed[id(t)]["year"]
            seasons_map[year].append(t)

        seasons = []
        for year, s_items in seasons_map.items():
            # one "day" per calendar date, in order
            by_date: dict[Optional[Any], list] = defaultdict(list)
            for t in s_items:
                dt = _as_utc(_attr(t, "dateTime"))
                by_date[dt.date() if dt else None].append(t)

            dated = sorted(d for d in by_date if d is not None)
            days = []
            for i, d in enumerate(dated + ([None] if None in by_date else []), start=1):
                events = []
                for t in sorted(by_date[d], key=lambda x: _attr(x, "title", default="")):
                    p = parsed[id(t)]
                    url = _replay_url(t)
                    events.append({
                        "id": _attr(t, "id"),
                        "name": p["discipline"] or sport.replace("-", " ").title(),
                        "replay": bool(url),
                        "replay_url": url,
                        "dateTime": _as_utc(_attr(t, "dateTime")),
                    })
                days.append({
                    "label": f"Day {i}" if d else "Date TBA",
                    "date": d.strftime("%a %d %b") if d else "",
                    "date_obj": d,
                    "events": events,
                })

            editions = [parsed[id(t)]["edition"] for t in s_items if parsed[id(t)]["edition"]]
            seasons.append({
                "year": year if year is not None else "—",
                "_sort": year or 0,
                "edition": editions[0] if editions else None,
                "days": days,
            })
        seasons.sort(key=lambda s: s["_sort"], reverse=True)

        dts = [dt for dt in (_as_utc(_attr(t, "dateTime")) for t in items) if dt]
        latest = max(dts) if dts else None
        newest = max(items, key=lambda t: _as_utc(_attr(t, "dateTime")) or datetime.min.replace(tzinfo=timezone.utc))

        series.append({
            "name": parsed[id(newest)]["name"],
            "slug": slug,
            "sport": sport,
            "location": _attr(newest, "location", default="Location TBA"),
            "latest": latest,
            "seasons": seasons,
        })

    series.sort(key=lambda s: s["latest"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return series


# ── home-page showcase ────────────────────────────────────────────────────

def _date_range(days: list[dict]) -> str:
    dates = [d["date_obj"] for d in days if d["date_obj"]]
    if not dates:
        return "Date TBA"
    a, b = min(dates), max(dates)
    if a == b:
        return a.strftime("%d %b")
    if (a.year, a.month) == (b.year, b.month):
        return f"{a:%d}–{b:%d %b}"
    return f"{a:%d %b} – {b:%d %b}"


def build_showcase(series: list[dict], count: int = 5) -> list[dict]:
    """
    One card per series, using its newest season. Series that have a
    replay are preferred so the replay-only cards (slots 4–5) always
    have something to play.
    """
    def first_replay(season) -> Optional[str]:
        for d in season["days"]:
            for e in d["events"]:
                if e["replay_url"]:
                    return e["replay_url"]
        return None

    with_replay = [s for s in series if first_replay(s["seasons"][0])]
    without = [s for s in series if not first_replay(s["seasons"][0])]
    picked = (with_replay + without)[:count]
    picked.sort(key=lambda s: s["latest"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

    out = []
    for s in picked:
        season = s["seasons"][0]
        disciplines = sorted({e["name"] for d in season["days"] for e in d["events"]})
        n_days = len(season["days"])
        note_parts = []
        if any(x in ("Kyorugi", "Poomsae") for x in disciplines):
            note_parts.append(" · ".join(disciplines))
        elif n_days > 1:
            note_parts.append(f"{n_days} days")
        edition = season.get("edition")
        title = f"{edition.split()[0]} {s['name']}" if edition else s["name"]
        archive_link = f"/tournaments/past#{s['slug']}"
        out.append({
            "title": title,
            "sport": s["sport"],
            "location": s["location"],
            "dates": _date_range(season["days"]),
            "year": str(season["year"]),
            "note": " · ".join(note_parts) or None,
            "results_url": archive_link,
            "replay_url": first_replay(season) or archive_link,
        })
    return out


def count_events(series: list[dict]) -> int:
    return sum(len(d["events"]) for s in series for se in s["seasons"] for d in se["days"])