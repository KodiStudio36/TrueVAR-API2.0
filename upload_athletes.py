"""
upload_athletes.py

Reads a CSV of athletes and pushes them into Firestore's /athletes
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
            "clubName": "<original club name from CSV>",
            "rank": <int>
        }
    }
}

CSV columns (no header row):
    associationId, firstName, lastName, gender(F/M), birthday(dd.mm.yyyy),
    rankNumber, rankType(GUP/DAN), clubName

Usage:
    pip install -r requirements.txt
    python upload_athletes.py athletes.csv

Requires a Firebase service account key at ./serviceAccountKey.json
(or set GOOGLE_APPLICATION_CREDENTIALS env var to its path).
"""

import csv
import sys
import os
import unicodedata
import datetime
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore

# -----------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------

# Map club names (as they appear in the CSV) to their Firestore clubId.
# Add more entries here as new clubs show up in future CSVs.
CLUB_NAME_TO_ID = {
    "TAEKWONDO HAKIMI Rožňava": "hakimi",
    "Športový klub polície - ILYO Taekwondo Košice": "ilyoke",
    "KORYO TAEKWONDO SLÁVIA UPJŠ KOŠICE": "koryo",
    "Black Tiger Taekwondo - Klub Snina": "black_tiger",
    "Falcon Taekwondo klub Rimavská Sobota": "falcon",
    "Haneul Taekwondo Trenčín": "haneul",
    # Known club id with no CSV example yet:
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
}

COUNTRY = "SVK"
COLLECTION_NAME = "athletes"
BATCH_SIZE = 400  # Firestore batch limit is 500 writes


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
        day, month, year = (int(p) for p in date_str.split("."))
        return datetime.datetime(year, month, day, tzinfo=datetime.timezone.utc)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f'Invalid birthday format: "{date_str}"') from exc


def parse_gender(value: str) -> str:
    """'F' | 'M' -> 'female' | 'male'."""
    upper = value.strip().upper()
    if upper == "F":
        return "female"
    if upper == "M":
        return "male"
    raise ValueError(f'Unknown gender code: "{value}"')


def compute_rank(rank_number: str, rank_type: str) -> int:
    """
    Convert rank number + type into the numeric `rank` field.
        10.GUP -> 0, 9.GUP -> 1, ... 1.GUP -> 9
        1.DAN  -> 10, 2.DAN -> 11, ...
    """
    try:
        n = int(rank_number)
    except ValueError as exc:
        raise ValueError(f'Invalid rank number: "{rank_number}"') from exc

    rtype = rank_type.strip().upper()
    if rtype == "GUP":
        return 10 - n
    if rtype == "DAN":
        return 9 + n
    raise ValueError(f'Unknown rank type: "{rank_type}"')


def resolve_club_id(club_name: str) -> str:
    """Look up clubId for a given club name; raises if unmapped."""
    trimmed = club_name.strip()
    club_id = CLUB_NAME_TO_ID.get(trimmed)
    if not club_id:
        raise ValueError(
            f'No clubId mapping found for club name: "{trimmed}". '
            f"Add it to CLUB_NAME_TO_ID in upload_athletes.py."
        )
    if club_id not in VALID_CLUB_IDS:
        raise ValueError(f'Mapped clubId "{club_id}" is not in VALID_CLUB_IDS.')
    return club_id


def parse_csv_file(file_path: Path) -> list[dict]:
    rows = []
    with open(file_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        for line in reader:
            if not line or not any(field.strip() for field in line):
                continue
            (
                association_id,
                first_name_raw,
                last_name_raw,
                gender_raw,
                birthday_raw,
                rank_number,
                rank_type,
                club_name_raw,
            ) = (field.strip() for field in line)
            rows.append(
                {
                    "associationId": association_id,
                    "firstNameRaw": first_name_raw,
                    "lastNameRaw": last_name_raw,
                    "genderRaw": gender_raw,
                    "birthdayRaw": birthday_raw,
                    "rankNumber": rank_number,
                    "rankType": rank_type,
                    "clubNameRaw": club_name_raw,
                }
            )
    return rows


def build_athlete_doc(row: dict) -> dict:
    """Build the Firestore-ready athlete document from one parsed CSV row."""
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
                "clubName": row["clubNameRaw"].strip(),
                "rank": compute_rank(row["rankNumber"], row["rankType"]),
            }
        },
    }


# -----------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------

def main():
    csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "athletes.csv"

    if not csv_path.exists():
        print(f"CSV file not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    if not firebase_admin._apps:
        service_account_path = Path(__file__).parent / "google_creds.json"
        if service_account_path.exists():
            cred = credentials.Certificate(str(service_account_path))
            firebase_admin.initialize_app(cred)
        else:
            # Falls back to GOOGLE_APPLICATION_CREDENTIALS env var if set
            firebase_admin.initialize_app()

    db = firestore.client()

    rows = parse_csv_file(csv_path)
    print(f"Parsed {len(rows)} rows from {csv_path}")

    docs = []
    errors = []

    for i, row in enumerate(rows, start=1):
        try:
            docs.append(build_athlete_doc(row))
        except ValueError as exc:
            errors.append(f'Row {i} ({row["associationId"]}): {exc}')

    if errors:
        print("\nErrors found, aborting before writing anything:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(f"All {len(docs)} rows validated successfully. Uploading...")

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


if __name__ == "__main__":
    main()