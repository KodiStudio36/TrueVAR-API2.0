#!/usr/bin/env python3
"""
fix_category_codes.py — repairs category codes that were written in the
wrong format (e.g. "kyorugi_cadets_women_59plus" instead of
"kyorugi_cadets_women_plus_59") everywhere TrueVAR stores them.

The correct codes are rebuilt from the tournament's own schema
(tournament_categories/{id}.categories), with exactly the rule in
category-schema.js:

    {entryType}_{age}[_{belt}][_{para}]_{gender}[_{weight} | _plus_{topWeight}]

Every stored code is checked against that list. A wrong one is mapped to
the right one when there is exactly ONE match; anything it can't place is
listed and left alone (add it with --map OLD=NEW).

Recognised wrong spellings, for example for the open top of cadets women:
    kyorugi_cadets_women_59plus   cadets_women_plus_59   kyorugi_cadets_women_+59
    kyorugi_cadets_women_59+      kyorugi_cadets_women_over_59   …_plus59  …_59_plus
and for a normal class: …_-59  …_59kg  …_u59  …_under_59  …_minus_59  …_59.0
plus labels instead of codes (male/female, "Younger Cadets"), and a missing
entry-type prefix.

WHAT IT FIXES, per tournament
    tournaments/{id}/registrations/{code}_{entryId}   doc id + categoryCode
    tournaments/{id}/division_rosters/{age}           athletes.{code} map keys
    tournaments/{id}/meta/categoryCounts              keys (recounted from the
                                                      active registrations)
    tournaments/{id}/brackets/*                       categoryCode
    tournaments/{id}/results/{code}                   doc id + categoryCode
    sports/{s}/disciplines/{d}/matches                categoryCode
                                                      (where tournamentId == id)
    sports/{s}/disciplines/{d}/performances           categoryCode (poomsae)
    athletes/{id}  sports.{s}.disciplines.{d}.categories.{code} + lastCompeteCategory
                   (only the athletes registered in the tournament)

SAFE BY DEFAULT
    Without --apply nothing is written: it prints every change it would make.
    With --apply it first saves every document it will touch to a JSON backup
    (backup_<tournament>_<time>.json), then writes.
    Conflicts (e.g. the same entry already registered under the correct code
    AND still active under the wrong one) are reported and skipped.

USAGE
    pip install firebase-admin
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

    python fix_category_codes.py --tournament <ID>            # dry run
    python fix_category_codes.py --tournament <ID> --apply
    python fix_category_codes.py --all                        # every tournament
    python fix_category_codes.py --all --apply
    python fix_category_codes.py --tournament <ID> --map kyorugi_cadets_woman_59=kyorugi_cadets_women_59
    python fix_category_codes.py --restore backup_<ID>_<time>.json     # undo
    python fix_category_codes.py --check-schema schema.json --codes a b c     # offline test
"""
import argparse
import datetime as dt
import itertools
import json
import re
import sys
from collections import defaultdict

SPORT_KEY = "taekwondo"

# ═══════════════════════════════════════════════════════════════════════
# Valid codes from the schema — Python port of category-schema.js flatten()
# ═══════════════════════════════════════════════════════════════════════
PARA_CATEGORIES = ["P11", "P12", "P21", "P22", "P23", "P31", "P32", "P33", "P34", "P35",
                   "P41", "P42", "P43", "P44", "P45", "P51", "P52", "P53", "P60", "P72"]
DEFAULT_PARA = [{"code": c.lower(), "label": c, "match_value": c} for c in PARA_CATEGORIES]
IMPLICIT = {"code": "", "label": ""}


def weight_str(w) -> str:
    if isinstance(w, float) and w.is_integer():
        w = int(w)
    return str(w)


def para_classes(entry_opt: dict) -> list:
    if entry_opt.get("requires_para") is False:
        return []
    explicit = entry_opt.get("para_class_options")
    explicit = explicit if isinstance(explicit, list) else None
    requires = (entry_opt.get("requires_para") is True
                or str(entry_opt.get("code") or "").lower().startswith("para_")
                or bool(explicit))
    if not requires:
        return []
    return explicit if explicit is not None else DEFAULT_PARA


def flatten(dimensions: list) -> list:
    """-> [{code, parts: {entry, age, belt, para, gender}, weight, plus}]"""
    dims = {d.get("key"): d for d in dimensions or []}
    entry_dim, age_dim, gender_dim, weight_dim = (dims.get(k) for k in ("entry_type", "age", "gender", "weight"))
    entry_opts = (entry_dim or {}).get("options") or [{"code": "individual", "label": "Individual"}]

    out = []
    for e in entry_opts:
        ages = e.get("age_options") or (age_dim or {}).get("options") or []
        genders = e.get("gender_options") or (gender_dim or {}).get("options") or []
        belts = e.get("belt_class_options") or [IMPLICIT]
        paras = para_classes(e) or [IMPLICIT]
        for a in ages:
            for b in belts:
                if isinstance(b.get("age_codes"), list) and a.get("code") not in b["age_codes"]:
                    continue
                for p in paras:
                    for g in genders:
                        base = "_".join(x for x in (a.get("code"), b.get("code"), p.get("code"), g.get("code")) if x)
                        parts = {"entry": e, "age": a, "belt": b, "para": p, "gender": g}
                        if weight_dim:
                            ths = (weight_dim.get("thresholds_by") or {}).get(f"{a.get('code')}|{g.get('code')}") or []
                            if not ths:
                                continue
                            for w in ths:
                                out.append({"code": f"{e['code']}_{base}_{weight_str(w)}", "parts": parts,
                                            "weight": weight_str(w), "plus": False})
                            if weight_dim.get("open_top"):
                                top = weight_str(ths[-1])
                                out.append({"code": f"{e['code']}_{base}_plus_{top}", "parts": parts,
                                            "weight": top, "plus": True})
                        else:
                            out.append({"code": f"{e['code']}_{base}", "parts": parts, "weight": None, "plus": False})
    return out


# ═══════════════════════════════════════════════════════════════════════
# Wrong spelling -> right code
# ═══════════════════════════════════════════════════════════════════════
def slug(text) -> str:
    s = re.sub(r"[^a-z0-9+\-]+", "_", str(text or "").lower())
    return re.sub(r"_+", "_", s).strip("_")


def normalize_input(code: str) -> str:
    s = str(code or "").strip().lower()
    s = re.sub(r"[\s·]+", "_", s)                          # spaces / separators
    s = re.sub(r"(\d+)\.0+(?!\d)", r"\1", s)               # 59.0 -> 59
    s = re.sub(r"(\d)\s*kg", r"\1", s)                     # 59kg -> 59
    s = re.sub(r"_+", "_", s).strip("_")
    return s


def weight_aliases(w: str, plus: bool) -> set:
    if plus:
        return {f"plus_{w}", f"{w}plus", f"{w}_plus", f"plus{w}", f"+{w}", f"{w}+", f"_+{w}",
                f"over_{w}", f"over{w}", f"o{w}", f"above_{w}", f"plus_+{w}"}
    return {w, f"-{w}", f"u{w}", f"u_{w}", f"under_{w}", f"minus_{w}", f"minus{w}", f"m{w}", f"_-{w}"}


def option_aliases(opt: dict, allow_empty: bool = False) -> set:
    out = {slug(opt.get("code")), slug(opt.get("label")), slug(opt.get("match_value"))}
    out.discard("")
    if allow_empty or not opt.get("code"):
        out.add("")
    return out


class CodeFixer:
    def __init__(self, dimensions: list, manual: dict | None = None):
        self.leaves = flatten(dimensions)
        self.valid = {l["code"] for l in self.leaves}
        alias_to = defaultdict(set)
        for leaf in self.leaves:
            p = leaf["parts"]
            ws = weight_aliases(leaf["weight"], leaf["plus"]) if leaf["weight"] is not None else {""}
            for combo in itertools.product(
                option_aliases(p["entry"], allow_empty=True),
                option_aliases(p["age"]),
                option_aliases(p["belt"]),
                option_aliases(p["para"]),
                option_aliases(p["gender"]),
                ws,
            ):
                alias = "_".join(x for x in combo if x)
                alias = re.sub(r"_+", "_", alias).strip("_")
                alias_to[alias].add(leaf["code"])
        # Only unambiguous spellings; a valid code always maps to itself.
        self.alias = {a: next(iter(c)) for a, c in alias_to.items() if len(c) == 1}
        for v in self.valid:
            self.alias[v] = v
        self.manual = manual or {}
        self.unknown: set = set()

    def fix(self, code):
        """-> correct code, or None when it can't be placed (left alone)."""
        if not code:
            return None
        if code in self.manual:
            return self.manual[code]
        if code in self.valid:
            return code
        hit = self.alias.get(normalize_input(code))
        if hit is None:
            self.unknown.add(code)
        return hit

    def changed(self, code):
        """-> new code when `code` is wrong and fixable, else None."""
        new = self.fix(code)
        return new if new and new != code else None


# ═══════════════════════════════════════════════════════════════════════
# Firestore
# ═══════════════════════════════════════════════════════════════════════
def fp(*parts) -> str:
    """Field path that is safe for map keys with + - etc."""
    from google.cloud.firestore_v1.field_path import FieldPath
    return FieldPath(*parts).to_api_repr()


def jsonable(v):
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [jsonable(x) for x in v]
    if hasattr(v, "isoformat"):
        return {"__ts__": v.isoformat()}
    if hasattr(v, "path") and hasattr(v, "id"):   # DocumentReference
        return f"ref:{v.path}"
    return v


class Plan:
    """Collected writes + what they replace, applied in batches."""

    def __init__(self, db):
        self.db = db
        self.ops = []        # (kind, ref, data)
        self.backup = {}     # path -> original data
        self.log = []
        self.conflicts = []

    def keep(self, snap):
        if snap.reference.path not in self.backup:
            self.backup[snap.reference.path] = jsonable(snap.to_dict()) if snap.exists else None

    def add(self, kind, ref, data=None):
        self.ops.append((kind, ref, data))

    def apply(self):
        from firebase_admin import firestore  # noqa: F401
        for i in range(0, len(self.ops), 400):
            batch = self.db.batch()
            for kind, ref, data in self.ops[i:i + 400]:
                if kind == "set":
                    batch.set(ref, data)
                elif kind == "update":
                    batch.update(ref, data)
                elif kind == "delete":
                    batch.delete(ref)
            batch.commit()


def fix_tournament(db, tid: str, manual: dict, apply: bool) -> dict:
    from firebase_admin import firestore
    from google.cloud.firestore_v1.base_query import FieldFilter

    t_ref = db.collection("tournaments").document(tid)
    t_snap = t_ref.get()
    if not t_snap.exists:
        print(f"[{tid}] tournament not found — skipped")
        return {}
    t = t_snap.to_dict() or {}
    sport = str(t.get("sport") or SPORT_KEY).lower()
    discipline = str(t.get("discipline") or "").lower()
    title = t.get("title") or tid

    cat_snap = db.collection("tournament_categories").document(tid).get()
    cats = (cat_snap.to_dict() or {}).get("categories") or {} if cat_snap.exists else {}
    schemas = (cats.get("sportSchemas") or {})
    sport_schema = schemas.get(sport) or (next(iter(schemas.values())) if schemas else {})
    disciplines = sport_schema.get("disciplines") or {}
    disc_schema = disciplines.get(discipline) or (next(iter(disciplines.values())) if disciplines else None)
    if not disc_schema:
        print(f"[{tid}] {title}: no category schema — skipped")
        return {}
    discipline = discipline or disc_schema.get("key") or ""
    fixer = CodeFixer(disc_schema.get("dimensions") or [], manual)
    plan = Plan(db)
    print(f"\n══ {title}  ({tid})  {sport}/{discipline}  — {len(fixer.valid)} valid codes")

    # ── registrations ───────────────────────────────────────────────────
    regs = {s.id: s for s in t_ref.collection("registrations").stream()}
    active_by_code = defaultdict(int)
    athlete_ids = set()
    final_regs = {}  # doc id -> data, after the fix (for recounting)
    for rid, snap in regs.items():
        r = snap.to_dict() or {}
        athlete_ids.update(r.get("athleteIds") or [])
        code = r.get("categoryCode")
        entry_id = "-".join(sorted(r.get("athleteIds") or []))
        if not entry_id and code and rid.startswith(code + "_"):
            entry_id = rid[len(code) + 1:]
        # The code may be wrong in the field, the doc id, or both.
        id_code = rid[: -len(entry_id) - 1] if entry_id and rid.endswith("_" + entry_id) else None
        canon = fixer.fix(code) or fixer.fix(id_code)
        if not canon or not entry_id:
            final_regs[rid] = r
            continue
        new_id = f"{canon}_{entry_id}"
        if new_id == rid and code == canon:
            final_regs[rid] = r
            continue
        new_data = {**r, "categoryCode": canon}
        if new_id == rid:
            plan.keep(snap)
            plan.add("update", snap.reference, {"categoryCode": canon})
            plan.log.append(f"registration {rid}: categoryCode {code} -> {canon}")
            final_regs[rid] = new_data
            continue
        target = regs.get(new_id)
        active = r.get("status", "active") == "active"
        if target is not None:
            t_active = (target.to_dict() or {}).get("status", "active") == "active"
            if active and t_active:
                plan.conflicts.append(f"registration {rid}: same entry already active as {new_id} — left as is")
                final_regs[rid] = r
                continue
            if not active:
                plan.keep(snap)
                plan.add("delete", snap.reference)
                plan.log.append(f"registration {rid}: withdrawn duplicate of {new_id} — deleted")
                continue
            plan.keep(target)  # active wrong one replaces an inactive right one
        plan.keep(snap)
        new_ref = t_ref.collection("registrations").document(new_id)
        if target is None:
            plan.backup.setdefault(new_ref.path, None)
        plan.add("set", new_ref, new_data)
        plan.add("delete", snap.reference)
        plan.log.append(f"registration {rid} -> {new_id}")
        final_regs[new_id] = new_data
    for r in final_regs.values():
        if r.get("status", "active") == "active" and r.get("categoryCode"):
            active_by_code[r["categoryCode"]] += 1

    # ── division rosters ────────────────────────────────────────────────
    for snap in t_ref.collection("division_rosters").stream():
        athletes = (snap.to_dict() or {}).get("athletes") or {}
        updates = {}
        for code, entries in athletes.items():
            canon = fixer.changed(code)
            if not canon:
                continue
            existing = athletes.get(canon) or {}
            for entry_id, entry in (entries or {}).items():
                if entry_id in existing:
                    plan.conflicts.append(f"roster {snap.id}: {entry_id} in both {code} and {canon} — kept {canon}")
                    continue
                updates[fp("athletes", canon, entry_id)] = entry
            updates[fp("athletes", code)] = firestore.DELETE_FIELD
            plan.log.append(f"roster {snap.id}: {code} -> {canon} ({len(entries or {})} entries)")
        if updates:
            plan.keep(snap)
            plan.add("update", snap.reference, updates)

    # ── category counts (recounted from active registrations) ───────────
    counts_ref = t_ref.collection("meta").document("categoryCounts")
    counts_snap = counts_ref.get()
    counts = counts_snap.to_dict() or {} if counts_snap.exists else {}
    updates = {}
    touched = set()
    for code in counts:
        canon = fixer.changed(code)
        if canon:
            updates[fp(code)] = firestore.DELETE_FIELD
            touched.add(canon)
            plan.log.append(f"categoryCounts: {code} ({counts[code]}) -> {canon}")
    for canon in touched:
        updates[fp(canon)] = active_by_code.get(canon, 0)
    if updates:
        plan.keep(counts_snap)
        plan.add("update", counts_ref, updates)

    # ── brackets ────────────────────────────────────────────────────────
    for snap in t_ref.collection("brackets").stream():
        code = (snap.to_dict() or {}).get("categoryCode")
        canon = fixer.changed(code)
        if canon:
            plan.keep(snap)
            plan.add("update", snap.reference, {"categoryCode": canon})
            plan.log.append(f"bracket {snap.id}: {code} -> {canon}")

    # ── results/{code} ──────────────────────────────────────────────────
    results = {s.id: s for s in t_ref.collection("results").stream()}
    for rid, snap in results.items():
        data = snap.to_dict() or {}
        canon = fixer.changed(rid) or fixer.changed(data.get("categoryCode"))
        if not canon:
            continue
        if canon != rid and canon in results:
            plan.conflicts.append(f"results {rid}: {canon} already exists — old one deleted, "
                                  f"re-run 'compute results' to rebuild")
            plan.keep(snap)
            plan.add("delete", snap.reference)
            continue
        plan.keep(snap)
        new_ref = t_ref.collection("results").document(canon)
        plan.backup.setdefault(new_ref.path, None)
        plan.add("set", new_ref, {**data, "categoryCode": canon})
        if canon != rid:
            plan.add("delete", snap.reference)
        plan.log.append(f"results {rid} -> {canon}")

    # ── matches + performances ─────────────────────────────────────────
    disc_ref = db.collection("sports").document(sport).collection("disciplines").document(discipline)
    for coll in ("matches", "performances"):
        q = disc_ref.collection(coll).where(filter=FieldFilter("tournamentId", "==", tid))
        n = 0
        for snap in q.stream():
            code = (snap.to_dict() or {}).get("categoryCode")
            canon = fixer.changed(code)
            if canon:
                plan.keep(snap)
                plan.add("update", snap.reference, {"categoryCode": canon})
                n += 1
                plan.log.append(f"{'match' if coll == 'matches' else 'performance'} {snap.id}: {code} -> {canon}")

    # ── athlete stats (ELO per category) ───────────────────────────────
    ids = sorted(athlete_ids)
    for i in range(0, len(ids), 100):
        refs = [db.collection("athletes").document(a) for a in ids[i:i + 100]]
        for snap in db.get_all(refs):
            if not snap.exists:
                continue
            d = ((((snap.to_dict() or {}).get("sports") or {}).get(sport) or {})
                 .get("disciplines") or {}).get(discipline) or {}
            base = ("sports", sport, "disciplines", discipline)
            cats_map = d.get("categories") or {}
            updates = {}
            for code, stats in cats_map.items():
                canon = fixer.changed(code)
                if not canon:
                    continue
                if canon in cats_map:
                    plan.conflicts.append(f"athlete {snap.id}: stats under both {code} and {canon} — not merged")
                    continue
                updates[fp(*base, "categories", canon)] = stats
                updates[fp(*base, "categories", code)] = firestore.DELETE_FIELD
                plan.log.append(f"athlete {snap.id}: stats {code} -> {canon}")
            last = d.get("lastCompeteCategory")
            canon = fixer.changed(last)
            if canon:
                updates[fp(*base, "lastCompeteCategory")] = canon
                plan.log.append(f"athlete {snap.id}: lastCompeteCategory {last} -> {canon}")
            if updates:
                plan.keep(snap)
                plan.add("update", snap.reference, updates)

    # ── report ─────────────────────────────────────────────────────────
    for line in plan.log:
        print("  ✎", line)
    for line in plan.conflicts:
        print("  ⚠", line)
    if fixer.unknown:
        print("  ? codes not in this tournament's schema (left alone — use --map OLD=NEW):")
        for c in sorted(fixer.unknown):
            print("      ", c)
    print(f"  → {len(plan.log)} change(s), {len(plan.conflicts)} conflict(s), {len(fixer.unknown)} unknown code(s)")

    if apply and plan.ops:
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        path = f"backup_{tid}_{stamp}.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(plan.backup, f, ensure_ascii=False, indent=1)
        print(f"  backup written: {path}  ({len(plan.backup)} docs)")
        plan.apply()
        print(f"  ✓ applied {len(plan.ops)} write(s)")
    elif plan.ops:
        print("  (dry run — nothing written; add --apply)")
    return {"changes": len(plan.log), "conflicts": len(plan.conflicts), "unknown": sorted(fixer.unknown)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tournament", action="append", default=[], help="tournament id (repeatable)")
    ap.add_argument("--all", action="store_true", help="every tournament")
    ap.add_argument("--apply", action="store_true", help="actually write (default: dry run)")
    ap.add_argument("--map", action="append", default=[], metavar="OLD=NEW", help="manual fix for one code")
    ap.add_argument("--cred", help="service account JSON (default: GOOGLE_APPLICATION_CREDENTIALS)")
    ap.add_argument("--restore", metavar="BACKUP", help="put back every doc from a backup_*.json file")
    ap.add_argument("--check-schema", metavar="FILE", help="offline: schema JSON to test codes against")
    ap.add_argument("--codes", nargs="*", default=[], help="offline: codes to test with --check-schema")
    args = ap.parse_args()

    manual = {}
    for m in args.map:
        old, _, new = m.partition("=")
        if not new:
            sys.exit(f"--map needs OLD=NEW, got {m!r}")
        manual[old.strip()] = new.strip()

    if args.check_schema:
        with open(args.check_schema, encoding="utf-8") as f:
            data = json.load(f)
        data = data.get("categories", data)
        sport = next(iter(data["sportSchemas"].values()))
        for disc in sport["disciplines"].values():
            fixer = CodeFixer(disc["dimensions"], manual)
            print(f"{disc.get('key')}: {len(fixer.valid)} valid codes")
            for c in args.codes:
                print(f"  {c:45} -> {fixer.fix(c)}")
        return

    if args.restore:
        import firebase_admin
        from firebase_admin import credentials, firestore
        firebase_admin.initialize_app(credentials.Certificate(args.cred) if args.cred else None)
        db = firestore.client()
        with open(args.restore, encoding="utf-8") as f:
            backup = json.load(f)
        def revive(v):
            if isinstance(v, dict):
                if set(v) == {"__ts__"}:
                    return dt.datetime.fromisoformat(v["__ts__"])
                return {k: revive(x) for k, x in v.items()}
            if isinstance(v, list):
                return [revive(x) for x in v]
            return v
        items = [(p, revive(d)) for p, d in backup.items()]
        for i in range(0, len(items), 400):
            batch = db.batch()
            for path, data in items[i:i + 400]:
                ref = db.document(path)
                if data is None:
                    batch.delete(ref)   # didn't exist before the fix
                else:
                    batch.set(ref, data)
            batch.commit()
        print(f"Restored {len(items)} doc(s) from {args.restore}.")
        return

    if not args.tournament and not args.all:
        sys.exit("Give --tournament ID (repeatable) or --all.")

    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(args.cred) if args.cred else None)
    db = firestore.client()

    ids = args.tournament or [s.id for s in db.collection("tournaments").stream()]
    total = {"changes": 0, "conflicts": 0}
    for tid in ids:
        r = fix_tournament(db, tid, manual, args.apply)
        total["changes"] += r.get("changes", 0)
        total["conflicts"] += r.get("conflicts", 0)
    print(f"\nDone — {total['changes']} change(s), {total['conflicts']} conflict(s) across {len(ids)} tournament(s)."
          + ("" if args.apply else " Dry run: run again with --apply to write."))


if __name__ == "__main__":
    main()