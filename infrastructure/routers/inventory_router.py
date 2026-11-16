"""Inventory — every piece of hardware we own, in one Firestore collection.

    inventory/{itemId}
        type         "truevar_case" | "sim_router" | "access_point" | "printer" | "other"
        name         display name ("Darth Plagueis", "Teltonika RUT240 #2")
        description  free text shown on the item's page (optional)
        photoUrl     photo of the item (optional): an http(s) link, or a path on
                     this site such as /static/assets/images/truevar_case.jpg
        openBugs     number of "pending" bug reports — recounted from the
                     subcollection on every bug change, shown on the cards
        scheduledTournaments   [{tournamentId, title, dateTime}] — tournaments
                     this item is scheduled for (copy; see SCHEDULING below)
        scheduledTournamentIds [tournamentId, …] — the same ids as a plain
                     list, so "which items list tournament X" is one
                     array-contains query (used when a tournament is deleted)
        createdAt / createdBy / updatedAt
      TrueVAR cases only — written by the case itself (TrueVAR core,
      FirebaseAdapter.update_case_binding), never by this router:
        tournamentId, courtId   which tournament/court the case is booted into
        tournamentChosenAt      when that tournament was chosen on the case

    inventory/{itemId}/bugs/{bugId}
        title, details
        status       "pending" | "resolved"
        createdAt, createdBy, createdByName
        resolvedAt, resolvedBy, resolvedByName    (while resolved)

SCHEDULING an item for a tournament is stored on BOTH sides, as copies:
    tournaments/{tid}/meta/inventory = {items: [{id, name, type, photoUrl}]}
        → the tournament page shows its equipment without reading inventory
          (one doc in the tournament's shared `meta` subcollection)
    inventory/{id}.scheduledTournaments = [{tournamentId, title, dateTime}]
        → the item (and a TrueVAR case at power-on) knows its schedule
Every write here updates both; renaming/re-photographing or deleting an item
updates the tournaments' copies too. The copies are for display/lookup —
TrueVAR core re-reads the real tournament docs to decide what's "today".

For a TrueVAR case the document ID IS its license key: the case's OS reads
inventory/{licenseKey} at preflight to know it's licensed and which
tournament it's bound to. That's why the ID is never editable here and a
case's type can't be changed afterwards (it would stop being a licence).

This replaces the old `cases` collection — see
scripts/migrate_cases_to_inventory.py. TOS only ("inventory:manage").
"""
from datetime import datetime, timezone
from typing import Dict, List, Literal, Optional
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from firebase_admin import firestore

from infrastructure.auth_common import db
from infrastructure.routers.operator_auth import require_operator

INVENTORY_COLLECTION = "inventory"
BUGS_SUBCOLLECTION = "bugs"
LEGACY_CASES_COLLECTION = "cases"   # pre-inventory; read-only fallback in TrueVAR core
CASE_TYPE = "truevar_case"

# Display order on the inventory page. Add a type here to offer it in the UI.
INVENTORY_TYPES: Dict[str, str] = {
    CASE_TYPE: "TrueVAR Case",
    "sim_router": "SIM Router",
    "access_point": "Access Point",
    "printer": "Printer",
    "other": "Other",
}

MAX_NAME, MAX_DESCRIPTION = 120, 2000
MAX_BUG_TITLE, MAX_BUG_DETAILS = 150, 4000

DISPLAY_TZ = ZoneInfo("Europe/Bratislava")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

inventory_router = APIRouter(prefix="/api/inventory", tags=["Inventory"])
MANAGE = [Depends(require_operator("inventory:manage"))]


# ── Validation ────────────────────────────────────────────────────────────

def _clean_text(value: Optional[str], field: str, max_len: int, required: bool = False) -> Optional[str]:
    value = (value or "").strip()
    if not value:
        if required:
            raise HTTPException(status_code=400, detail=f"{field} is required.")
        return None
    if len(value) > max_len:
        raise HTTPException(status_code=400, detail=f"{field} is too long (max {max_len} characters).")
    return value


def _clean_name(name: str) -> str:
    return _clean_text(name, "Name", MAX_NAME, required=True)


def _clean_photo_url(url: Optional[str]) -> Optional[str]:
    """An http(s) link, or a path on this site ("/static/…"). A path without
    the leading slash gets one, so it doesn't resolve against /dashboard/.
    Nothing else (javascript:, data:, //other-host) — the page puts this
    straight into <img src>."""
    url = (url or "").strip()
    if not url:
        return None
    if any(c.isspace() for c in url) or "\\" in url:
        raise HTTPException(status_code=400, detail="Photo link can't contain spaces or backslashes.")

    parsed = urlparse(url)
    if parsed.scheme:
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise HTTPException(status_code=400,
                                detail="Photo link must be an http(s) link or a path like /static/…")
        return url
    if url.startswith("//"):
        raise HTTPException(status_code=400,
                            detail="Photo link must be an http(s) link or a path like /static/…")
    return url if url.startswith("/") else "/" + url


def _clean_type(item_type: str) -> str:
    item_type = (item_type or "").strip().lower()
    if item_type not in INVENTORY_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {list(INVENTORY_TYPES)}")
    return item_type


def _who(request: Request) -> Dict[str, Optional[str]]:
    """uid + a display name for "reported by / resolved by" (operator docs
    carry name/email since the operators page was added)."""
    op = getattr(request.state, "operator", None) or {}
    return {"uid": op.get("uid"), "name": op.get("name") or op.get("email") or op.get("uid")}


def _when(value) -> str:
    """Firestore timestamp → "16 Nov 2026, 12:54" in Bratislava time."""
    if not isinstance(value, datetime):
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    v = value.astimezone(DISPLAY_TZ)
    return f"{v.day} {_MONTHS[v.month - 1]} {v.year}, {v:%H:%M}"


# ── Read models shared with the dashboard pages ───────────────────────────

def _public_item(item_id: str, d: dict) -> dict:
    t = d.get("type") or "other"
    court = d.get("courtId")
    return {
        "id": item_id,
        "type": t,
        "typeLabel": INVENTORY_TYPES.get(t, t.replace("_", " ").title()),
        "name": d.get("name") or "",
        "description": d.get("description") or "",
        "photoUrl": d.get("photoUrl"),
        "openBugs": int(d.get("openBugs") or 0),
        "isCase": t == CASE_TYPE,
        "tournamentId": d.get("tournamentId"),
        "courtId": str(court) if court not in (None, "") else None,
        "chosenLabel": _when(d.get("tournamentChosenAt")),
        "scheduledTournamentIds": [e.get("tournamentId") for e in (d.get("scheduledTournaments") or [])
                                   if e.get("tournamentId")],
    }


def _attach_tournament_titles(items: List[dict]) -> None:
    """Resolves each case's binding to a tournament title — one batched read."""
    bound_ids = sorted({i["tournamentId"] for i in items if i["isCase"] and i["tournamentId"]})
    titles: Dict[str, Optional[str]] = {}
    if bound_ids:
        refs = [db.collection("tournaments").document(tid) for tid in bound_ids]
        for snap in db.get_all(refs):
            titles[snap.id] = (snap.to_dict() or {}).get("title") if snap.exists else None
    for i in items:
        i["tournamentTitle"] = titles.get(i["tournamentId"]) if i["tournamentId"] else None
        i["tournamentMissing"] = bool(i["tournamentId"]) and titles.get(i["tournamentId"]) is None


def list_inventory_cards() -> List[dict]:
    """Every item, sorted by name."""
    items = [_public_item(d.id, d.to_dict() or {}) for d in db.collection(INVENTORY_COLLECTION).stream()]
    _attach_tournament_titles(items)
    items.sort(key=lambda i: (i["name"] or i["id"]).lower())
    return items


def inventory_groups(items: List[dict]) -> List[dict]:
    """Items split into one section per type, in INVENTORY_TYPES order.
    ("members", not "items": in Jinja, g.items would be the dict method.)"""
    groups = []
    for key, label in INVENTORY_TYPES.items():
        groups.append({"type": key, "label": label, "members": [i for i in items if i["type"] == key]})
    unknown = [i for i in items if i["type"] not in INVENTORY_TYPES]
    if unknown:
        groups.append({"type": "unknown", "label": "Unknown type", "members": unknown})
    return groups


def _public_bug(bug_id: str, b: dict) -> dict:
    return {
        "id": bug_id,
        "title": b.get("title") or "",
        "details": b.get("details") or "",
        "status": "resolved" if b.get("status") == "resolved" else "pending",
        "createdBy": b.get("createdByName") or b.get("createdBy") or "unknown",
        "createdLabel": _when(b.get("createdAt")),
        "createdAt": b.get("createdAt"),
        "resolvedBy": b.get("resolvedByName") or b.get("resolvedBy"),
        "resolvedLabel": _when(b.get("resolvedAt")),
        "resolvedAt": b.get("resolvedAt"),
    }


def get_inventory_item_detail(item_id: str) -> Optional[dict]:
    """The item page: the item, its case binding, and its bug reports —
    pending first (newest first), then resolved (most recently resolved
    first)."""
    snap = db.collection(INVENTORY_COLLECTION).document(item_id).get()
    if not snap.exists:
        return None
    item = _public_item(snap.id, snap.to_dict() or {})
    _attach_tournament_titles([item])

    bugs = [_public_bug(b.id, b.to_dict() or {}) for b in _bugs_col(item_id).stream()]
    oldest = datetime.min.replace(tzinfo=timezone.utc)
    stamp = lambda v: v if isinstance(v, datetime) and v.tzinfo else oldest
    pending = sorted((b for b in bugs if b["status"] == "pending"), key=lambda b: stamp(b["createdAt"]), reverse=True)
    resolved = sorted((b for b in bugs if b["status"] == "resolved"), key=lambda b: stamp(b["resolvedAt"]), reverse=True)
    item["pendingBugs"], item["resolvedBugs"] = pending, resolved
    item["openBugs"] = len(pending)
    item["upcoming"], item["past"] = _item_schedule(item["scheduledTournamentIds"])
    return item


def _item_schedule(tournament_ids: List[str]):
    """The item's scheduled tournaments read LIVE (title/date may have been
    edited since scheduling): upcoming soonest first, past newest first.
    A tournament deleted since is listed as missing so it can be removed."""
    if not tournament_ids:
        return [], []
    today = datetime.now(DISPLAY_TZ).date()
    rows = []
    for snap in db.get_all([db.collection("tournaments").document(t) for t in tournament_ids]):
        t = (snap.to_dict() or {}) if snap.exists else {}
        dt = t.get("dateTime")
        local = dt.astimezone(DISPLAY_TZ) if isinstance(dt, datetime) and dt.tzinfo else None
        rows.append({
            "id": snap.id,
            "title": t.get("title") or "(deleted tournament)",
            "missing": not snap.exists,
            "status": t.get("status"),
            "date": local.date() if local else None,
            "dateLabel": f"{local.day} {_MONTHS[local.month - 1]} {local.year}" if local else "",
        })
    upcoming = sorted((r for r in rows if r["missing"] or not r["date"] or r["date"] >= today),
                      key=lambda r: (r["date"] is None, r["date"] or today))
    past = sorted((r for r in rows if not r["missing"] and r["date"] and r["date"] < today),
                  key=lambda r: r["date"], reverse=True)
    for r in upcoming:
        r["isToday"] = r["date"] == today
    return upcoming, past


def tournament_scheduled_items(tournament_id: str) -> List[dict]:
    """The equipment card on the tournament page — read from the tournament's
    own copy (tournaments/{id}/meta/inventory), grouped by type order."""
    order = list(INVENTORY_TYPES)
    items = []
    for e in _meta_items(tournament_id):
        t = e.get("type") or "other"
        items.append({**e, "typeLabel": INVENTORY_TYPES.get(t, t.replace("_", " ").title())})
    items.sort(key=lambda e: (order.index(e.get("type")) if e.get("type") in order else 99,
                              (e.get("name") or "").lower()))
    return items


# ── Scheduling copies ─────────────────────────────────────────────────────

def _item_copy(item_id: str, item: dict) -> dict:
    """What a tournament stores about a scheduled item."""
    return {"id": item_id, "name": item.get("name") or "", "type": item.get("type") or "other",
            "photoUrl": item.get("photoUrl")}


def _tournament_copy(tournament_id: str, t: dict) -> dict:
    """What an item stores about a tournament it's scheduled for."""
    return {"tournamentId": tournament_id, "title": t.get("title") or "", "dateTime": t.get("dateTime")}


META_SUBCOLLECTION, META_INVENTORY_DOC = "meta", "inventory"


def refresh_tournament_in_inventory(tournament_id: str, t: dict) -> int:
    """After a tournament's title/date changed: rewrites the copy every
    scheduled item keeps of it (inventory/{id}.scheduledTournaments).
    Returns how many items were updated."""
    batch, n = db.batch(), 0
    col = db.collection(INVENTORY_COLLECTION)
    for snap in col.where("scheduledTournamentIds", "array_contains", tournament_id).stream():
        entries = [_tournament_copy(tournament_id, t) if e.get("tournamentId") == tournament_id else e
                   for e in (snap.to_dict() or {}).get("scheduledTournaments") or []]
        batch.update(snap.reference, {"scheduledTournaments": entries})
        n += 1
    if n:
        batch.commit()
    return n


def _meta_ref(tournament_id: str):
    """tournaments/{tid}/meta/inventory — the tournament's equipment list."""
    return (db.collection("tournaments").document(tournament_id)
            .collection(META_SUBCOLLECTION).document(META_INVENTORY_DOC))


def _meta_items(tournament_id: str) -> List[dict]:
    snap = _meta_ref(tournament_id).get()
    return list((snap.to_dict() or {}).get("items") or []) if snap.exists else []


def _write_meta(batch, tournament_id: str, items: List[dict]) -> None:
    # set(merge=True): creates the meta doc on first use, never touches other
    # fields someone else may keep in it.
    batch.set(_meta_ref(tournament_id), {"items": items, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)


def _item_schedule_fields(entries: List[dict]) -> dict:
    """Both item-side fields, always written together."""
    return {"scheduledTournaments": entries,
            "scheduledTournamentIds": [e["tournamentId"] for e in entries if e.get("tournamentId")],
            "updatedAt": firestore.SERVER_TIMESTAMP}


def _sync_item_into_tournaments(batch, item_id: str, item: dict, remove: bool = False) -> int:
    """Rewrites (or removes) this item's copy in the meta/inventory doc of
    every tournament it's scheduled for. Returns how many were touched."""
    ids = [e.get("tournamentId") for e in (item.get("scheduledTournaments") or []) if e.get("tournamentId")]
    touched = 0
    for snap in db.get_all([db.collection("tournaments").document(t) for t in ids]) if ids else []:
        if not snap.exists:
            continue
        others = [e for e in _meta_items(snap.id) if e.get("id") != item_id]
        _write_meta(batch, snap.id, others if remove else others + [_item_copy(item_id, item)])
        touched += 1
    return touched


# ── API: items ────────────────────────────────────────────────────────────

class CreateInventoryItemRequest(BaseModel):
    type: str
    name: str
    photoUrl: Optional[str] = None
    description: Optional[str] = None


class UpdateInventoryItemRequest(BaseModel):
    # Type and ID are fixed after creation (a case's ID is its licence key).
    # A field left out is unchanged; "" clears photoUrl / description.
    name: Optional[str] = None
    photoUrl: Optional[str] = None
    description: Optional[str] = None


def _item_ref(item_id: str):
    ref = db.collection(INVENTORY_COLLECTION).document(item_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Inventory item not found.")
    return ref, snap.to_dict() or {}


@inventory_router.get("", dependencies=MANAGE)
def list_inventory_endpoint():
    return {"types": INVENTORY_TYPES, "items": list_inventory_cards()}


@inventory_router.post("", status_code=status.HTTP_201_CREATED, dependencies=MANAGE)
def create_inventory_item_endpoint(payload: CreateInventoryItemRequest, request: Request):
    """New item with an auto-generated ID. For a TrueVAR case that ID is the
    licence key to configure on the device."""
    doc = {
        "type": _clean_type(payload.type),
        "name": _clean_name(payload.name),
        "description": _clean_text(payload.description, "Description", MAX_DESCRIPTION),
        "photoUrl": _clean_photo_url(payload.photoUrl),
        "openBugs": 0,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "createdBy": _who(request)["uid"],
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    ref = db.collection(INVENTORY_COLLECTION).document()
    ref.set(doc)
    return {"message": "Item added", "item": _public_item(ref.id, doc)}


@inventory_router.patch("/{item_id}", dependencies=MANAGE)
def update_inventory_item_endpoint(item_id: str, payload: UpdateInventoryItemRequest):
    ref, current = _item_ref(item_id)
    changes = {}
    if payload.name is not None:
        changes["name"] = _clean_name(payload.name)
    if payload.photoUrl is not None:
        changes["photoUrl"] = _clean_photo_url(payload.photoUrl)
    if payload.description is not None:
        changes["description"] = _clean_text(payload.description, "Description", MAX_DESCRIPTION)
    if not changes:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    changes["updatedAt"] = firestore.SERVER_TIMESTAMP
    batch = db.batch()
    batch.update(ref, changes)
    if "name" in changes or "photoUrl" in changes:
        _sync_item_into_tournaments(batch, item_id, {**current, **changes})  # keep the tournaments' copies right
    batch.commit()
    return {"message": "Item updated", "item": _public_item(item_id, {**current, **changes})}


@inventory_router.delete("/{item_id}", dependencies=MANAGE)
def delete_inventory_item_endpoint(item_id: str):
    """Deletes the item and its bug reports (Firestore doesn't delete a
    subcollection with its parent), and takes it off every tournament it
    was scheduled for. Deleting a TrueVAR case revokes its
    licence: the device boots offline from its next preflight. Its old
    `cases/{id}` doc (if the migration left one) goes too — TrueVAR core
    still falls back to that collection, so leaving it would keep the
    licence alive."""
    ref, current = _item_ref(item_id)

    # Bugs first, in batches of up to 400 (Firestore's limit is 500 per batch).
    bug_refs = [b.reference for b in _bugs_col(item_id).stream()]
    for start in range(0, len(bug_refs), 400):
        batch = db.batch()
        for bref in bug_refs[start:start + 400]:
            batch.delete(bref)
        batch.commit()

    batch = db.batch()
    _sync_item_into_tournaments(batch, item_id, current, remove=True)
    batch.delete(ref)
    if current.get("type") == CASE_TYPE:
        batch.delete(db.collection(LEGACY_CASES_COLLECTION).document(item_id))
    batch.commit()
    return {"message": "Item deleted", "id": item_id, "bugsDeleted": len(bug_refs)}


# ── API: bug reports (inventory/{itemId}/bugs) ────────────────────────────

class CreateBugRequest(BaseModel):
    title: str
    details: Optional[str] = None


class UpdateBugRequest(BaseModel):
    status: Literal["pending", "resolved"]


def _bugs_col(item_id: str):
    return db.collection(INVENTORY_COLLECTION).document(item_id).collection(BUGS_SUBCOLLECTION)


def _recount_open_bugs(item_ref, item_id: str) -> int:
    """Sets inventory/{id}.openBugs from the subcollection itself — a fresh
    count each time, so it can't drift the way a +1/-1 counter could."""
    n = sum(1 for _ in _bugs_col(item_id).where("status", "==", "pending").stream())
    item_ref.update({"openBugs": n})
    return n


@inventory_router.post("/{item_id}/bugs", status_code=status.HTTP_201_CREATED, dependencies=MANAGE)
def create_bug_endpoint(item_id: str, payload: CreateBugRequest, request: Request):
    item_ref, _ = _item_ref(item_id)
    who = _who(request)
    bug = {
        "title": _clean_text(payload.title, "Title", MAX_BUG_TITLE, required=True),
        "details": _clean_text(payload.details, "Details", MAX_BUG_DETAILS),
        "status": "pending",
        "createdAt": firestore.SERVER_TIMESTAMP,
        "createdBy": who["uid"],
        "createdByName": who["name"],
    }
    bug_ref = _bugs_col(item_id).document()
    bug_ref.set(bug)
    open_bugs = _recount_open_bugs(item_ref, item_id)
    return {"message": "Bug reported", "id": bug_ref.id, "openBugs": open_bugs}


@inventory_router.patch("/{item_id}/bugs/{bug_id}", dependencies=MANAGE)
def update_bug_endpoint(item_id: str, bug_id: str, payload: UpdateBugRequest, request: Request):
    """Mark resolved, or reopen (back to pending)."""
    item_ref, _ = _item_ref(item_id)
    bug_ref = _bugs_col(item_id).document(bug_id)
    if not bug_ref.get().exists:
        raise HTTPException(status_code=404, detail="Bug report not found.")

    if payload.status == "resolved":
        who = _who(request)
        bug_ref.update({"status": "resolved", "resolvedAt": firestore.SERVER_TIMESTAMP,
                        "resolvedBy": who["uid"], "resolvedByName": who["name"]})
    else:
        bug_ref.update({"status": "pending", "resolvedAt": firestore.DELETE_FIELD,
                        "resolvedBy": firestore.DELETE_FIELD, "resolvedByName": firestore.DELETE_FIELD})
    open_bugs = _recount_open_bugs(item_ref, item_id)
    return {"message": "Bug updated", "id": bug_id, "status": payload.status, "openBugs": open_bugs}


# ── API: scheduling (item ↔ tournament) ───────────────────────────────────
# Read-modify-write of small lists, committed in one batch. Only TOS edits
# these, so two edits of the same tournament at the same instant (the one
# case where a write could be lost) isn't a practical concern.

def _tournament_ref(tournament_id: str):
    ref = db.collection("tournaments").document(tournament_id)
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    return ref, snap.to_dict() or {}


def _same_day(a, b) -> bool:
    if not (isinstance(a, datetime) and isinstance(b, datetime)):
        return False
    a = a if a.tzinfo else a.replace(tzinfo=timezone.utc)
    b = b if b.tzinfo else b.replace(tzinfo=timezone.utc)
    return a.astimezone(DISPLAY_TZ).date() == b.astimezone(DISPLAY_TZ).date()


class ScheduleItemsRequest(BaseModel):
    itemIds: List[str]


def schedule_items(tournament_id: str, item_ids: List[str]) -> dict:
    """Schedules several items for one tournament in a single batch (items
    already on it are refreshed, not duplicated). For TrueVAR cases, warns
    when one is also scheduled for another tournament the same day — then
    it won't pick a tournament by itself at power-on."""
    ids = list(dict.fromkeys(i.strip() for i in item_ids if i and i.strip()))
    if not ids:
        raise HTTPException(status_code=400, detail="Choose at least one item.")
    if len(ids) > 200:
        raise HTTPException(status_code=400, detail="Too many items at once (max 200).")
    _, t = _tournament_ref(tournament_id)

    snaps = {s.id: s for s in db.get_all([db.collection(INVENTORY_COLLECTION).document(i) for i in ids])}
    missing = [i for i in ids if not snaps[i].exists]
    if missing:
        raise HTTPException(status_code=404, detail=f"Inventory item(s) not found: {', '.join(missing)}")
    items = {i: (snaps[i].to_dict() or {}) for i in ids}

    # Same-day check for cases: read every other tournament they're on, once.
    other_ids = sorted({e.get("tournamentId") for i, it in items.items() if it.get("type") == CASE_TYPE
                        for e in it.get("scheduledTournaments") or []
                        if e.get("tournamentId") and e.get("tournamentId") != tournament_id})
    other = {s.id: (s.to_dict() or {}) for s in db.get_all(
        [db.collection("tournaments").document(o) for o in other_ids]) if s.exists} if other_ids else {}
    warnings = []
    for i, it in items.items():
        if it.get("type") != CASE_TYPE:
            continue
        clash = [other[e["tournamentId"]].get("title") or e["tournamentId"]
                 for e in it.get("scheduledTournaments") or []
                 if e.get("tournamentId") in other and _same_day(other[e["tournamentId"]].get("dateTime"), t.get("dateTime"))]
        if clash:
            warnings.append(f"{it.get('name') or i} is also scheduled for {', '.join(clash)} on the same day — "
                            "it won't pick a tournament by itself at power-on.")

    batch = db.batch()
    meta = [e for e in _meta_items(tournament_id) if e.get("id") not in items]
    _write_meta(batch, tournament_id, meta + [_item_copy(i, it) for i, it in items.items()])
    for i, it in items.items():
        entries = [e for e in it.get("scheduledTournaments") or [] if e.get("tournamentId") != tournament_id]
        batch.update(snaps[i].reference, _item_schedule_fields(entries + [_tournament_copy(tournament_id, t)]))
    batch.commit()
    return {"message": f"{len(ids)} item{'s' if len(ids) != 1 else ''} scheduled",
            "scheduled": ids, "warnings": warnings}


@inventory_router.post("/tournaments/{tournament_id}", dependencies=MANAGE)
def schedule_items_endpoint(tournament_id: str, payload: ScheduleItemsRequest):
    """Equipment card → "Add selected": several items at once."""
    return schedule_items(tournament_id, payload.itemIds)


@inventory_router.post("/{item_id}/schedule/{tournament_id}", dependencies=MANAGE)
def schedule_item_endpoint(item_id: str, tournament_id: str):
    """One item (same as the bulk endpoint with a single id)."""
    result = schedule_items(tournament_id, [item_id])
    return {"message": "Item scheduled", "warning": (result["warnings"] or [None])[0]}


@inventory_router.delete("/{item_id}/schedule/{tournament_id}", dependencies=MANAGE)
def unschedule_item_endpoint(item_id: str, tournament_id: str):
    """Removes the pairing from both sides. Works when either side is
    already gone (a deleted tournament still listed on the item, or the
    reverse)."""
    item_ref = db.collection(INVENTORY_COLLECTION).document(item_id)
    item_snap, t_snap = item_ref.get(), db.collection("tournaments").document(tournament_id).get()
    if not item_snap.exists and not t_snap.exists:
        raise HTTPException(status_code=404, detail="Neither the item nor the tournament exists.")

    batch = db.batch()
    if t_snap.exists:
        _write_meta(batch, tournament_id, [e for e in _meta_items(tournament_id) if e.get("id") != item_id])
    if item_snap.exists:
        entries = [e for e in (item_snap.to_dict() or {}).get("scheduledTournaments") or []
                   if e.get("tournamentId") != tournament_id]
        batch.update(item_ref, _item_schedule_fields(entries))
    batch.commit()
    return {"message": "Item unscheduled"}


# ── Tournament deleted → clean up inventory ───────────────────────────────

def remove_tournament_from_inventory(tournament_id: str) -> Dict[str, int]:
    """Call when a tournament is deleted (api_router._delete_tournament_data).
      * drops it from the schedule of every item that lists it — found with
        one array-contains query on scheduledTournamentIds, so it works
        whether or not the tournament's meta subcollection is already gone;
      * clears the binding (tournamentId/courtId/tournamentChosenAt) of any
        TrueVAR case booted into it — the case would clear it itself at
        next power-on, but the inventory page shouldn't show a dead binding
        until then.
    The tournament's own meta/inventory doc goes with its subcollections.
    Returns counts for the delete endpoint's "removed" summary."""
    batch, schedules, bindings = db.batch(), 0, 0
    col = db.collection(INVENTORY_COLLECTION)

    for snap in col.where("scheduledTournamentIds", "array_contains", tournament_id).stream():
        entries = [e for e in (snap.to_dict() or {}).get("scheduledTournaments") or []
                   if e.get("tournamentId") != tournament_id]
        batch.update(snap.reference, _item_schedule_fields(entries))
        schedules += 1

    for snap in col.where("tournamentId", "==", tournament_id).stream():
        batch.update(snap.reference, {"tournamentId": firestore.DELETE_FIELD, "courtId": firestore.DELETE_FIELD,
                                      "tournamentChosenAt": firestore.DELETE_FIELD})
        bindings += 1

    if schedules or bindings:
        batch.commit()
    return {"inventory_schedules": schedules, "case_bindings": bindings}