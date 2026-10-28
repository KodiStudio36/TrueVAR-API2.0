#!/usr/bin/env python3
"""
Migrate ONE tournament's poomsae category schema (tournament_categories/{id})
and move its existing registrations into the new categories.

    # 1. Dry run (default) — reads only, prints the plan, writes a local backup
    python scripts/migrate_poomsae_categories.py TOURNAMENT_ID poomsae_categories.json

    # 2. Apply it
    python scripts/migrate_poomsae_categories.py TOURNAMENT_ID poomsae_categories.json --apply

    # 3. Undo (puts back schema, registrations, rosters, counts, draw)
    python scripts/migrate_poomsae_categories.py TOURNAMENT_ID --restore backups/<file>.json

What it does
------------
* Backs up everything it touches BEFORE writing anything — to a local JSON
  file AND to Firestore (tournament_categories_backups/{id}__{stamp}):
  the category doc, every registration, every division roster,
  meta/categoryCounts and meta/poomsaeDraw.
* A registration is moved ONLY when its category no longer exists in the
  new schema (minimal change). The new age division comes from the first
  athlete's birth year (same rule as tournament.html); belt class, entry
  type and gender are kept. Example: Individual Class A "Seniors over 30"
  → under 40 / under 50 / over 50; Class B "Seniors under 40" → over 30.
  Para pairs/teams split by para class → one mixed category per age.
* Each move is its own Firestore transaction, written exactly like the
  app's own move endpoint (old registration → status "moved" + movedTo,
  new registration with movedFrom, roster entry moved with its original
  members/registeredAt, categoryCounts -1/+1). Original registeredAt is
  kept. Every written doc is tagged with migrationId.
* Then writes the new schema, re-checks every active registration against
  it, and corrects categoryCounts drift with Increment deltas.
* Copies poomsae-draw pool assignments from the old age division to the new
  one (e.g. seniors_over_30|class_a → seniors_under_40|class_a) when the new
  key has none. An already generated draw is NOT redrawn — you'll be told.

Safety stops (override with --force):
* brackets already committed for the tournament (they reference the old
  category codes);
* registrations it cannot place (no birth year, no fitting division) —
  listed in the plan; with --force those stay where they are.

Run it while registration is closed (or nobody is registering): club
registrations made under the old schema in the middle of the run would land
in old category codes. The final check reports any that do.

Credentials: run from the backend root so infrastructure.firebase_client is
importable, or pass --credentials service-account.json (or set
GOOGLE_APPLICATION_CREDENTIALS).
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import sys
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_VERSION = "1"


# ───────────────────────────── schema parsing ─────────────────────────────
# Python port of parseCategories / resolveEligibleCategories in
# tournament.html (poomsae: no weight dimension), including the per-class
# `age_codes` and para rules.

PARA_CATEGORIES = [
    "P11", "P12", "P21", "P22", "P23", "P31", "P32", "P33", "P34", "P35",
    "P41", "P42", "P43", "P44", "P45", "P51", "P52", "P53", "P60", "P72",
]
DEFAULT_PARA_CLASS_OPTIONS = [{"code": c.lower(), "label": c, "match_value": c} for c in PARA_CATEGORIES]


def discipline_dimensions(categories: dict, sport: Optional[str], discipline: Optional[str]) -> List[dict]:
    schemas = (categories or {}).get("sportSchemas") or {}
    if not schemas:
        return []
    sport_key = sport if sport in schemas else next(iter(schemas))
    discs = (schemas[sport_key] or {}).get("disciplines") or {}
    if not discs:
        return []
    disc_key = discipline if discipline in discs else next(iter(discs))
    return (discs[disc_key] or {}).get("dimensions") or []


def _same_para_mode(raw) -> Optional[str]:
    if raw is True or raw == "class":
        return "class"
    if raw == "group":
        return "group"
    return None


def parse_entry_types(dimensions: List[dict]) -> Dict[str, dict]:
    by_key = {d.get("key"): d for d in dimensions}
    if "weight" in by_key:
        raise SystemExit("This script handles poomsae schemas only (found a weight dimension).")
    entry_dim, age_dim, gender_dim = by_key.get("entry_type"), by_key.get("age"), by_key.get("gender")
    entry_opts = (entry_dim or {}).get("options") or [{"code": "individual", "label": "Individual", "participantCount": 1}]

    out: Dict[str, dict] = {}
    for e in entry_opts:
        age_opts = e.get("age_options") or (age_dim or {}).get("options") or []
        gender_opts = e.get("gender_options") or (gender_dim or {}).get("options") or []
        belts = e.get("belt_class_options") or [{"code": "", "label": "", "min": None, "max": None}]

        explicit = e.get("para_class_options") if isinstance(e.get("para_class_options"), list) else None
        code = e.get("code") or ""
        requires_para = e.get("requires_para") is not False and bool(
            e.get("requires_para") is True or code.lower().startswith("para_") or (explicit and len(explicit) > 0)
        )
        para_src = [] if not requires_para else (explicit if explicit is not None else DEFAULT_PARA_CLASS_OPTIONS)
        paras = para_src or [{"code": "", "label": "", "match_value": None}]

        classes = []
        for b in belts:
            for p in paras:
                classes.append({
                    "code": "_".join(x for x in [b.get("code"), p.get("code")] if x),
                    "label": " ".join(x for x in [b.get("label"), p.get("label")] if x),
                    "beltCode": b.get("code") or None,
                    "paraCode": p.get("code") or None,
                    "paraMatch": str(p["match_value"]).upper() if p.get("match_value") else None,
                    "ageCodes": b.get("age_codes") if isinstance(b.get("age_codes"), list) else None,
                })

        divisions = []
        for a in age_opts:
            cls_here = [c for c in classes if not c["ageCodes"] or a["code"] in c["ageCodes"]]
            if not cls_here or not gender_opts:
                continue
            divisions.append({
                "code": a["code"], "label": a.get("label", a["code"]),
                "min": a.get("min"), "max": a.get("max"),
                "classes": cls_here, "genders": gender_opts,
            })
        out[code] = {
            "code": code, "label": e.get("label", code),
            "requiresPara": requires_para,
            "sameParaClass": _same_para_mode(e.get("same_para_class")) if requires_para else None,
            "divisions": divisions,
        }
    return out


def category_code(entry: dict, div: dict, cls: dict, gender: dict) -> str:
    return f"{entry['code']}_" + "_".join(x for x in [div["code"], cls["code"], gender["code"]] if x)


def category_label(entry: dict, div: dict, cls: dict, gender: dict) -> str:
    return " · ".join(x for x in [entry["label"], div["label"], cls["label"], gender.get("label", "")] if x)


def all_categories(entry_types: Dict[str, dict]) -> Dict[str, dict]:
    """categoryCode → {entry, div, cls, gender, label}."""
    cats = {}
    for e in entry_types.values():
        for d in e["divisions"]:
            for c in d["classes"]:
                for g in d["genders"]:
                    cats[category_code(e, d, c, g)] = {
                        "entry": e, "div": d, "cls": c, "gender": g,
                        "label": category_label(e, d, c, g),
                    }
    return cats


# ───────────────────────────── planning (pure) ─────────────────────────────

def _birth_year(athlete: dict) -> Optional[int]:
    b = (athlete or {}).get("birthday")
    if hasattr(b, "year"):
        return b.year
    if isinstance(b, str) and len(b) >= 4 and b[:4].isdigit():
        return int(b[:4])
    if isinstance(b, dict) and "__ts__" in b:
        return int(b["__ts__"][:4])
    return None


def _sport_data(athlete: dict, sport: Optional[str]) -> dict:
    return ((athlete or {}).get("sports") or {}).get(sport) or {}


def _para_key(athlete: dict, sport: Optional[str], mode: str) -> Optional[str]:
    c = str(_sport_data(athlete, sport).get("paraCategory") or "").strip().upper()
    if not c:
        return None
    return c[:2] if mode == "group" else c


def _fits(div: dict, year: int) -> bool:
    lo, hi = div.get("min"), div.get("max")
    return (lo is None or year >= lo) and (hi is None or year <= hi)


def _span(div: dict) -> int:
    lo, hi = div.get("min"), div.get("max")
    if lo is None or hi is None:
        return 10 ** 6
    return hi - lo


def plan_migration(
    registrations: Dict[str, dict],
    athletes: Dict[str, dict],
    new_entry_types: Dict[str, dict],
    sport: Optional[str],
) -> dict:
    """
    registrations: {docId: data} (all statuses); athletes: {athleteId: data}.
    Returns {"moves": [...], "unchanged": n, "relabel": [...],
             "unresolved": [...], "warnings": [...]}
    """
    new_cats = all_categories(new_entry_types)
    moves, relabel, unresolved, warnings = [], [], [], []
    unchanged = 0
    taken = {doc_id for doc_id, r in registrations.items() if r.get("status", "active") == "active"}

    for doc_id, r in sorted(registrations.items()):
        if r.get("status", "active") != "active":
            continue
        old_code = r.get("categoryCode") or ""
        ids = list(r.get("athleteIds") or [])
        entry_id = "-".join(sorted(ids))
        members = [athletes.get(a) for a in ids]
        entry = new_entry_types.get(r.get("entryTypeCode") or "")

        # Same-para-class check (report only — staff decide what to do).
        if entry and entry["sameParaClass"] and len(ids) > 1:
            keys = [_para_key(m, sport, entry["sameParaClass"]) for m in members]
            if not all(keys) or len(set(keys)) > 1:
                got = [str(_sport_data(m, sport).get("paraCategory") or "—") for m in members]
                warnings.append(f"{doc_id}: members have different/missing para classes ({', '.join(got)}) — "
                                f"allowed to stay, but new club registrations like this are now rejected.")

        if old_code in new_cats:
            if new_cats[old_code]["label"] != r.get("categoryLabel"):
                relabel.append({"docId": doc_id, "label": new_cats[old_code]["label"]})
            unchanged += 1
            continue

        def fail(reason):
            unresolved.append({"docId": doc_id, "categoryCode": old_code, "reason": reason})

        if not entry:
            fail(f"entry type '{r.get('entryTypeCode')}' is not in the new schema")
            continue
        if any(m is None for m in members):
            fail("an athlete document is missing")
            continue

        belt = r.get("beltClassCode") or None
        # Para class: keep the old one when the new schema still splits by
        # class, otherwise derive from the athletes; drop it when unsplit.
        split_para = any(c["paraCode"] for d in entry["divisions"] for c in d["classes"])
        para = None
        if split_para:
            para = r.get("paraClassCode")
            if not para:
                pcs = {str(_sport_data(m, sport).get("paraCategory") or "").lower() for m in members}
                para = pcs.pop() if len(pcs) == 1 else None
            if not para:
                fail("cannot tell the para class")
                continue

        def class_in(div):
            for c in div["classes"]:
                if (c["beltCode"] or None) == belt and (c["paraCode"] or None) == (para or None):
                    return c
            return None

        def gender_in(div):
            gs = div["genders"]
            same = [g for g in gs if g["code"] == r.get("genderCode")]
            if same:
                return same[0]
            return gs[0] if len(gs) == 1 else None

        year = _birth_year(members[0])
        candidates = [d for d in entry["divisions"] if class_in(d) and gender_in(d)]
        if year is not None:
            fitting = [d for d in candidates if _fits(d, year)]
        else:
            fitting = [d for d in candidates if d["code"] == r.get("ageCode")]
        if not fitting:
            fail("no age division in the new schema fits "
                 + (f"birth year {year}" if year is not None else "(no birth year on file)"))
            continue
        same_age = [d for d in fitting if d["code"] == r.get("ageCode")]
        if same_age:
            div = same_age[0]
        else:
            fitting.sort(key=_span)
            if len(fitting) > 1 and _span(fitting[0]) == _span(fitting[1]):
                fail("more than one age division fits equally: " + ", ".join(d["code"] for d in fitting))
                continue
            div = fitting[0]

        cls, gender = class_in(div), gender_in(div)
        new_code = category_code(entry, div, cls, gender)
        new_doc_id = f"{new_code}_{entry_id}"
        if new_doc_id in taken:
            fail(f"target {new_doc_id} is already registered")
            continue
        taken.add(new_doc_id)
        moves.append({
            "oldDocId": doc_id, "newDocId": new_doc_id, "entryId": entry_id,
            "entryTypeCode": entry["code"],
            "oldCategoryCode": old_code, "newCategoryCode": new_code,
            "oldAgeCode": r.get("ageCode"), "newAgeCode": div["code"],
            "beltClassCode": cls["beltCode"], "paraClassCode": cls["paraCode"],
            "genderCode": gender["code"], "categoryLabel": new_cats[new_code]["label"],
            "birthYear": year,
            "names": ", ".join(
                (m.get("displayName") or f"{m.get('firstName', '')} {m.get('lastName', '')}".strip()) for m in members),
        })

    return {"moves": moves, "unchanged": unchanged, "relabel": relabel,
            "unresolved": unresolved, "warnings": warnings}


def draw_copies(draw: dict, moves: List[dict]) -> Dict[str, Dict[str, Any]]:
    """New poomsae-draw keys to add (never overwrites an existing key)."""
    out: Dict[str, Dict[str, Any]] = defaultdict(dict)
    for m in moves:
        belt = m["beltClassCode"] or ""
        old_k, new_k = f"{m['oldAgeCode']}|{belt}", f"{m['newAgeCode']}|{belt}"
        for field in ("assignments", "excludedGroups"):
            src = (draw or {}).get(field) or {}
            if old_k in src and new_k not in src and new_k not in out[field]:
                out[field][new_k] = src[old_k]
        src = (draw or {}).get("excludedRows") or {}
        entry = m["entryTypeCode"]
        old_r, new_r = f"{entry}|{old_k}", f"{entry}|{new_k}"
        if old_r in src and new_r not in src and new_r not in out["excludedRows"]:
            out["excludedRows"][new_r] = src[old_r]
    return {k: v for k, v in out.items() if v}


# ───────────────────────────── serialisation ─────────────────────────────

def to_jsonable(v):
    if isinstance(v, dict):
        return {k: to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_jsonable(x) for x in v]
    if isinstance(v, dt.datetime):
        return {"__ts__": v.isoformat()}
    if v is not None and not isinstance(v, (str, int, float, bool)):
        return {"__repr__": repr(v)}  # GeoPoint / reference etc. — not used here
    return v


def from_jsonable(v):
    if isinstance(v, dict):
        if set(v) == {"__ts__"}:
            return dt.datetime.fromisoformat(v["__ts__"])
        return {k: from_jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [from_jsonable(x) for x in v]
    return v


# ───────────────────────────── Firestore I/O ─────────────────────────────

def connect(credentials_path: Optional[str]):
    if not credentials_path:
        try:
            sys.path.insert(0, os.getcwd())
            from infrastructure.firebase_client import init_firestore  # type: ignore
            return init_firestore()
        except Exception:
            pass
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        cred = credentials.Certificate(credentials_path) if credentials_path else credentials.ApplicationDefault()
        firebase_admin.initialize_app(cred)
    return firestore.client()


def fs():
    from firebase_admin import firestore
    return firestore


def load_state(db, tid: str) -> dict:
    t_ref = db.collection("tournaments").document(tid)
    t = t_ref.get()
    if not t.exists:
        raise SystemExit(f"Tournament {tid} not found.")
    cat = db.collection("tournament_categories").document(tid).get()
    meta = t_ref.collection("meta")
    counts = meta.document("categoryCounts").get()
    draw = meta.document("poomsaeDraw").get()
    return {
        "tournament": t.to_dict() or {},
        "categoryDoc": cat.to_dict() if cat.exists else None,
        "registrations": {d.id: d.to_dict() for d in t_ref.collection("registrations").stream()},
        "rosters": {d.id: d.to_dict() for d in t_ref.collection("division_rosters").stream()},
        "categoryCounts": counts.to_dict() if counts.exists else None,
        "poomsaeDraw": draw.to_dict() if draw.exists else None,
        "bracketCount": sum(1 for _ in t_ref.collection("brackets").limit(1).stream()),
    }


def load_athletes(db, registrations: Dict[str, dict]) -> Dict[str, dict]:
    ids = sorted({a for r in registrations.values() if r.get("status", "active") == "active"
                  for a in (r.get("athleteIds") or [])})
    refs = [db.collection("athletes").document(a) for a in ids]
    out = {}
    for i in range(0, len(refs), 100):
        for snap in db.get_all(refs[i:i + 100]):
            if snap.exists:
                out[snap.id] = snap.to_dict()
    return out


def write_backup(db, tid: str, state: dict, migration_id: str, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    payload = {
        "scriptVersion": SCRIPT_VERSION, "tournamentId": tid, "migrationId": migration_id,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        **{k: state[k] for k in ("categoryDoc", "registrations", "rosters", "categoryCounts", "poomsaeDraw")},
    }
    path = os.path.join(backup_dir, f"{tid}__{migration_id}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_jsonable(payload), f, ensure_ascii=False, indent=1)
    return path


def backup_categories_in_firestore(db, tid: str, state: dict, migration_id: str) -> str:
    doc_id = f"{tid}__{migration_id}"
    db.collection("tournament_categories_backups").document(doc_id).set({
        "tournamentId": tid, "migrationId": migration_id,
        "categories": (state["categoryDoc"] or {}).get("categories"),
        "categoryDoc": state["categoryDoc"],
        "backedUpAt": fs().SERVER_TIMESTAMP,
    })
    return doc_id


def apply_move(db, tid: str, m: dict, migration_id: str) -> None:
    firestore = fs()
    t_ref = db.collection("tournaments").document(tid)
    regs = t_ref.collection("registrations")
    old_ref, new_ref = regs.document(m["oldDocId"]), regs.document(m["newDocId"])
    old_roster = t_ref.collection("division_rosters").document(m["oldAgeCode"])
    new_roster = t_ref.collection("division_rosters").document(m["newAgeCode"])
    counts_ref = t_ref.collection("meta").document("categoryCounts")
    tx = db.transaction()

    @firestore.transactional
    def _run(tx):
        old = old_ref.get(transaction=tx)
        if not old.exists:
            raise RuntimeError("old registration vanished")
        od = old.to_dict()
        if od.get("status", "active") != "active" or od.get("categoryCode") != m["oldCategoryCode"]:
            raise RuntimeError("old registration changed since the plan — re-run the dry run")
        new = new_ref.get(transaction=tx)
        if new.exists and new.to_dict().get("status", "active") == "active":
            raise RuntimeError("target already registered")
        roster_snap = old_roster.get(transaction=tx)
        roster_entry = (((roster_snap.to_dict() or {}).get("athletes") or {})
                        .get(m["oldCategoryCode"]) or {}).get(m["entryId"]) if roster_snap.exists else None
        new_roster_snap = new_roster.get(transaction=tx) if new_roster.id != old_roster.id else roster_snap

        nd = dict(od)
        nd.update({
            "ageCode": m["newAgeCode"], "beltClassCode": m["beltClassCode"],
            "paraClassCode": m["paraClassCode"], "genderCode": m["genderCode"],
            "categoryCode": m["newCategoryCode"], "categoryLabel": m["categoryLabel"],
            "status": "active", "movedFrom": old_ref.id, "migrationId": migration_id,
            "migratedAt": firestore.SERVER_TIMESTAMP,
        })
        nd.pop("movedTo", None)
        tx.set(new_ref, nd)
        tx.set(old_ref, {"status": "moved", "movedTo": new_ref.id, "migrationId": migration_id}, merge=True)

        old_path = f"athletes.{m['oldCategoryCode']}.{m['entryId']}"
        new_path = f"athletes.{m['newCategoryCode']}.{m['entryId']}"
        entry = roster_entry if roster_entry is not None else {"members": []}
        if new_roster.id == old_roster.id:
            if roster_snap.exists:
                upd = {new_path: entry}
                if roster_entry is not None:
                    upd[old_path] = firestore.DELETE_FIELD
                tx.update(old_roster, upd)
            else:
                tx.set(new_roster, {"athletes": {m["newCategoryCode"]: {m["entryId"]: entry}}}, merge=True)
        else:
            if roster_entry is not None:
                tx.update(old_roster, {old_path: firestore.DELETE_FIELD})
            tx.set(new_roster, {"athletes": {m["newCategoryCode"]: {m["entryId"]: entry}}}, merge=True)

        tx.set(counts_ref, {
            m["oldCategoryCode"]: firestore.Increment(-1),
            m["newCategoryCode"]: firestore.Increment(1),
        }, merge=True)

    _run(tx)


def fix_counts(db, tid: str) -> Dict[str, int]:
    """Make categoryCounts equal the number of active registrations (deltas only)."""
    firestore = fs()
    t_ref = db.collection("tournaments").document(tid)
    counts_ref = t_ref.collection("meta").document("categoryCounts")
    actual = Counter(d.to_dict().get("categoryCode") for d in t_ref.collection("registrations").stream()
                     if d.to_dict().get("status", "active") == "active")
    stored = (counts_ref.get().to_dict() or {})
    deltas = {}
    for code in set(actual) | set(stored):
        if not code:
            continue
        have = stored.get(code, 0) if isinstance(stored.get(code, 0), (int, float)) else 0
        if actual.get(code, 0) != have:
            deltas[code] = actual.get(code, 0) - have
    if deltas:
        counts_ref.set({k: firestore.Increment(v) for k, v in deltas.items()}, merge=True)
    return deltas


def restore(db, tid: str, path: str) -> None:
    with open(path, encoding="utf-8") as f:
        b = from_jsonable(json.load(f))
    if b.get("tournamentId") != tid:
        raise SystemExit("Backup belongs to another tournament.")
    t_ref = db.collection("tournaments").document(tid)
    mig = b.get("migrationId")
    writes: List[Tuple[str, Any, Optional[dict]]] = []

    if b.get("categoryDoc") is not None:
        writes.append(("set", db.collection("tournament_categories").document(tid), b["categoryDoc"]))
    regs = t_ref.collection("registrations")
    current = {d.id: d.to_dict() for d in regs.stream()}
    for doc_id, data in b["registrations"].items():
        writes.append(("set", regs.document(doc_id), data))
    rosters = t_ref.collection("division_rosters")
    stray_roster_paths: Dict[str, List[str]] = defaultdict(list)
    for doc_id, data in current.items():
        if doc_id not in b["registrations"] and data.get("migrationId") == mig:
            writes.append(("delete", regs.document(doc_id), None))
            entry_id = "-".join(sorted(data.get("athleteIds") or []))
            if data.get("ageCode") not in b["rosters"]:
                # roster doc created by the migration → take the entry out again
                stray_roster_paths[data["ageCode"]].append(f"athletes.{data['categoryCode']}.{entry_id}")
    for doc_id, data in b["rosters"].items():
        writes.append(("set", rosters.document(doc_id), data))
    meta = t_ref.collection("meta")
    if b.get("categoryCounts") is not None:
        writes.append(("set", meta.document("categoryCounts"), b["categoryCounts"]))
    if b.get("poomsaeDraw") is not None:
        writes.append(("set", meta.document("poomsaeDraw"), b["poomsaeDraw"]))

    for i in range(0, len(writes), 400):
        batch = db.batch()
        for op, ref, data in writes[i:i + 400]:
            batch.set(ref, data) if op == "set" else batch.delete(ref)
        batch.commit()
    firestore = fs()
    for age_code, paths in stray_roster_paths.items():
        ref = rosters.document(age_code)
        if ref.get().exists:
            ref.update({p: firestore.DELETE_FIELD for p in paths})
    print(f"Restored {len(writes)} documents from {path}.")
    print("Note: rosters/registrations created AFTER the migration in new age divisions are not touched,")
    print("      and registrations made after the migration in restored roster docs were overwritten.")


# ───────────────────────────── reporting ─────────────────────────────

def print_plan(plan: dict, old_cats: Dict[str, dict], new_cats: Dict[str, dict], verbose: bool = False) -> None:
    removed = sorted(set(old_cats) - set(new_cats))
    added = sorted(set(new_cats) - set(old_cats))
    print(f"\nSchema: {len(old_cats)} → {len(new_cats)} categories "
          f"({len(added)} new, {len(removed)} no longer offered; --verbose lists them)")
    if verbose:
        for c in added:
            print(f"  + {c}")
        for c in removed:
            print(f"  - {c}")

    print(f"\nRegistrations: {plan['unchanged']} stay, {len(plan['moves'])} move, "
          f"{len(plan['unresolved'])} cannot be placed")
    by_pair = defaultdict(list)
    for m in plan["moves"]:
        by_pair[(m["oldCategoryCode"], m["newCategoryCode"])].append(m)
    for (o, n), ms in sorted(by_pair.items()):
        print(f"\n  {o}\n    → {n}  ({len(ms)})")
        for m in ms:
            print(f"      · {m['names']}  (born {m['birthYear'] or '?'})")
    if plan["relabel"]:
        print(f"\n  {len(plan['relabel'])} registration label(s) refreshed in place")
    if plan["unresolved"]:
        print("\n  CANNOT PLACE (left where they are with --force):")
        for u in plan["unresolved"]:
            print(f"    ! {u['docId']}: {u['reason']}")
    if plan["warnings"]:
        print("\n  Warnings:")
        for w in plan["warnings"]:
            print(f"    ~ {w}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tournament_id")
    ap.add_argument("schema_file", nargs="?", help="new categories JSON ({\"categories\": {...}} or the categories object)")
    ap.add_argument("--apply", action="store_true", help="write changes (default is a dry run)")
    ap.add_argument("--force", action="store_true", help="continue despite committed brackets / unplaceable entries")
    ap.add_argument("--restore", metavar="BACKUP_JSON", help="undo a migration from its backup file")
    ap.add_argument("--credentials", help="service-account JSON (otherwise app config / ADC)")
    ap.add_argument("--backup-dir", default="backups")
    ap.add_argument("--verbose", action="store_true", help="list every added/removed category code")
    args = ap.parse_args(argv)

    db = connect(args.credentials)
    tid = args.tournament_id

    if args.restore:
        if not args.apply:
            print("Restore is destructive — add --apply to confirm.")
            return 1
        restore(db, tid, args.restore)
        return 0

    if not args.schema_file:
        ap.error("schema_file is required (unless --restore)")
    with open(args.schema_file, encoding="utf-8") as f:
        raw = json.load(f)
    new_categories = raw.get("categories", raw)
    if "sportSchemas" not in new_categories:
        raise SystemExit("Schema file has no sportSchemas.")

    state = load_state(db, tid)
    sport = state["tournament"].get("sport")
    discipline = state["tournament"].get("discipline")
    old_categories = (state["categoryDoc"] or {}).get("categories") or {}

    new_types = parse_entry_types(discipline_dimensions(new_categories, sport, discipline))
    old_cats = all_categories(parse_entry_types(discipline_dimensions(old_categories, sport, discipline))) \
        if old_categories else {}
    new_cats = all_categories(new_types)

    athletes = load_athletes(db, state["registrations"])
    plan = plan_migration(state["registrations"], athletes, new_types, sport)

    migration_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"Tournament {tid} — {state['tournament'].get('title', '')} ({sport}/{discipline})")
    print_plan(plan, old_cats, new_cats, args.verbose)
    draw_add = draw_copies(state["poomsaeDraw"] or {}, plan["moves"])
    if draw_add:
        print("\nPoomsae draw settings copied to new divisions:")
        for field, items in draw_add.items():
            for k, v in items.items():
                print(f"  {field}[{k}] = {v}")
    if ((state["poomsaeDraw"] or {}).get("draw") or {}).get("rows") and plan["moves"]:
        print("\n  NOTE: a poomsae draw was already generated — re-run the draw for the new divisions.")

    blockers = []
    if state["bracketCount"]:
        blockers.append("brackets are already committed for this tournament")
    if plan["unresolved"]:
        blockers.append(f"{len(plan['unresolved'])} registration(s) cannot be placed")

    backup_path = write_backup(db, tid, state, migration_id, args.backup_dir)
    print(f"\nLocal backup: {backup_path}")

    if not args.apply:
        print("\nDRY RUN — nothing written to Firestore. Re-run with --apply.")
        if blockers:
            print("Would stop because: " + "; ".join(blockers) + " (use --force to override).")
        return 0
    if blockers and not args.force:
        print("\nSTOPPED: " + "; ".join(blockers) + ". Fix them or re-run with --force.")
        return 2

    fs_backup = backup_categories_in_firestore(db, tid, state, migration_id)
    print(f"Firestore backup: tournament_categories_backups/{fs_backup}")

    done, failed = 0, []
    for m in plan["moves"]:
        try:
            apply_move(db, tid, m, migration_id)
            done += 1
        except Exception as exc:  # keep going; every move is atomic on its own
            failed.append((m["oldDocId"], str(exc)))
    regs = db.collection("tournaments").document(tid).collection("registrations")
    for r in plan["relabel"]:
        regs.document(r["docId"]).set({"categoryLabel": r["label"]}, merge=True)

    if draw_add:
        db.collection("tournaments").document(tid).collection("meta").document("poomsaeDraw") \
            .set(draw_add, merge=True)

    # Whole-document set (no merge): a merge would deep-merge the new
    # schema into the old one and leave removed keys behind.
    cat_doc = dict(state["categoryDoc"] or {})
    cat_doc.update({
        "tournamentId": tid,
        "categories": new_categories,
        "updatedAt": fs().SERVER_TIMESTAMP,
        "lastMigrationId": migration_id,
        "previousCategoriesBackup": fs_backup,
    })
    db.collection("tournament_categories").document(tid).set(cat_doc)

    deltas = fix_counts(db, tid)
    after = load_state(db, tid)
    stragglers = [d for d, r in after["registrations"].items()
                  if r.get("status", "active") == "active" and r.get("categoryCode") not in new_cats]

    print(f"\nMoved {done}/{len(plan['moves'])} registrations; schema replaced.")
    if deltas:
        print(f"categoryCounts corrected: {deltas}")
    for doc_id, err in failed:
        print(f"  FAILED {doc_id}: {err}")
    if stragglers:
        print(f"  {len(stragglers)} active registration(s) still in categories the new schema lacks:")
        for s in stragglers:
            print(f"    ! {s}")
        print("  Move them from the category manager (admin-move), or run this script again.")
    print(f"\nUndo: python {sys.argv[0]} {tid} --restore {backup_path} --apply")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())