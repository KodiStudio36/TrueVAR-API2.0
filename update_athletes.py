"""
Update clubName for all athletes whose clubId == "star_klub".

Firestore layout (per your example):
  /athletes/{docId}
      sports (map)
          taekwondo (map)
              clubId:   "ilyoke"
              clubName: "Športový klub polície - ILYO Taekwondo Košice"
              ...
      (other sport keys could theoretically also have their own clubId)

This script:
  1. Authenticates using google_creds.json (service account) in the same folder.
  2. Scans the /athletes collection.
  3. For each document, looks through every key under "sports" (not just
     "taekwondo") for a clubId == TARGET_CLUB_ID, and updates that sport's
     clubName to NEW_CLUB_NAME.
  4. Uses batched writes for efficiency and prints a summary at the end.

Run with:
    pip install firebase-admin --break-system-packages
    python update_club_name.py

To do a dry run first (no writes), set DRY_RUN = True below.
"""

import firebase_admin
from firebase_admin import credentials, firestore

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CREDS_PATH = "google_creds.json"
COLLECTION = "athletes"
TARGET_CLUB_ID = "star_klub"
NEW_CLUB_NAME = "STAR-CLUB BOJOVÝCH UMENÍ"
DRY_RUN = False  # set True to preview matches without writing anything

# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------
cred = credentials.Certificate(CREDS_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()


def find_matching_sport_keys(doc_dict):
    """Return list of sport keys (e.g. ['taekwondo']) whose clubId matches."""
    matches = []
    sports = doc_dict.get("sports")
    if not isinstance(sports, dict):
        return matches
    for sport_key, sport_data in sports.items():
        if isinstance(sport_data, dict) and sport_data.get("clubId") == TARGET_CLUB_ID:
            matches.append(sport_key)
    return matches


def main():
    docs = db.collection(COLLECTION).stream()

    batch = db.batch()
    batch_count = 0
    updated_count = 0
    updated_names = []

    BATCH_LIMIT = 400  # Firestore max is 500 writes per batch; keep some headroom

    for doc in docs:
        data = doc.to_dict()
        matching_sports = find_matching_sport_keys(data)

        if not matching_sports:
            continue

        display_name = data.get("displayName", doc.id)

        if DRY_RUN:
            print(f"[DRY RUN] Would update {display_name} ({doc.id}) "
                  f"for sport(s): {', '.join(matching_sports)}")
            updated_count += 1
            continue

        update_payload = {}
        for sport_key in matching_sports:
            update_payload[f"sports.{sport_key}.clubName"] = NEW_CLUB_NAME

        batch.update(doc.reference, update_payload)
        batch_count += 1
        updated_count += 1
        updated_names.append(display_name)

        if batch_count >= BATCH_LIMIT:
            batch.commit()
            print(f"Committed batch of {batch_count} updates...")
            batch = db.batch()
            batch_count = 0

    if not DRY_RUN and batch_count > 0:
        batch.commit()
        print(f"Committed final batch of {batch_count} updates.")

    print("\n--- Summary ---")
    print(f"Target clubId : {TARGET_CLUB_ID}")
    print(f"New clubName  : {NEW_CLUB_NAME}")
    print(f"Documents matched/updated: {updated_count}")
    if updated_names:
        print("Updated athletes:")
        for name in updated_names:
            print(f"  - {name}")


if __name__ == "__main__":
    main()