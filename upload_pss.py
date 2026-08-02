"""
Uploads a generated PSS hit-level JSON to Firestore at
sports/{sport}/disciplines/{discipline}/pssHitLevelSets/{setId}.

Multiple sets can coexist side by side under the same discipline — one
per provider (DAEDO, KP&P, ...) or per revision year — since these
values genuinely change over time and bracket_builder.html lets the
admin choose which one to apply per tournament rather than assuming
there's only ever one.

Run generate_pss_hitlevels.py first (or any other script producing the
same JSON shape: sport, discipline, setId, provider, year, label, note,
pssHitLevels) to produce the file this reads.

Usage:
    python upload_pss_hitlevels.py <path/to/generated.json> [path/to/service-account-key.json]

If no service-account key path is given, falls back to Application
Default Credentials (same as the rest of this codebase's init_firestore()).
"""

import json
import sys

import firebase_admin
from firebase_admin import credentials, firestore


def init_firestore():
    if not firebase_admin._apps:
        if len(sys.argv) > 2:
            cred = credentials.Certificate(sys.argv[2])
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()  # Application Default Credentials
    return firestore.client()


def main():
    if len(sys.argv) < 2:
        print("Usage: python upload_pss_hitlevels.py <path/to/generated.json> [service-account-key.json]")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        data = json.load(f)

    for required in ("sport", "discipline", "setId", "pssHitLevels"):
        if required not in data:
            print(f"Input JSON is missing required field '{required}' — was this produced by generate_pss_hitlevels.py?")
            sys.exit(1)

    db = init_firestore()

    ref = (
        db.collection("sports").document(data["sport"])
        .collection("disciplines").document(data["discipline"])
        .collection("pssHitLevelSets").document(data["setId"])
    )

    ref.set({
        "provider": data.get("provider"),
        "year": data.get("year"),
        "label": data.get("label", data["setId"]),
        "note": data.get("note"),
        "pssHitLevels": data["pssHitLevels"],
    })

    row_count = sum(len(v) for v in data["pssHitLevels"].values())
    print(f"Uploaded {row_count} weight-class rows across {len(data['pssHitLevels'])} division/gender keys")
    print(f"-> sports/{data['sport']}/disciplines/{data['discipline']}/pssHitLevelSets/{data['setId']}")


if __name__ == "__main__":
    main()