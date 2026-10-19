"""
Mark the athletes from the SATKD poomsae para ranking sheet as para athletes
and set their para class.

Source: "Para 2026" sheet, columns
    Kategória | Klub | Priezvisko a meno | Ročník | Stupeň | ...
    "P20 II2" | "ŠKP TKD,ILYO KE" | "Bérešová Adriána" | 2002 | "2.Gup"

The category cell is turned into the class code the app uses:
    "P20 II1"    → P21     (P20 = intellectual impairment; the II sub-group
    "P20 II2"    → P22      decides the class, confirmed by tournament results:
    "P20 II3"    → P23      "P20 II2" athletes compete in Para P22)
    "P60 kadeti" → P60     (kadeti = cadets, an age group — ignored)
    "P34 "       → P34
    "P20 I"      → P21     (sheet shorthand, confirmed by the federation)
    "P20 III"    → P23
    "P30"        → P31
    anything else unknown (e.g. a bare "P20") → UNCLEAR, not updated.
                   Decide by hand, put it in MANUAL_CLASSES, run again.

Firestore update per athlete (taekwondo profile only):
    sports.taekwondo.isPara       = True
    sports.taekwondo.paraCategory = "P20"

Matching: names compared lowercase, without diacritics, in both orders
("Bérešová Adriána" = "Adriána Bérešová"), against displayName and
firstName + lastName. Birth year (Ročník) is used to pick between people with
the same name, and a single match with a different birth year is NOT updated.

Report sections:
  - not found                     → closest names in the database
  - more than one match           → every candidate, nobody updated
  - birth year differs            → not updated, check by hand
  - no taekwondo profile          → not updated
  - class unclear / not allowed   → not updated (use MANUAL_CLASSES)
  - class changes (P21 → P20)     → updated, listed so you can check
  - already set                   → untouched

Run with:
    pip install firebase-admin openpyxl --break-system-packages
    python add_para_category.py

DRY_RUN = True (default) only prints. Check the report, then set
DRY_RUN = False and run again.
"""

import difflib
import re
import unicodedata
from collections import defaultdict

import openpyxl

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CREDS_PATH = "google_creds.json"
XLSX_PATH = "bodovy-kalendar-poomsae-2026-para-7-6.xlsx"
SHEET = "Para 2026"
COLLECTION = "athletes"
SPORT = "taekwondo"
DRY_RUN = False
REPORT_PATH = "para_import_report.txt"

# Must match PARA_CATEGORIES in tournament_router.py / create_athlete.html /
# tournament.html, otherwise the athlete can't be saved from the edit page.
VALID_CATEGORIES = {
    "P11", "P12",
    "P21", "P22", "P23",
    "P31", "P32", "P33", "P34", "P35",
    "P41", "P42", "P43", "P44", "P45",
    "P51", "P52", "P53",
    "P60",
    "P72",
}

# Group + sub-group written in the sheet → class code.
# A sub-group of "" means the cell has no sub-group at all ("P30").
SUBCLASS_MAP = {
    ("P20", "II1"): "P21",
    ("P20", "II2"): "P22",
    ("P20", "II3"): "P23",
    ("P20", "I"):   "P21",   # sheet shorthand for II1
    ("P20", "III"): "P23",   # sheet shorthand for II3
    ("P30", ""):    "P31",
}

# Classes you decide by hand for rows the sheet leaves unclear, keyed by the
# name exactly as written in the sheet. Example:
#     "Orosi Ján": "P23",
MANUAL_CLASSES = {
}

COL_CATEGORY, COL_CLUB, COL_NAME, COL_YEAR = 0, 1, 2, 3

TITLES = {"ing", "mgr", "bc", "phdr", "paeddr", "judr", "mudr", "rndr", "phd", "ml", "st", "dr", "doc", "prof"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def strip_diacritics(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value or "")
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def name_tokens(value: str) -> list:
    words = re.split(r"[\s,]+", strip_diacritics(value).lower())
    words = [w.strip(".") for w in words]
    return [w for w in words if w and w not in TITLES]


def name_keys(value: str) -> set:
    tokens = name_tokens(value)
    if not tokens:
        return set()
    keys = {" ".join(tokens)}
    if len(tokens) >= 2:
        keys.add(" ".join(tokens[1:] + tokens[:1]))
        keys.add(" ".join(tokens[-1:] + tokens[:-1]))
    return keys


def base_category(value) -> str:
    """'P20 II2 ' → 'P20', 'P60 kadeti' → 'P60', anything else → ''"""
    m = re.match(r"\s*P\s*(\d{2})", str(value or ""), re.IGNORECASE)
    return f"P{m.group(1)}" if m else ""


def resolve_category(value) -> str:
    """'P20 II2' → 'P22', 'P20 III' → 'P23', 'P30' → 'P31', 'P60 kadeti' → 'P60'.
    Returns the bare group (e.g. 'P20') when nothing in SUBCLASS_MAP fits —
    that is not a valid class and gets reported as unclear."""
    base = base_category(value)
    rest = re.sub(r"^\s*P\s*\d{2}", "", str(value or ""), flags=re.IGNORECASE)
    sub = re.search(r"\b(II[1-3]|III|II|I)\b", rest.upper())
    key = (base, sub.group(1) if sub else "")
    return SUBCLASS_MAP.get(key, base)


def birth_year(data: dict):
    b = data.get("birthday")
    if hasattr(b, "year"):
        return b.year
    m = re.match(r"(\d{4})", str(b or ""))
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------------------
# Read the sheet
# ---------------------------------------------------------------------------
def read_para_athletes(path: str):
    """Rows stop at the first empty name cell (the scoring table below)."""
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True)[SHEET]
    rows, started = [], False
    for r in ws.iter_rows(values_only=True):
        if not r or len(r) <= COL_YEAR:
            if started:
                break
            continue
        raw_cat, name = r[COL_CATEGORY], r[COL_NAME]
        if not started:
            if base_category(raw_cat) and isinstance(name, str):
                started = True
            else:
                continue
        if not (isinstance(name, str) and name.strip()):
            break
        year = r[COL_YEAR]
        clean_name = " ".join(name.split())
        rows.append({
            "name": clean_name,
            "raw_category": " ".join(str(raw_cat or "").split()),
            "category": MANUAL_CLASSES.get(clean_name) or resolve_category(raw_cat),
            "club": " ".join(str(r[COL_CLUB] or "").split()),
            "year": int(year) if isinstance(year, (int, float)) else None,
        })
    return rows


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------
def build_index(athletes):
    index = defaultdict(list)
    for doc_id, data in athletes:
        keys = name_keys(data.get("displayName") or "")
        keys |= name_keys(f"{data.get('firstName', '')} {data.get('lastName', '')}")
        for k in keys:
            index[k].append(doc_id)
    return index


def match(rows, athletes):
    by_id = dict(athletes)
    index = build_index(athletes)
    all_keys = list(index.keys())
    res = {k: [] for k in ("update", "changed", "already", "not_found", "duplicates",
                           "year_mismatch", "no_sport", "bad_category", "picked_by_year")}

    for row in rows:
        if row["category"] not in VALID_CATEGORIES:
            res["bad_category"].append(row)
            continue

        ids = []
        for k in name_keys(row["name"]):
            for i in index.get(k, []):
                if i not in ids:
                    ids.append(i)

        if not ids:
            sugg = []
            for s in difflib.get_close_matches(" ".join(name_tokens(row["name"])), all_keys, n=3, cutoff=0.75):
                for i in index[s]:
                    sugg.append(f"{by_id[i].get('displayName') or s} ({i}, born {birth_year(by_id[i]) or '?'})")
            res["not_found"].append((row, list(dict.fromkeys(sugg))))
            continue

        if len(ids) == 1:
            chosen = ids[0]
            y = birth_year(by_id[chosen])
            if row["year"] and y and y != row["year"]:
                res["year_mismatch"].append((row, chosen))
                continue
        else:
            same_year = [i for i in ids if row["year"] and birth_year(by_id[i]) == row["year"]]
            if len(same_year) != 1:
                res["duplicates"].append((row, ids))
                continue
            chosen = same_year[0]
            res["picked_by_year"].append((row, chosen, ids))

        sd = (by_id[chosen].get("sports") or {}).get(SPORT)
        if not isinstance(sd, dict):
            res["no_sport"].append((row, chosen))
        elif sd.get("isPara") and sd.get("paraCategory") == row["category"]:
            res["already"].append((row, chosen))
        elif sd.get("isPara") and sd.get("paraCategory"):
            res["changed"].append((row, chosen, sd.get("paraCategory")))
        else:
            res["update"].append((row, chosen))
    return res


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
def describe(i, d):
    sd = (d.get("sports") or {}).get(SPORT) or {}
    para = f"para {sd.get('paraCategory')}" if sd.get("isPara") else "not para"
    name = d.get("displayName") or f"{d.get('firstName', '')} {d.get('lastName', '')}".strip()
    return f"{name} | id {i} | club {sd.get('clubName') or '-'} | born {birth_year(d) or '?'} | {para}"


def row_info(r):
    return f"{r['name']} [{r['raw_category']} → {r['category'] or '?'}; {r['club']}; born {r['year'] or '?'}]"


def make_report(res, by_id, total):
    n = lambda k: len(res[k])
    L = [f"Para athletes in sheet: {total}",
         f"  will be set para        : {n('update')}",
         f"  class will change       : {n('changed')}",
         f"  already correct         : {n('already')}",
         f"  NOT FOUND               : {n('not_found')}",
         f"  MORE THAN ONE MATCH     : {n('duplicates')}",
         f"  BIRTH YEAR DIFFERS      : {n('year_mismatch')}",
         f"  no {SPORT} profile    : {n('no_sport')}",
         f"  CLASS UNCLEAR           : {n('bad_category')}",
         f"  (picked by birth year   : {n('picked_by_year')})"]

    L.append("\n=== NOT FOUND (not updated) ===")
    for r, sugg in res["not_found"]:
        L.append(f"- {row_info(r)}")
        if sugg:
            L.append(f"    similar in database: {'; '.join(sugg)}")

    L.append("\n=== MORE THAN ONE MATCH (not updated) ===")
    for r, ids in res["duplicates"]:
        L.append(f"- {row_info(r)}")
        L += [f"    · {describe(i, by_id[i])}" for i in ids]

    L.append("\n=== NAME MATCHES BUT BIRTH YEAR DIFFERS (not updated) ===")
    for r, i in res["year_mismatch"]:
        L.append(f"- {row_info(r)}\n    · {describe(i, by_id[i])}")

    L.append(f"\n=== NO {SPORT.upper()} PROFILE (not updated) ===")
    for r, i in res["no_sport"]:
        L.append(f"- {row_info(r)}\n    · {describe(i, by_id[i])}")

    L.append("\n=== CLASS UNCLEAR — set it in MANUAL_CLASSES (not updated) ===")
    L += [f"- {row_info(r)}" for r in res["bad_category"]]

    L.append("\n=== SEVERAL MATCHES, PICKED BY BIRTH YEAR (updated — double-check) ===")
    for r, chosen, ids in res["picked_by_year"]:
        L.append(f"- {row_info(r)}")
        L += [f"    {'→' if i == chosen else '·'} {describe(i, by_id[i])}" for i in ids]

    L.append("\n=== CLASS CHANGES (updated — double-check) ===")
    for r, i, old in res["changed"]:
        L.append(f"- {r['name']}: {old} → {r['category']}   ({describe(i, by_id[i])})")

    L.append("\n=== WILL BE SET PARA ===" if DRY_RUN else "\n=== SET PARA ===")
    for r, i in res["update"]:
        L.append(f"- {r['name']} → {r['category']}   ({describe(i, by_id[i])})")

    L.append("\n=== ALREADY CORRECT (unchanged) ===")
    for r, i in res["already"]:
        L.append(f"- {r['name']} → {r['category']}")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    import firebase_admin
    from firebase_admin import credentials, firestore

    rows = read_para_athletes(XLSX_PATH)
    print(f"Read {len(rows)} para athletes from {XLSX_PATH} / {SHEET}")

    firebase_admin.initialize_app(credentials.Certificate(CREDS_PATH))
    db = firestore.client()
    athletes = [(d.id, d.to_dict() or {}) for d in db.collection(COLLECTION).stream()]
    print(f"Loaded {len(athletes)} athletes from Firestore")

    res = match(rows, athletes)

    to_write = [(r, i) for r, i in res["update"]] + [(r, i) for r, i, _ in res["changed"]]
    if not DRY_RUN and to_write:
        batch = db.batch()
        for r, doc_id in to_write:
            batch.update(db.collection(COLLECTION).document(doc_id), {
                f"sports.{SPORT}.isPara": True,
                f"sports.{SPORT}.paraCategory": r["category"],
            })
        batch.commit()

    report = make_report(res, dict(athletes), len(rows))
    print("\n" + ("[DRY RUN — nothing written]\n" if DRY_RUN else "") + report)
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(report + "\n")
    print(f"\nReport saved to {REPORT_PATH}")


if __name__ == "__main__":
    main()