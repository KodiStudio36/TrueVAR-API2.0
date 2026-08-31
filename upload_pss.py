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
requiresPlexiHelmet, pssHitLevels) to produce the file this reads.

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

    # requiresPlexiHelmet was previously missing from this whitelist —
    # every field written to Firestore has to be listed explicitly here,
    # so a field present in the source JSON but absent from this dict
    # gets silently dropped on upload, not just left at some old value.
    # That's what caused bracket_builder.html's plexi-court routing to
    # treat every category as "doesn't need a helmet": the map was
    # sitting right there in the JSON file, but never actually reached
    # Firestore. Defaults to {} (same as the reader's own fallback) so
    # older JSON files without this field still upload cleanly instead
    # of erroring out.
    ref.set({
        "provider": data.get("provider"),
        "year": data.get("year"),
        "label": data.get("label", data["setId"]),
        "note": data.get("note"),
        "requiresPlexiHelmet": data.get("requiresPlexiHelmet", {}),
        "pssHitLevels": data["pssHitLevels"],
    })

    row_count = sum(len(v) for v in data["pssHitLevels"].values())
    plexi_count = sum(1 for v in data.get("requiresPlexiHelmet", {}).values() if v)
    print(f"Uploaded {row_count} weight-class rows across {len(data['pssHitLevels'])} division/gender keys")
    if "requiresPlexiHelmet" in data:
        print(f"Plexi-helmet requirement set for {plexi_count} age division(s): "
              f"{[k for k, v in data['requiresPlexiHelmet'].items() if v]}")
    else:
        print("WARNING: input JSON has no 'requiresPlexiHelmet' field — every category in this set "
              "will be treated as NOT requiring a plexi helmet until it's added.")
    print(f"-> sports/{data['sport']}/disciplines/{data['discipline']}/pssHitLevelSets/{data['setId']}")


if __name__ == "__main__":
    main()