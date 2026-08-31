"""
upload_athletes.py

Reads an athlete export (.xlsx) and pushes them into Firestore's /athletes
collection (auto-generated document IDs), matching the schema:

{
    "birthday": Timestamp,
    "country": "SVK",
    "createdAt": Timestamp (server time),
    "displayName": "First Last",
    "firstName": "first"  (lowercase, no diacritics),
    "lastName": "last"    (lowercase, no diacritics),
    "gender": "male" | "female",
    "sports": {
        "taekwondo": {
            "associationId": "SATKD...",
            "clubId": "<mapped club id>",
            "clubName": "<original club name from the export>",
            "rank": <int>
        }
    }
}

Expected .xlsx columns (header row required, any sheet name):
    regnr, name, surname, gender(F/M), birthdate(dd.mm.yyyy),
    Stupeň (rank number), GUP/DAN (rank type, POOM counts as DAN),
    latest_sport_orgs ID, latest_sport_orgs NAME, Camp Snina

The "latest_sport_orgs ID" and "Camp Snina" columns are present in the
export but are NOT used by this script (per current requirements) --
club identity is resolved from "latest_sport_orgs NAME" via
CLUB_NAME_TO_ID below.

Usage:
    pip install -r requirements.txt
    python upload_athletes.py athletes.xlsx

    # Mock data for tournament testing:
    python upload_athletes.py --mock         # create 3 mock clubs x 15 mock athletes
    python upload_athletes.py --mock-clean   # delete all mock clubs/athletes again

Requires a Firebase service account key at ./google_creds.json
(or set GOOGLE_APPLICATION_CREDENTIALS env var to its path).
"""

import sys
import unicodedata
import datetime
from pathlib import Path

import pandas as pd
import firebase_admin
from firebase_admin import credentials, firestore

# -----------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------

# Map club names (as they appear in the "latest_sport_orgs NAME" column)
# to their Firestore clubId. Add more entries here as new clubs show up
# in future exports.
CLUB_NAME_TO_ID = {
    "TAEKWONDO HAKIMI Rožňava": "hakimi",
    "Športový klub polície - ILYO Taekwondo Košice": "ilyoke",
    "KORYO TAEKWONDO SLÁVIA UPJŠ KOŠICE": "koryo",
    "Black Tiger Taekwondo - Klub Snina": "black_tiger",
    "Falcon Taekwondo klub Rimavská Sobota": "falcon",
    "Haneul Taekwondo Trenčín": "haneul",
    # New clubs seen in the 2026-08-02 export. IDs below are
    # auto-generated slugs (diacritics stripped, lowercased,
    # non-alphanumerics -> "_") -- rename them here if you'd prefer
    # shorter/different ids, e.g. to match the "hakimi"/"ilyoke" style.
    "TAEKWONDO KLUB Hnúšťa": "hnusta",
    "Taekwondo klub Humenné": "humenne",
    "ILYO Taekwondo Zvolen": "zvolen",
    "Športový klub polície Ryong Bratislava": "ryong",
    "ILYO - TAEKWONDO TRENČÍN": "trencin",
    "KORYO PANTHERS TAEKWONDO Rožňava": "roznava",
    "Taekwondo 4U Liptovský Mikuláš": "mikulas",
    "Star Klub Bojovych umeni": "star_klub",
    "Ilyo Taekwondo Prešov": "presov",
    # Known club id with no export example yet:
    # "<exact club name>": "ryong",
}

VALID_CLUB_IDS = {
    "falcon",
    "black_tiger",
    "hakimi",
    "haneul",
    "ilyoke",
    "koryo",
    "ryong",
    "hnusta",
    "humenne",
    "zvolen",
    "trencin",
    "roznava",
    "mikulas",
    "star_klub",
    "presov",
}

# Rank types that should be treated identically to "DAN" for the
# purposes of the numeric `rank` field (per-organization convention:
# POOM ranks are junior black-belt equivalents of DAN ranks).
RANK_TYPE_ALIASES = {
    "DAN": "DAN",
    "POOM": "DAN",
    "GUP": "GUP",
}

COUNTRY = "SVK"
COLLECTION_NAME = "athletes"
BATCH_SIZE = 400  # Firestore batch limit is 500 writes

# Columns from the export that are intentionally not used.
IGNORED_COLUMNS = {"latest_sport_orgs ID", "Camp Snina"}

# -----------------------------------------------------------------------
# Mock data (for tournament testing)
# -----------------------------------------------------------------------
#
# `python upload_athletes.py --mock` writes MOCK_CLUB_COUNT clubs (in a
# top-level "clubs" collection) and MOCK_ATHLETES_PER_CLUB athletes per
# club (in "athletes") using deterministic, human-readable document IDs
# and names so they're trivial to find/query/delete again later:
#
#   clubs/mock_club_1        name: "Mock Club 1"
#   athletes/mock_athlete_1  displayName: "Mock Athlete 1"  clubId: "mock_club_1"
#   ...
#
# Every mock document also gets `"isMock": True`, so you can always find
# (or wipe) every bit of mock data with a single query:
#
#   db.collection("athletes").where("isMock", "==", True).stream()
#
# `python upload_athletes.py --mock-clean` deletes everything tagged
# isMock == True from both collections.
#
# 15 athletes per club (45 total, up from 5/club) — enough headroom for
# category_manager.html's "Load Test Data" tool to build a realistic
# spread of populated categories (2-5 distinct entrants each) across
# every age division without running out of distinct athletes to draw
# from within any single category.

CLUBS_COLLECTION_NAME = "clubs"
MOCK_CLUB_COUNT = 3
MOCK_ATHLETES_PER_CLUB = 15


def build_mock_club_doc(club_number: int) -> dict:
    """Build one mock club doc matching the /clubs schema."""
    name = f"Mock Club {club_number}"
    return {
        "country": COUNTRY,
        "lowerName": name.lower(),
        "name": name,
        "simpleName": f"mock club {club_number}",
        "sport": "taekwondo",
        "state": f"Mock State {club_number}",
        "isMock": True,
    }


def build_mock_athlete_doc(club_number: int, athlete_number: int, global_number: int) -> dict:
    """Build one mock athlete doc matching the /athletes schema."""
    display_name = f"Mock Athlete {global_number}"
    club_id = f"mock_club_{club_number}"
    club_name = f"Mock Club {club_number}"
    gender = "male" if global_number % 2 == 1 else "female"
    # Deterministic but varied rank: cycles through GUP/DAN-style values.
    rank = global_number % 15

    return {
        "birthday": datetime.datetime(2000 + club_number, 1, athlete_number, tzinfo=datetime.timezone.utc),
        "country": COUNTRY,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "displayName": display_name,
        "firstName": "mock",
        "lastName": f"athlete{global_number}",
        "gender": gender,
        "isMock": True,
        "sports": {
            "taekwondo": {
                "associationId": f"MOCK{global_number:03d}",
                "clubId": club_id,
                "clubName": club_name,
                "rank": rank,
            }
        },
    }


def upload_mock_data(db) -> None:
    """Create MOCK_CLUB_COUNT clubs and MOCK_ATHLETES_PER_CLUB athletes each."""
    club_batch = db.batch()
    for club_number in range(1, MOCK_CLUB_COUNT + 1):
        club_id = f"mock_club_{club_number}"
        ref = db.collection(CLUBS_COLLECTION_NAME).document(club_id)
        club_batch.set(ref, build_mock_club_doc(club_number))
    club_batch.commit()
    print(f"Created {MOCK_CLUB_COUNT} mock club(s) in /{CLUBS_COLLECTION_NAME}.")

    # NOTE: build_mock_athlete_doc's birthday uses `athlete_number` (1..
    # MOCK_ATHLETES_PER_CLUB) as the DAY component of a fixed year/month
    # — with MOCK_ATHLETES_PER_CLUB now at 15, that stays a valid day
    # number (max 15) same as before at 5; if this constant is ever
    # raised past 28, build_mock_athlete_doc's birthday would need its
    # own day-clamping since datetime() rejects day > 28-31 depending on
    # month.
    athlete_batch = db.batch()
    global_number = 0
    written_in_batch = 0
    for club_number in range(1, MOCK_CLUB_COUNT + 1):
        for athlete_number in range(1, MOCK_ATHLETES_PER_CLUB + 1):
            global_number += 1
            athlete_id = f"mock_athlete_{global_number}"
            ref = db.collection(COLLECTION_NAME).document(athlete_id)
            athlete_batch.set(ref, build_mock_athlete_doc(club_number, athlete_number, global_number))
            written_in_batch += 1
            # Stay well clear of Firestore's 500-write batch limit even
            # as MOCK_CLUB_COUNT / MOCK_ATHLETES_PER_CLUB grow — commits
            # and starts a fresh batch every BATCH_SIZE writes, same
            # chunking pattern the main .xlsx upload path already uses.
            if written_in_batch >= BATCH_SIZE:
                athlete_batch.commit()
                athlete_batch = db.batch()
                written_in_batch = 0
    if written_in_batch > 0:
        athlete_batch.commit()
    print(f"Created {global_number} mock athlete(s) in /{COLLECTION_NAME}.")
    print("\nAll mock docs are tagged isMock == True for easy querying/cleanup.")


def clean_mock_data(db) -> None:
    """Delete every doc tagged isMock == True from clubs/ and athletes/."""
    for collection_name in (COLLECTION_NAME, CLUBS_COLLECTION_NAME):
        docs = list(db.collection(collection_name).where("isMock", "==", True).stream())
        if not docs:
            print(f"No mock docs found in /{collection_name}.")
            continue
        batch = db.batch()
        for doc in docs:
            batch.delete(doc.reference)
        batch.commit()
        print(f"Deleted {len(docs)} mock doc(s) from /{collection_name}.")


# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------

def normalize_name(value: str) -> str:
    """Lowercase and strip diacritics, e.g. 'Vidinská' -> 'vidinska'."""
    decomposed = unicodedata.normalize("NFD", value)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.lower().strip()


def parse_birthday(date_str: str) -> datetime.datetime:
    """'dd.mm.yyyy' -> UTC midnight datetime."""
    try:
        day, month, year = (int(p) for p in str(date_str).split("."))
        return datetime.datetime(year, month, day, tzinfo=datetime.timezone.utc)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f'Invalid birthday format: "{date_str}"') from exc


def parse_gender(value: str) -> str:
    """'F' | 'M' -> 'female' | 'male'."""
    upper = str(value).strip().upper()
    if upper == "F":
        return "female"
    if upper == "M":
        return "male"
    raise ValueError(f'Unknown gender code: "{value}"')


def compute_rank(rank_number, rank_type: str) -> int:
    """
    Convert rank number + type into the numeric `rank` field.
        10.GUP -> 0, 9.GUP -> 1, ... 1.GUP -> 9
        1.DAN  -> 10, 2.DAN -> 11, ...
    POOM is treated as an alias for DAN.
    """
    try:
        n = int(rank_number)
    except (ValueError, TypeError) as exc:
        raise ValueError(f'Invalid rank number: "{rank_number}"') from exc

    raw_type = str(rank_type).strip().upper()
    rtype = RANK_TYPE_ALIASES.get(raw_type)
    if rtype == "GUP":
        return 10 - n
    if rtype == "DAN":
        return 9 + n
    raise ValueError(f'Unknown rank type: "{rank_type}"')


def resolve_club_id(club_name: str) -> str:
    """Look up clubId for a given club name; raises if unmapped."""
    trimmed = str(club_name).strip()
    club_id = CLUB_NAME_TO_ID.get(trimmed)
    if not club_id:
        raise ValueError(
            f'No clubId mapping found for club name: "{trimmed}". '
            f"Add it to CLUB_NAME_TO_ID in upload_athletes.py."
        )
    if club_id not in VALID_CLUB_IDS:
        raise ValueError(f'Mapped clubId "{club_id}" is not in VALID_CLUB_IDS.')
    return club_id


def parse_xlsx_file(file_path: Path) -> list[dict]:
    """Read the export and return one dict per row (all string fields raw)."""
    df = pd.read_excel(file_path, dtype=str)

    required = {
        "regnr", "name", "surname", "gender", "birthdate",
        "Stupeň", "GUP/DAN", "latest_sport_orgs NAME",
    }
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing expected column(s) in export: {sorted(missing)}")

    rows = []
    for _, r in df.iterrows():
        rows.append(
            {
                "associationId": (r["regnr"] or "").strip() if pd.notna(r["regnr"]) else "",
                "firstNameRaw": (r["name"] or "").strip() if pd.notna(r["name"]) else "",
                "lastNameRaw": (r["surname"] or "").strip() if pd.notna(r["surname"]) else "",
                "genderRaw": r["gender"] if pd.notna(r["gender"]) else "",
                "birthdayRaw": r["birthdate"] if pd.notna(r["birthdate"]) else "",
                "rankNumber": r["Stupeň"] if pd.notna(r["Stupeň"]) else "",
                "rankType": r["GUP/DAN"] if pd.notna(r["GUP/DAN"]) else "",
                "clubNameRaw": r["latest_sport_orgs NAME"] if pd.notna(r["latest_sport_orgs NAME"]) else "",
            }
        )
    return rows


def build_athlete_doc(row: dict) -> dict:
    """Build the Firestore-ready athlete document from one parsed row."""
    first_name = normalize_name(row["firstNameRaw"])
    last_name = normalize_name(row["lastNameRaw"])
    display_name = f'{row["firstNameRaw"].strip()} {row["lastNameRaw"].strip()}'

    return {
        "birthday": parse_birthday(row["birthdayRaw"]),
        "country": COUNTRY,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "displayName": display_name,
        "firstName": first_name,
        "lastName": last_name,
        "gender": parse_gender(row["genderRaw"]),
        "sports": {
            "taekwondo": {
                "associationId": row["associationId"].strip(),
                "clubId": resolve_club_id(row["clubNameRaw"]),
                "clubName": str(row["clubNameRaw"]).strip(),
                "rank": compute_rank(row["rankNumber"], row["rankType"]),
            }
        },
    }


# -----------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------

def init_firestore():
    if not firebase_admin._apps:
        service_account_path = Path(__file__).parent / "google_creds.json"
        if service_account_path.exists():
            cred = credentials.Certificate(str(service_account_path))
            firebase_admin.initialize_app(cred)
        else:
            # Falls back to GOOGLE_APPLICATION_CREDENTIALS env var if set
            firebase_admin.initialize_app()
    return firestore.client()


def main():
    args = sys.argv[1:]

    if "--mock" in args:
        db = init_firestore()
        upload_mock_data(db)
        return

    if "--mock-clean" in args:
        db = init_firestore()
        clean_mock_data(db)
        return

    xlsx_path = Path(args[0]) if args else Path(__file__).parent / "athletes.xlsx"

    if not xlsx_path.exists():
        print(f"Export file not found: {xlsx_path}", file=sys.stderr)
        sys.exit(1)

    db = init_firestore()

    rows = parse_xlsx_file(xlsx_path)
    print(f"Parsed {len(rows)} rows from {xlsx_path}")

    docs = []
    skipped = []

    for i, row in enumerate(rows, start=2):  # +2: header row + 1-indexing
        try:
            docs.append(build_athlete_doc(row))
        except ValueError as exc:
            label = row["associationId"] or f'"{row["firstNameRaw"]} {row["lastNameRaw"]}"'
            skipped.append(f"  Row {i} ({label}): {exc}")

    if skipped:
        print(f"\nSkipping {len(skipped)} row(s) with invalid/missing data:", file=sys.stderr)
        for s in skipped:
            print(s, file=sys.stderr)

    if not docs:
        print("\nNo valid rows to upload.", file=sys.stderr)
        sys.exit(1)

    print(f"\n{len(docs)} rows validated successfully. Uploading...")

    written = 0
    for start in range(0, len(docs), BATCH_SIZE):
        chunk = docs[start : start + BATCH_SIZE]
        batch = db.batch()
        for doc in chunk:
            ref = db.collection(COLLECTION_NAME).document()  # auto-generated ID
            batch.set(ref, doc)
        batch.commit()
        written += len(chunk)
        print(f"  Committed {written}/{len(docs)}")

    print(f"\nDone. Uploaded {written} athletes to /{COLLECTION_NAME}.")
    if skipped:
        print(f"({len(skipped)} row(s) were skipped -- see warnings above.)")


if __name__ == "__main__":
    main()