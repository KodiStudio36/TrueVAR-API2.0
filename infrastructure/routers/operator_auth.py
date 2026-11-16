import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request, Depends, HTTPException, Query, status
from pydantic import BaseModel
from firebase_admin import firestore

from infrastructure.auth_common import db, get_current_user, get_admin_club_id

# ── Exceptions ───────────────────────────────────────────────────────────
# Two distinct denial types so the exception handler in main.py can tell
# them apart: a plain visitor with no operator record gets bounced home
# quietly, but a real operator hitting a page above their role gets a
# proper "not authorized" page — never a blank redirect that looks like
# the page simply doesn't exist.

class OperatorAuthRequiredError(HTTPException):
    def __init__(self, detail: str = "Operator sign-in required."):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


class OperatorForbiddenError(HTTPException):
    def __init__(self, detail: str = "You do not have permission to access this page."):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


# ── Roles & permissions ──────────────────────────────────────────────────

OPERATOR_ROLES = {"TRO", "TAO", "TCO", "TOS"}

# None = wildcard (all permissions). TOS "can do anything" — including the
# TOS-only permissions nobody else is given: "operator:manage",
# "tournament:create", "drafts:manage" and "inventory:manage".
# TRO / TAO: see tournaments, run the venue schedule board — nothing else.
ROLE_PERMISSIONS: Dict[str, Optional[set]] = {
    "TRO": {"dashboard:view", "tournament:view", "schedule_board:manage"},
    "TAO": {"dashboard:view", "tournament:view", "schedule_board:manage"},
    "TCO": {
        "dashboard:view", "tournament:view",
        "schedule_board:manage",
        "brackets:manage",
        "categories:manage",
        "broadcasts:manage",
        "matches:manage",
        "registrations:manage",
        "weighin:view",
    },
    "TOS": None,
}


def role_has_permission(role: str, permission: str) -> bool:
    perms = ROLE_PERMISSIONS.get(role)
    if perms is None:
        return True  # TOS wildcard
    return permission in perms


def operator_can(request, permission: str) -> bool:
    """For templates: {% if can(request, "brackets:manage") %} … {% endif %}.
    Uses the operator record require_operator already put on request.state,
    so it costs no extra read. False when there's no operator (hide)."""
    operator = getattr(getattr(request, "state", None), "operator", None)
    return bool(operator) and role_has_permission(operator.get("role"), permission)


# ── Operator record lookup ────────────────────────────────────────────────
# One point-read by uid. Candidate to fold into the session JWT later
# (with a small operatorVersion field for cheap revocation) if this shows
# up hot — same pattern discussed for club roles.

def get_operator_record(uid: str) -> Optional[dict]:
    doc = db.collection("operators").document(uid).get()
    if not doc.exists:
        return None
    data = doc.to_dict() or {}
    # Must be explicitly active. Previously a missing field counted as
    # active, so any half-written doc (e.g. from a PATCH on an unknown uid)
    # silently became a working operator.
    if data.get("active") is not True:
        return None
    if data.get("role") not in OPERATOR_ROLES:
        return None
    return data


# ── Dependency factory ─────────────────────────────────────────────────────

def require_operator(permission: str):
    """
    Usage: Depends(require_operator("brackets:manage"))
    Raises OperatorAuthRequiredError if the caller isn't a known, active
    operator at all (-> redirect home on /dashboard, plain 403 on /api).
    Raises OperatorForbiddenError if they ARE an operator but their role
    lacks this permission (-> 403 page on /dashboard, 403 JSON on /api).

    The record is cached on request.state, so a route with both the
    router-level check and its own stricter check reads Firestore once.
    """
    async def _dependency(request: Request, user: Optional[dict] = Depends(get_current_user)) -> dict:
        if not user or not user.get("uid"):
            raise OperatorAuthRequiredError()

        operator = getattr(request.state, "operator", None)
        if not operator or operator.get("uid") != user["uid"]:
            operator = get_operator_record(user["uid"])
        if not operator:
            raise OperatorAuthRequiredError()

        if not role_has_permission(operator["role"], permission):
            raise OperatorForbiddenError(
                f"Your role ({operator['role']}) does not have '{permission}' access."
            )

        request.state.operator = operator
        return operator

    return _dependency


# ── User profile → operator card fields ──────────────────────────────────
# name / email / photoUrl are COPIED onto the operator doc so listing
# operators is one collection read. They're display-only; access is still
# decided by uid + role + active. POST /sync-profiles refreshes them.

def _user_doc(uid: str) -> Optional[dict]:
    doc = db.collection("users").document(uid).get()
    if doc.exists:
        return doc.to_dict() or {}
    # Fallback in case users docs aren't keyed by uid.
    for d in db.collection("users").where("uid", "==", uid).limit(1).stream():
        return d.to_dict() or {}
    return None


def _profile_fields(user: dict) -> dict:
    first = (user.get("firstname") or user.get("firstName") or "").strip()
    last = (user.get("lastname") or user.get("lastName") or "").strip()
    name = (user.get("displayName") or user.get("name") or f"{first} {last}").strip()
    return {
        "name": name or None,
        "email": (user.get("email") or "").strip().lower() or None,
        "photoUrl": user.get("photoUrl") or user.get("photoURL") or user.get("picture") or None,
    }


def _active_tos_uids() -> List[str]:
    q = db.collection("operators").where("role", "==", "TOS").where("active", "==", True)
    return [d.id for d in q.stream()]


def _guard_last_tos(uid: str, *, new_role: Optional[str] = None, deactivate: bool = False) -> None:
    """Refuse a change that would leave no active TOS — nobody could manage
    operators any more without editing Firestore by hand."""
    tos = _active_tos_uids()
    if uid in tos and len(tos) == 1 and (deactivate or (new_role and new_role != "TOS")):
        raise HTTPException(status_code=409, detail="This is the last active TOS. Make someone else TOS first.")


def _check_role(role: str) -> str:
    role = (role or "").strip().upper()
    if role not in OPERATOR_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(OPERATOR_ROLES)}")
    return role


def _public_operator(uid: str, data: dict) -> dict:
    created = data.get("createdAt")
    return {
        "uid": uid,
        "role": data.get("role"),
        "active": data.get("active") is True,
        "name": data.get("name"),
        "email": data.get("email"),
        "photoUrl": data.get("photoUrl"),
        "createdBy": data.get("createdBy"),
        "createdAt": created.isoformat() if hasattr(created, "isoformat") else None,
    }


def list_operator_cards() -> List[dict]:
    """Every operator (active first, then by name) — used by the
    /dashboard/operators page and GET /api/operators."""
    ops = [_public_operator(d.id, d.to_dict() or {}) for d in db.collection("operators").stream()]
    ops.sort(key=lambda o: (not o["active"], (o["name"] or o["email"] or o["uid"]).lower()))
    return ops


# ── Operator management (TOS only) ─────────────────────────────────────────

class CreateOperatorRequest(BaseModel):
    uid: str
    role: str


class UpdateOperatorRoleRequest(BaseModel):
    role: str


operator_router = APIRouter(prefix="/api/operators", tags=["Operators"])
MANAGE = [Depends(require_operator("operator:manage"))]


@operator_router.get("/user-search", dependencies=MANAGE)
def search_users_by_email(
    email: str = Query(..., min_length=2),
    limit: int = Query(8, ge=1, le=20),
):
    """Prefix search on users.email for the "Add operator" form. Each hit
    says whether that user is already an (active) operator."""
    key = email.strip().lower()
    q = (db.collection("users")
         .where("email", ">=", key)
         .where("email", "<=", key + "")
         .limit(limit))
    hits = []
    for d in q.stream():
        u = d.to_dict() or {}
        uid = u.get("uid") or d.id
        hits.append({"uid": uid, **_profile_fields(u)})

    ops = {}
    if hits:
        refs = [db.collection("operators").document(h["uid"]) for h in hits]
        ops = {s.id: (s.to_dict() or {}) for s in db.get_all(refs) if s.exists}
    for h in hits:
        o = ops.get(h["uid"])
        h["operatorRole"] = o.get("role") if o else None
        h["operatorActive"] = bool(o) and o.get("active") is True
    return {"users": hits}


@operator_router.post("", status_code=status.HTTP_201_CREATED, dependencies=MANAGE)
def create_operator(payload: CreateOperatorRequest, request: Request):
    """Makes an existing user an operator (or re-activates a revoked one)."""
    role = _check_role(payload.role)
    user = _user_doc(payload.uid)
    if user is None:
        raise HTTPException(status_code=404, detail="No user with this uid — they must sign in once first.")

    ref = db.collection("operators").document(payload.uid)
    existing = ref.get()
    if existing.exists and (existing.to_dict() or {}).get("active") is True:
        raise HTTPException(status_code=409, detail="This user is already an operator.")

    doc = {
        "uid": payload.uid,
        "role": role,
        "active": True,
        **_profile_fields(user),
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    if not existing.exists:
        # Only on the first grant — re-activating keeps the original history.
        doc["createdAt"] = firestore.SERVER_TIMESTAMP
        doc["createdBy"] = request.state.operator.get("uid")
    else:
        doc["reactivatedBy"] = request.state.operator.get("uid")
    ref.set(doc, merge=True)
    return {"message": "Operator granted", "operator": _public_operator(payload.uid, {**doc, "createdAt": None})}


@operator_router.get("", dependencies=MANAGE)
def list_operators():
    return {"operators": list_operator_cards()}


@operator_router.post("/sync-profiles", dependencies=MANAGE)
def sync_operator_profiles():
    """Copies the current name / email / photo from users onto every
    operator doc — run once for operators created before these fields
    existed, and whenever someone changes their profile."""
    updated, missing = 0, []
    batch, cache = db.batch(), {}
    for d in db.collection("operators").stream():
        user = _user_doc(d.id)
        if user is None:
            missing.append(d.id)
            continue
        fields = _profile_fields(user)
        batch.update(d.reference, {**fields, "updatedAt": firestore.SERVER_TIMESTAMP})
        # ...and in the meta/operators copy of every tournament they're on.
        _refresh_operator_copies(cache, d.id, {**(d.to_dict() or {}), **fields})
        updated += 1
    _flush_ops_meta(batch, cache)
    batch.commit()
    return {"updated": updated, "missingUsers": missing}


def _existing_operator_ref(uid: str):
    ref = db.collection("operators").document(uid)
    if not ref.get().exists:
        # Previously set(merge=True) here created a brand-new doc for any uid.
        raise HTTPException(status_code=404, detail="Operator not found.")
    return ref


@operator_router.patch("/{uid}", dependencies=MANAGE)
def update_operator_role(uid: str, payload: UpdateOperatorRoleRequest, request: Request):
    role = _check_role(payload.role)
    ref = _existing_operator_ref(uid)
    if uid == request.state.operator.get("uid") and role != "TOS":
        raise HTTPException(status_code=409, detail="You can't remove your own TOS role.")
    _guard_last_tos(uid, new_role=role)
    batch = db.batch()
    batch.update(ref, {"role": role, "updatedAt": firestore.SERVER_TIMESTAMP})
    cache = {}
    _refresh_operator_copies(cache, uid, {**(ref.get().to_dict() or {}), "role": role})
    _flush_ops_meta(batch, cache)
    batch.commit()
    return {"message": "Role updated", "uid": uid, "role": role}


@operator_router.delete("/{uid}", dependencies=MANAGE)
def revoke_operator(uid: str, request: Request):
    """Soft revoke (active = false) — the card stays and can be re-activated."""
    ref = _existing_operator_ref(uid)
    if uid == request.state.operator.get("uid"):
        raise HTTPException(status_code=409, detail="You can't revoke yourself.")
    _guard_last_tos(uid, deactivate=True)
    ref.update({"active": False, "updatedAt": firestore.SERVER_TIMESTAMP,
                "revokedBy": request.state.operator.get("uid")})
    return {"message": "Operator revoked", "uid": uid}



# ── Operators per tournament: "I'm free" + TOS selection ─────────────────
#
#   tournaments/{tid}/meta/operators = {
#       available: [{uid, name, photoUrl, role, at}],   # marked themselves free
#       selected:  [{uid, name, photoUrl, role, at}],   # picked by a TOS (⊂ available)
#       updatedAt }
#   operators/{uid}.availableTournamentIds / .selectedTournamentIds = [tid, …]
#
# Both sides are copies written together in one batch (same pattern as the
# inventory's meta/inventory). The tournament page reads the meta doc; the
# calendar and the operator's profile read the id lists. The id lists are
# plain strings so a deleted tournament is found with array-contains.
# Timestamps inside the arrays are real datetimes — Firestore doesn't allow
# SERVER_TIMESTAMP inside array elements.

OPS_META_DOC = "operators"
VENUE_TZ = ZoneInfo("Europe/Bratislava")


def _ops_meta_ref(tournament_id: str):
    return db.collection("tournaments").document(tournament_id).collection("meta").document(OPS_META_DOC)


def _ops_meta(tournament_id: str) -> Dict[str, List[dict]]:
    snap = _ops_meta_ref(tournament_id).get()
    d = (snap.to_dict() or {}) if snap.exists else {}
    return {"available": list(d.get("available") or []), "selected": list(d.get("selected") or [])}


def _write_ops_meta(batch, tournament_id: str, meta: Dict[str, List[dict]]) -> None:
    # merge=True: other fields in this doc (if any) are left alone.
    batch.set(_ops_meta_ref(tournament_id), {"available": meta["available"], "selected": meta["selected"],
                                             "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)


def _op_copy(uid: str, op: dict, at: Optional[datetime] = None) -> dict:
    """What a tournament stores about an operator — no email, everyone sees it."""
    return {"uid": uid, "name": op.get("name") or op.get("email") or uid, "photoUrl": op.get("photoUrl"),
            "role": op.get("role"), "at": at or datetime.now(timezone.utc)}


def _replace(entries: List[dict], uid: str, new: Optional[dict]) -> List[dict]:
    """entries without uid, plus `new` (keeping the original "at" if there was one)."""
    old = next((e for e in entries if e.get("uid") == uid), None)
    rest = [e for e in entries if e.get("uid") != uid]
    if new is None:
        return rest
    if old and old.get("at"):
        new = {**new, "at": old["at"]}
    return rest + [new]


def _with_id(ids, tid: str, present: bool) -> List[str]:
    ids = [i for i in (ids or []) if i != tid]
    return ids + [tid] if present else ids


def _refresh_operator_copies(cache: Dict[str, dict], uid: str, op: dict) -> None:
    """Updates this operator's copy (name/photo/role) in the meta/operators
    of every tournament they're free or selected for — in `cache`
    (tid → meta, read once). Several operators can share a tournament, so
    callers collect everything first and write each meta doc once with
    _flush_ops_meta (writing per operator would let the last one overwrite
    the others' changes, all read before the batch commits)."""
    tids = set(op.get("availableTournamentIds") or []) | set(op.get("selectedTournamentIds") or [])
    for tid in tids:
        if tid not in cache:
            cache[tid] = _ops_meta(tid)
        meta = cache[tid]
        for key in ("available", "selected"):
            if any(e.get("uid") == uid for e in meta[key]):
                meta[key] = _replace(meta[key], uid, _op_copy(uid, op))
                meta["_changed"] = True


def _flush_ops_meta(batch, cache: Dict[str, dict]) -> None:
    for tid, meta in cache.items():
        if meta.pop("_changed", False):
            _write_ops_meta(batch, tid, meta)


def _tournament_doc(tournament_id: str) -> dict:
    snap = db.collection("tournaments").document(tournament_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    return snap.to_dict() or {}


def tournament_operator_meta(tournament_id: str, me_uid: Optional[str]) -> dict:
    """For the Operators card: selected and free-but-not-selected operators
    (sorted by role then name) and the viewer's own status."""
    meta = _ops_meta(tournament_id)
    order = ["TOS", "TCO", "TAO", "TRO"]
    key = lambda e: (order.index(e.get("role")) if e.get("role") in order else 9, (e.get("name") or "").lower())
    selected_uids = {e.get("uid") for e in meta["selected"]}
    available_uids = {e.get("uid") for e in meta["available"]}
    return {
        "selected": sorted(meta["selected"], key=key),
        "free": sorted((e for e in meta["available"] if e.get("uid") not in selected_uids), key=key),
        "me": "selected" if me_uid in selected_uids else ("free" if me_uid in available_uids else None),
    }


@operator_router.post("/me/availability/{tournament_id}",
                      dependencies=[Depends(require_operator("dashboard:view"))])
def mark_me_free(tournament_id: str, request: Request):
    """Any operator: "I'm free" for this tournament."""
    _tournament_doc(tournament_id)
    uid = request.state.operator.get("uid")
    ref = db.collection("operators").document(uid)
    op = ref.get().to_dict() or {}

    meta = _ops_meta(tournament_id)
    meta["available"] = _replace(meta["available"], uid, _op_copy(uid, op))
    batch = db.batch()
    _write_ops_meta(batch, tournament_id, meta)
    batch.update(ref, {"availableTournamentIds": _with_id(op.get("availableTournamentIds"), tournament_id, True)})
    batch.commit()
    return {"message": "Marked as free", "tournamentId": tournament_id}


@operator_router.delete("/me/availability/{tournament_id}",
                        dependencies=[Depends(require_operator("dashboard:view"))])
def unmark_me_free(tournament_id: str, request: Request):
    """Any operator: withdraw "I'm free" — not once a TOS has selected them."""
    uid = request.state.operator.get("uid")
    meta = _ops_meta(tournament_id)
    if any(e.get("uid") == uid for e in meta["selected"]):
        raise HTTPException(status_code=409, detail="You're already selected for this tournament — ask a TOS to remove you first.")
    ref = db.collection("operators").document(uid)
    op = ref.get().to_dict() or {}
    meta["available"] = _replace(meta["available"], uid, None)
    batch = db.batch()
    _write_ops_meta(batch, tournament_id, meta)
    batch.update(ref, {"availableTournamentIds": _with_id(op.get("availableTournamentIds"), tournament_id, False)})
    batch.commit()
    return {"message": "No longer marked as free", "tournamentId": tournament_id}


class SelectOperatorsRequest(BaseModel):
    uids: List[str]


@operator_router.post("/selection/{tournament_id}", dependencies=MANAGE)
def select_operators(tournament_id: str, payload: SelectOperatorsRequest):
    """TOS: select operators for the tournament — only ones who marked
    themselves free. Several at once."""
    _tournament_doc(tournament_id)
    uids = list(dict.fromkeys(u.strip() for u in payload.uids if u and u.strip()))
    if not uids:
        raise HTTPException(status_code=400, detail="Choose at least one operator.")
    meta = _ops_meta(tournament_id)
    free = {e.get("uid") for e in meta["available"]}
    not_free = [u for u in uids if u not in free]
    if not_free:
        raise HTTPException(status_code=400, detail="Only operators who marked themselves free can be selected.")

    snaps = {s.id: s for s in db.get_all([db.collection("operators").document(u) for u in uids])}
    batch = db.batch()
    for u in uids:
        op = (snaps[u].to_dict() or {}) if snaps[u].exists else {}
        meta["selected"] = _replace(meta["selected"], u, _op_copy(u, op))
        if snaps[u].exists:
            batch.update(snaps[u].reference,
                         {"selectedTournamentIds": _with_id(op.get("selectedTournamentIds"), tournament_id, True)})
    _write_ops_meta(batch, tournament_id, meta)
    batch.commit()
    return {"message": f"{len(uids)} operator{'s' if len(uids) != 1 else ''} selected", "selected": uids}


@operator_router.delete("/selection/{tournament_id}/{uid}", dependencies=MANAGE)
def unselect_operator(tournament_id: str, uid: str):
    """TOS: take an operator off the tournament (they stay marked free)."""
    meta = _ops_meta(tournament_id)
    meta["selected"] = _replace(meta["selected"], uid, None)
    ref = db.collection("operators").document(uid)
    snap = ref.get()
    batch = db.batch()
    _write_ops_meta(batch, tournament_id, meta)
    if snap.exists:
        batch.update(ref, {"selectedTournamentIds":
                           _with_id((snap.to_dict() or {}).get("selectedTournamentIds"), tournament_id, False)})
    batch.commit()
    return {"message": "Operator removed from the tournament"}


def remove_tournament_from_operators(tournament_id: str) -> Dict[str, int]:
    """Call when a tournament is deleted (api_router._delete_tournament_data),
    next to remove_tournament_from_inventory. Its meta/operators doc goes
    with the tournament's subcollections; this cleans the operators' lists."""
    batch, touched = db.batch(), 0
    seen = set()
    for field in ("availableTournamentIds", "selectedTournamentIds"):
        for snap in db.collection("operators").where(field, "array_contains", tournament_id).stream():
            if snap.id in seen:
                continue
            seen.add(snap.id)
            d = snap.to_dict() or {}
            batch.update(snap.reference, {
                "availableTournamentIds": _with_id(d.get("availableTournamentIds"), tournament_id, False),
                "selectedTournamentIds": _with_id(d.get("selectedTournamentIds"), tournament_id, False),
            })
            touched += 1
    if touched:
        batch.commit()
    return {"operator_availability": touched}


# ── Operator profile (read model for /dashboard/operators/{uid}) ─────────

ROLE_MEANINGS = {"TOS": "Full access", "TCO": "Runs the competition",
                 "TAO": "Schedule board only", "TRO": "Schedule board only"}
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _local(dt) -> Optional[datetime]:
    if not isinstance(dt, datetime):
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(VENUE_TZ)


def operator_profile(uid: str) -> Optional[dict]:
    """Rank (role), and tournaments: participated in (selected, already
    happened), upcoming as selected, and upcoming where only marked free.
    Tournament titles/dates are read live."""
    snap = db.collection("operators").document(uid).get()
    if not snap.exists:
        return None
    d = snap.to_dict() or {}
    selected = set(d.get("selectedTournamentIds") or [])
    available = set(d.get("availableTournamentIds") or [])
    ids = sorted(selected | available)

    today = datetime.now(VENUE_TZ).date()
    rows = []
    for t in (db.get_all([db.collection("tournaments").document(i) for i in ids]) if ids else []):
        if not t.exists:
            continue
        td = t.to_dict() or {}
        local = _local(td.get("dateTime"))
        rows.append({
            "id": t.id, "title": td.get("title") or t.id, "location": td.get("location") or "",
            "discipline": str(td.get("discipline") or "").replace("_", " ").title(),
            "date": local.date() if local else None,
            "dateLabel": f"{local.day} {_MONTHS[local.month - 1]} {local.year}" if local else "no date",
            "selected": t.id in selected,
        })

    is_past = lambda r: r["date"] is not None and r["date"] < today
    participated = sorted((r for r in rows if r["selected"] and is_past(r)), key=lambda r: r["date"], reverse=True)
    upcoming = sorted((r for r in rows if not is_past(r)), key=lambda r: (r["date"] is None, r["date"] or today))
    disciplines: Dict[str, int] = {}
    for r in participated:
        if r["discipline"]:
            disciplines[r["discipline"]] = disciplines.get(r["discipline"], 0) + 1

    created = _local(d.get("createdAt"))
    return {
        **_public_operator(uid, d),
        "roleMeaning": ROLE_MEANINGS.get(d.get("role"), ""),
        "sinceLabel": f"{created.day} {_MONTHS[created.month - 1]} {created.year}" if created else "",
        "participated": participated,
        "upcoming": upcoming,
        "disciplines": sorted(disciplines.items(), key=lambda kv: -kv[1]),
    }



# ── Registration-site navbar / settings: what is this user? ─────────────

def register_template_globals(templates) -> None:
    """Makes can / nav_roles / operator_profile available in a
    Jinja2Templates instance. Call it once for EVERY instance the app
    creates (each Jinja2Templates(...) has its own environment and its own
    globals) — e.g. right after `templates = Jinja2Templates(...)`."""
    templates.env.globals.update(
        can=operator_can,
        nav_roles=nav_roles,
        operator_profile=operator_profile,
    )


def nav_roles(request, user) -> dict:
    """{"clubId": <club they're ADMIN of or None>, "operator": <active
    operator record or None>} for the logged-in user — drives the "My Club"
    and "Dashboard" links in the registration base.html and the Operator
    card on the Settings page. Registered as a template global (see
    dashboard_router). Cached on request.state, so base.html and the page
    using it together cost one lookup."""
    state = getattr(request, "state", None)
    cached = getattr(state, "nav_roles", None) if state is not None else None
    if cached is not None:
        return cached

    result = {"clubId": None, "operator": None}
    u = user if isinstance(user, dict) else (getattr(user, "__dict__", None) or {})
    if not (u.get("uid") or u.get("id") or u.get("userId") or u.get("email")):
        # Page passed no usable user (or under another name) — fall back
        # to the session user a dependency may have put on request.state.
        su = getattr(state, "user", None) if state is not None else None
        su = su if isinstance(su, dict) else (getattr(su, "__dict__", None) or {})
        u = {**su, **u}
    uid = u.get("uid") or u.get("id") or u.get("userId")
    email = (u.get("email") or "").strip().lower()
    if uid or email:
        try:
            result["clubId"] = get_admin_club_id({**u, "uid": uid} if uid else u)
        except Exception:
            logging.exception("nav_roles: club lookup failed for %s", uid or email)
        try:
            if uid:
                result["operator"] = get_operator_record(uid)
            if result["operator"] is None and email:
                # Some routes pass the users/{uid} document (no "uid" key)
                # instead of the session — find the operator by email
                # (operator docs carry it since "Refresh profiles").
                for d in db.collection("operators").where("email", "==", email).limit(1).stream():
                    result["operator"] = get_operator_record(d.id)
        except Exception:
            logging.exception("nav_roles: operator lookup failed for %s", uid or email)
    else:
        logging.warning("nav_roles: no uid/email in user passed to the template (%r)", type(user).__name__)
    if state is not None:
        state.nav_roles = result
    return result


# ── Make the globals impossible to miss ─────────────────────────────────
# Every Jinja2Templates created AFTER this module is imported — including
# ones built inside a route function — gets can / nav_roles /
# operator_profile automatically. Instances created earlier are caught by
# the sys.modules scan at the bottom of main.py.
def _patch_jinja2templates() -> None:
    from starlette.templating import Jinja2Templates as _J
    if getattr(_J, "_truevar_globals_patched", False):
        return
    _orig_init = _J.__init__

    def _init(self, *args, **kwargs):
        _orig_init(self, *args, **kwargs)
        try:
            register_template_globals(self)
        except Exception:
            logging.exception("register_template_globals failed")

    _J.__init__ = _init
    _J._truevar_globals_patched = True


_patch_jinja2templates()