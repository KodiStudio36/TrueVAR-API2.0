import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Request, status, Query
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Tuple
from firebase_admin import firestore
import jwt
import os
import secrets

from adapters.database.firebase_case_repository import FirebaseCaseRepository
from usecases.case_usecase import CreateCaseUseCase
from usecases.tournament_usecase import CreateTournamentUseCase, GetAllTournamentsUseCase, GetTournamentUseCase, UpdateTournamentUseCase
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore

from infrastructure.auth_common import (
    db, JWT_SECRET, JWT_ALGORITHM, SESSION_COOKIE_NAME, EXPIRES_IN,
    create_session_jwt, decode_session_jwt, get_current_user,
    get_admin_club_id, get_user_roles,
)
from infrastructure.routers.operator_auth import require_operator

from adapters.database.firebase_scheduled_broadcast_repository import FirebaseScheduledBroadcastRepository
from adapters.database.firebase_stream_key_repository import FirebaseStreamKeyRepository
from usecases.tournament_usecase import SetTournamentStatusUseCase
from usecases.tournament_usecase import DeleteTournamentUseCase

from domain.ports.tournament_port import TournamentPort

JWT_SECRET = os.getenv("JWT_SECRET", "super-secret-app-key-change-in-production")
JWT_ALGORITHM = "HS256"

SESSION_COOKIE_NAME = "session"
EXPIRES_IN = timedelta(days=5)

router = APIRouter()
db = init_firestore()

# Dependency Injection for Repository
def get_tournament_repo() -> FirebaseTournamentRepository:
    return FirebaseTournamentRepository(db)

def get_broadcast_repo() -> FirebaseScheduledBroadcastRepository:
    return FirebaseScheduledBroadcastRepository(db)

def get_stream_key_repo() -> FirebaseStreamKeyRepository:
    return FirebaseStreamKeyRepository(db)

# Pydantic Schemas for API Serialization/Validation
class CreateTournamentRequest(BaseModel):
    title: str
    location: str
    courtNum: int
    dateTime: datetime
    sport: str
    discipline: str
    provider: str
    mode: str
    isStream: bool
    isExternalPublic: bool
    venueName: str
    numbering: str
    # Registration fields
    isRegistrationOpen: bool = False
    registrationDeadline: Optional[datetime] = None
    categories: Optional[Dict] = None
    # Only meaningful when isRegistrationOpen is False — a pointer to an
    # outside registration site (Google Form, federation portal, etc.)
    # shown on the public tournament page instead of the in-app flow.
    externalRegistrationUrl: Optional[str] = None

class UpdateTournamentRequest(BaseModel):
    title: str
    location: str
    courtNum: int
    dateTime: datetime
    sport: str
    discipline: str
    provider: str
    mode: str
    isStream: bool
    isExternalPublic: bool
    venueName: str
    numbering: str
    externalRegistrationUrl: Optional[str] = None

class TournamentResponse(BaseModel):
    id: str | None
    title: str
    location: str
    courtNum: int
    dateTime: datetime
    discipline: str
    sport: str
    settings: dict
    playlistId: Optional[str] = None
    streams: Dict[str, Dict[str, str]] = {}

    class Config:
        from_attributes = True

# ── PARA CLASSIFICATION ────────────────────────────────────────────────────
# Fixed set of Para sport-class codes selectable when an athlete is flagged
# isPara=True. Kept as a plain module-level list (not Firestore-driven) since
# this is a small, rarely-changing classification table — mirrors the same
# list rendered in create_athlete.html's paraCategory <select>, and the
# para_class_options match_values in the tournament category schema.
PARA_CATEGORIES = [
    "P11", "P12",
    "P21", "P22", "P23",
    "P31", "P32", "P33", "P34", "P35",
    "P41", "P42", "P43", "P44", "P45",
    "P51", "P52", "P53",
    "P60",
    "P72",
]

# Default para class split used for any para entry type whose schema doesn't
# list its own para_class_options — mirrors DEFAULT_PARA_CLASS_OPTIONS in
# tournament.html, so category codes match on both sides
# (e.g. para_individual_poomsae_seniors_p72_men).
DEFAULT_PARA_CLASS_OPTIONS = [
    {"code": c.lower(), "label": c, "match_value": c} for c in PARA_CATEGORIES
]

class CreateAthleteRequest(BaseModel):
    firstName: str
    lastName: str
    gender: str
    birthday: str  # YYYY-MM-DD from HTML form
    country: str
    sport: str     # "taekwondo" or "boxing"
    rank: int
    associationId: Optional[str] = None  # optional, sport-scoped national/association federation ID
    isPara: bool = False
    paraCategory: Optional[str] = None   # required (one of PARA_CATEGORIES) when isPara is True


class UpdateAthleteRequest(BaseModel):
    firstName: str
    lastName: str
    gender: str
    birthday: str
    country: str
    rank: int
    associationId: Optional[str] = None
    isPara: bool = False
    paraCategory: Optional[str] = None

VALID_STATUSES = {"active", "archived"}

class StatusUpdate(BaseModel):
    status: str


@router.post("/tournaments", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_operator("tournament:create"))])
def create_tournament_endpoint(
    payload: CreateTournamentRequest,
    repo: FirebaseTournamentRepository = Depends(get_tournament_repo)
):
    use_case = CreateTournamentUseCase(repo)

    # 1. Create core tournament entity with registration settings
    created_tournament = use_case.execute(
        title=payload.title,
        location=payload.location,
        courtNum=payload.courtNum,
        dateTime=payload.dateTime,
        sport=payload.sport.lower(),
        discipline=payload.discipline.lower(),
        isExternalPublic=payload.isExternalPublic,
        isRegistrationOpen=payload.isRegistrationOpen,
        settings={
            "isStream": payload.isStream,
            "venueName": payload.venueName,
            "numbering": payload.numbering,
            "provider": payload.provider,
            "mode": payload.mode,
            # Consolidated registration config inside settings
            "registrationDeadline": payload.registrationDeadline.isoformat() if payload.registrationDeadline else None,
            # Only stored when registration is closed here — it's a pointer
            # to somewhere else, not something that should coexist with the
            # in-app registration flow.
            "externalRegistrationUrl": (
                (payload.externalRegistrationUrl or "").strip() or None
                if not payload.isRegistrationOpen else None
            ),
        },
    )

    tournament_id = created_tournament.id

    # 2. Upload category JSON definition to tournament_categories/{tournamentId}
    if payload.isRegistrationOpen and payload.categories:
        db.collection("tournament_categories").document(tournament_id).set({
            "tournamentId": tournament_id,
            "categories": payload.categories,
            "createdAt": firestore.SERVER_TIMESTAMP
        })

    return {"id": tournament_id, "message": "Tournament created successfully"}


@router.get("/tournaments", response_model=List[TournamentResponse])
def dashboard_endpoint(repo=Depends(get_tournament_repo)):
    """Acts as the dashboard aggregator endpoint providing all tournaments."""
    use_case = GetAllTournamentsUseCase(repo)
    return use_case.execute()

@router.get("/tournaments/paginated")
def list_tournaments_paginated(
    status: str = Query("active", pattern="^(active|archived)$"),
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
    isExternalPublic: Optional[bool] = Query(None, description="Filter to publicly-listed tournaments only"),
    repo: TournamentPort = Depends(get_tournament_repo),
):
    tournaments = repo.getTournamentsPaginated(
        status=status, limit=limit, offset=offset, isExternalPublic=isExternalPublic
    )
    return {
        "tournaments": [
            {
                "id": t.id,
                "title": t.title,
                "location": t.location,
                "courtNum": t.courtNum,
                "dateTime": t.dateTime.isoformat() if t.dateTime else None,
                "discipline": t.discipline,
                "status": t.status,
                "playlistId": getattr(t, "playlistId", None),
                "streams": getattr(t, "streams", {}),
            }
            for t in tournaments
        ],
        "has_more": len(tournaments) == limit,  # heuristic: a full page implies there may be another
        "next_offset": offset + len(tournaments),
    }

@router.get("/tournaments/{tournament_id}/categories")
def get_tournament_categories(tournament_id: str):
    doc = db.collection("tournament_categories").document(tournament_id).get()
    if not doc.exists:
        return {"tournamentId": tournament_id, "categories": {}}

    data = doc.to_dict()
    return {"tournamentId": tournament_id, "categories": data.get("categories", {})}


def _birth_year(athlete_data: dict) -> Optional[int]:
    birthday = athlete_data.get("birthday")
    return birthday.year if hasattr(birthday, "year") else None


def _build_roster_member(athlete_id: str, athlete: dict, sport: Optional[str]) -> dict:
    sport_data = (athlete.get("sports") or {}).get(sport, {}) if sport else {}
    entry = {
        "athleteId": athlete_id,
        "name": athlete.get("displayName") or f"{athlete.get('firstName', '')} {athlete.get('lastName', '')}".strip(),
        "club": sport_data.get("clubName", ""),
        "clubId": sport_data.get("clubId"),
        "country": athlete.get("country"),
    }
    if sport_data.get("rank") is not None:
        entry["rank"] = sport_data["rank"]
    if sport_data.get("associationId"):
        entry["associationId"] = sport_data["associationId"]
    if sport_data.get("isPara"):
        entry["isPara"] = True
        if sport_data.get("paraCategory"):
            entry["paraCategory"] = sport_data["paraCategory"]
    return entry


def get_admin_club_id(user: Optional[dict]) -> Optional[str]:
    roles = (user or {}).get("roles", {})
    for club_id, role in roles.items():
        if role == "ADMIN":
            return club_id
    return None

def create_session_jwt(user_data: dict, expires_delta: timedelta) -> str:
    to_encode = user_data.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_session_jwt(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    except Exception:
        return None


def get_user_roles(uid: str) -> dict:
    perms_docs = db.collection("user_permissions").where("uid", "==", uid).stream()
    roles = {}
    for doc in perms_docs:
        data = doc.to_dict()
        roles[data.get("clubId")] = data.get("role", "COACH")
    return roles

def get_club_sport(club_id: Optional[str]) -> Optional[str]:
    if not club_id:
        return None
    club_doc = db.collection("clubs").document(club_id).get()
    return club_doc.to_dict().get("sport") if club_doc.exists else None


# ── FASTAPI DEPENDENCIES ──────────────────────────────────────────────────────

async def get_current_user(request: Request) -> Optional[dict]:
    session_cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if not session_cookie:
        return None

    return decode_session_jwt(session_cookie)


def _sport_club_fields(a: dict, sport_key: Optional[str]) -> dict:
    """
    Sport-scoped fields surfaced by both athlete search endpoints. isPara /
    paraCategory are included so the registration modal can block non-para
    athletes from para entry types and auto-resolve their para class.
    """
    sport_data = (a.get("sports") or {}).get(sport_key, {}) if sport_key else {}
    return {
        "club": sport_data.get("clubName", ""),
        "clubId": sport_data.get("clubId"),
        "rank": sport_data.get("rank"),
        "isPara": bool(sport_data.get("isPara")),
        "paraCategory": sport_data.get("paraCategory"),
    }


@router.get("/athletes/search")
def search_athletes(
    q: str = Query(..., min_length=1),
    limit: int = Query(8, ge=1, le=20),
    user: Optional[dict] = Depends(get_current_user),
):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")
    club_sport = get_club_sport(admin_club_id)
    if not club_sport:
        raise HTTPException(status_code=500, detail="Club has no sport configured.")

    search_key = q.strip().lower()
    if not search_key:
        return {"athletes": []}

    club_field = f"sports.{club_sport}.clubId"

    seen_ids, candidates = set(), []
    for field in ("firstName", "lastName"):
        query = (
            db.collection("athletes")
            .where(club_field, "==", admin_club_id)
            .where(field, ">=", search_key)
            .where(field, "<=", search_key + "\uf8ff")
        )
        for doc in query.stream():
            if doc.id in seen_ids:
                continue
            seen_ids.add(doc.id)
            data = doc.to_dict()
            candidates.append({"id": doc.id, **data, "birthYear": _birth_year(data)})

    candidates.sort(key=lambda a: (a.get("lastName", ""), a.get("firstName", "")))

    return {"athletes": [
        {
            "id": a["id"],
            "displayName": a.get("displayName") or f"{a.get('firstName','')} {a.get('lastName','')}".strip(),
            "firstname": a.get("firstName", ""), "lastname": a.get("lastName", ""),
            **_sport_club_fields(a, club_sport),
            "gender": a.get("gender"), "birthYear": a.get("birthYear"),
        }
        for a in candidates[:limit]
    ]}


@router.get("/athletes/search-admin",
            dependencies=[Depends(require_operator("registrations:manage"))])
def search_athletes_admin(
    q: str = Query(..., min_length=1),
    sport: str = Query(..., description="Which sport's club membership to surface"),
    limit: int = Query(8, ge=1, le=20),
):
    """
    Staff-only athlete search. Backs both the category manager's "+ Add
    Athlete" button AND the live queue's ad hoc match-insert modal
    (see insert_match_endpoint) — same unguarded, all-clubs search.

    TODO: same as admin_move_registration_endpoint — gate behind staff
    auth once it exists.
    """
    search_key = q.strip().lower()
    if not search_key:
        return {"athletes": []}
    sport_key = sport.strip().lower()

    seen_ids, candidates = set(), []
    for field in ("firstName", "lastName"):
        query = db.collection("athletes").where(field, ">=", search_key).where(field, "<=", search_key + "\uf8ff")
        for doc in query.stream():
            if doc.id in seen_ids:
                continue
            seen_ids.add(doc.id)
            data = doc.to_dict()
            candidates.append({"id": doc.id, **data, "birthYear": _birth_year(data)})

    candidates.sort(key=lambda a: (a.get("lastName", ""), a.get("firstName", "")))

    return {"athletes": [
        {
            "id": a["id"],
            "displayName": a.get("displayName") or f"{a.get('firstName','')} {a.get('lastName','')}".strip(),
            **_sport_club_fields(a, sport_key),
            "country": a.get("country"), "gender": a.get("gender"), "birthYear": a.get("birthYear"),
        }
        for a in candidates[:limit]
    ]}


class RegisterEntryRequest(BaseModel):
    athleteIds: List[str]
    entryTypeCode: str
    ageCode: str
    beltClassCode: Optional[str] = None
    paraClassCode: Optional[str] = None
    genderCode: str
    categoryCode: str
    categoryLabel: str


# ── PARA ELIGIBILITY ──────────────────────────────────────────────────────
# An entry_type option in the tournament's category schema can declare:
#   "requires_para": true            → only athletes with isPara may enter
#   "para_class_options": [...]      → each {code, label, match_value}; the
#                                      athlete's paraCategory must equal the
#                                      chosen option's match_value.
# Declaring para_class_options implies requires_para. The frontend resolves
# the class automatically; this is the server-side guarantee for club
# registrations. Staff endpoints (admin-add / admin-move) are exempt.

def _find_entry_type_option(tournament_id: str, entry_type_code: str) -> Optional[dict]:
    doc = db.collection("tournament_categories").document(tournament_id).get()
    if not doc.exists:
        return None
    schemas = ((doc.to_dict() or {}).get("categories") or {}).get("sportSchemas") or {}
    for sport_schema in schemas.values():
        for disc in (sport_schema.get("disciplines") or {}).values():
            for dim in disc.get("dimensions") or []:
                if dim.get("key") != "entry_type":
                    continue
                for opt in dim.get("options") or []:
                    if opt.get("code") == entry_type_code:
                        return opt
    return None


def _para_rules(opt: Optional[dict], entry_type_code: str) -> Tuple[bool, List[dict]]:
    """
    (requires_para, para_class_options) for an entry type. Mirrors
    parseCategories in tournament.html so the server enforces the same
    rules even when the stored schema predates the para fields:
      - requires_para: false        → explicit opt-out, never para-only
      - requires_para: true, a code starting with "para_", or a non-empty
        para_class_options           → para-only
      - para_class_options present  → that list ([] = para-only, no split)
      - otherwise                   → DEFAULT_PARA_CLASS_OPTIONS (P11…P72)
    """
    opt = opt or {}
    if opt.get("requires_para") is False:
        return False, []
    explicit = opt.get("para_class_options")
    explicit = explicit if isinstance(explicit, list) else None
    requires = (
        opt.get("requires_para") is True
        or (entry_type_code or "").lower().startswith("para_")
        or bool(explicit)
    )
    if not requires:
        return False, []
    return True, (explicit if explicit is not None else DEFAULT_PARA_CLASS_OPTIONS)


def _validate_para_eligibility(
    tournament_id: str,
    entry_type_code: str,
    para_class_code: Optional[str],
    category_code: str,
    athletes: List[Tuple[str, dict]],
    sport: Optional[str],
    require_class: bool = True,
) -> None:
    """
    Para-only entry types accept only athletes with isPara == True (a missing
    isPara field counts as not para). When the entry type splits by para
    class, the class is read from the category code itself
    (…_seniors_p72_men → P72) and every athlete's paraCategory must equal it.

    Called for club registrations/edits only — the staff endpoints
    (admin-add, admin-move) skip it so staff can place anyone anywhere.
    require_class=False tolerates a code without a class segment.
    """
    opt = _find_entry_type_option(tournament_id, entry_type_code)
    requires_para, para_opts = _para_rules(opt, entry_type_code)

    if not requires_para:
        if para_class_code:
            raise HTTPException(status_code=400, detail="This entry type has no para classes.")
        return

    def _name(a: dict) -> str:
        return a.get("displayName") or f"{a.get('firstName', '')} {a.get('lastName', '')}".strip()

    def _sport_data(a: dict) -> dict:
        return (a.get("sports") or {}).get(sport) or {}

    for _, a in athletes:
        if _sport_data(a).get("isPara") is not True:
            raise HTTPException(
                status_code=400,
                detail=f"{_name(a)} is not registered as a para athlete. Only para athletes can enter this category.",
            )

    if not para_opts:
        return  # para-only entry type without a class split

    wrapped = f"_{category_code}_"
    in_code = [p for p in para_opts if p.get("code") and f"_{p['code']}_" in wrapped]
    if len(in_code) > 1:
        raise HTTPException(status_code=400, detail="Category code contains more than one para class.")
    chosen = in_code[0] if in_code else None

    if para_class_code and (not chosen or chosen.get("code") != para_class_code):
        raise HTTPException(status_code=400, detail="Category code does not match the para class.")

    if not chosen:
        if require_class:
            raise HTTPException(status_code=400, detail="A para class (e.g. P72) is required for this category.")
        return

    expected = str(chosen.get("match_value") or chosen.get("code") or "").upper()
    for _, a in athletes:
        actual = str(_sport_data(a).get("paraCategory") or "").upper()
        if actual != expected:
            raise HTTPException(
                status_code=400,
                detail=f"{_name(a)} is classified {actual or 'without a para class'}, not {expected}.",
            )


def _execute_registration_create(
    tournament_id: str,
    payload: RegisterEntryRequest,
    requesting_club_id: Optional[str],
    enforce_club_match: bool,
) -> None:
    if not payload.athleteIds:
        raise HTTPException(status_code=400, detail="At least one athlete is required.")

    tournament_ref = db.collection("tournaments").document(tournament_id)
    tournament_doc = tournament_ref.get()
    sport = tournament_doc.to_dict().get("sport") if tournament_doc.exists else None

    members = []
    athlete_docs: List[Tuple[str, dict]] = []
    for athlete_id in payload.athleteIds:
        athlete_doc = db.collection("athletes").document(athlete_id).get()
        if not athlete_doc.exists:
            raise HTTPException(status_code=404, detail=f"Athlete {athlete_id} not found.")
        athlete = athlete_doc.to_dict()
        athlete_club_id = ((athlete.get("sports") or {}).get(sport) or {}).get("clubId")
        if enforce_club_match and athlete_club_id != requesting_club_id:
            raise HTTPException(status_code=403, detail="You can only register athletes from your own club.")
        members.append(_build_roster_member(athlete_id, athlete, sport))
        athlete_docs.append((athlete_id, athlete))

    # Para rules bind CLUB registrations only. Staff (admin-add, from the
    # category manager) can put any athlete into any category — e.g. a
    # non-para athlete into a para category, or a class the athlete isn't
    # classified as — so the check is skipped entirely on that path.
    if enforce_club_match:
        _validate_para_eligibility(
            tournament_id, payload.entryTypeCode, payload.paraClassCode,
            payload.categoryCode, athlete_docs, sport,
        )

    entry_id = "-".join(sorted(payload.athleteIds))

    club_id = requesting_club_id or (members[0].get("clubId") if members else None)
    club_name = members[0].get("club") if members else None
    # Sport-scoped national/association federation ID, same source as the
    # roster member's own "associationId" field (see _build_roster_member)
    # — captured here too so it's on the registration doc itself, not just
    # buried inside division_rosters.
    association_id = members[0].get("associationId") if members else None

    reg_ref = tournament_ref.collection("registrations").document(f"{payload.categoryCode}_{entry_id}")
    roster_ref = tournament_ref.collection("division_rosters").document(payload.ageCode)
    counts_ref = tournament_ref.collection("meta").document("categoryCounts")
    # Denormalized club roll-up, kept in the SAME transaction as the
    # registration write so it never drifts out of sync.
    clubs_ref = tournament_ref.collection("meta").document("registeredClubs")

    transaction = db.transaction()

    @firestore.transactional
    def _register(tx):
        existing = reg_ref.get(transaction=tx)
        if existing.exists and existing.to_dict().get("status", "active") == "active":
            raise HTTPException(status_code=409, detail="This entry is already registered in this category.")

        tx.set(reg_ref, {
            "tournamentId": tournament_id,
            "entryTypeCode": payload.entryTypeCode,
            "ageCode": payload.ageCode,
            "beltClassCode": payload.beltClassCode,
            "paraClassCode": payload.paraClassCode,
            "genderCode": payload.genderCode,
            "categoryCode": payload.categoryCode,
            "categoryLabel": payload.categoryLabel,
            "athleteIds": payload.athleteIds,
            "clubId": club_id,
            "clubName": club_name,
            "associationId": association_id,
            "status": "active",
            "registeredAt": firestore.SERVER_TIMESTAMP,
        })

        tx.set(roster_ref, {
            "athletes": {payload.categoryCode: {entry_id: {"members": members}}}
        }, merge=True)

        tx.set(counts_ref, {payload.categoryCode: firestore.Increment(1)}, merge=True)

        if club_id:
            tx.set(clubs_ref, {
                club_id: {"clubName": club_name, "count": firestore.Increment(1)}
            }, merge=True)

    try:
        _register(transaction)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Registration failed: {exc}")


def _check_registration_window(tournament_id: str, action: str = "register") -> None:
    """
    Enforces isRegistrationOpen + registrationDeadline before a club-facing
    registration is created.

    Called from the club-facing register_entry_endpoint AND
    move_registration_endpoint (editing an entry after the deadline is not
    allowed either). NOT called from remove_registration_endpoint — clubs
    may still withdraw entries after the deadline — and not from the
    admin-* endpoints — staff need to be able to push past
    a deadline (e.g. accepting a late entry by hand).

    registrationDeadline is stored as a plain ISO string inside
    tournaments/{id}.settings (not a Firestore Timestamp), so it's parsed
    defensively here.
    """
    tournament_doc = db.collection("tournaments").document(tournament_id).get()
    if not tournament_doc.exists:
        raise HTTPException(status_code=404, detail="Tournament not found.")

    data = tournament_doc.to_dict()
    if not data.get("isRegistrationOpen"):
        raise HTTPException(
            status_code=403,
            detail="Registration is not open for this tournament." if action == "register"
            else "Registration is closed for this tournament — entries can no longer be changed, only removed.",
        )

    deadline_raw = (data.get("settings") or {}).get("registrationDeadline")
    if not deadline_raw:
        return

    deadline = None
    try:
        if hasattr(deadline_raw, "tzinfo"):  # already a Firestore Timestamp / datetime
            deadline = deadline_raw
        else:
            deadline = datetime.fromisoformat(str(deadline_raw).replace("Z", "+00:00"))
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        deadline = None  # unparseable — fail open rather than blocking every registration on bad data

    if deadline and datetime.now(timezone.utc) > deadline:
        raise HTTPException(
            status_code=403,
            detail=(
                f"The registration deadline for this tournament ({deadline.strftime('%d %b %Y, %H:%M')} UTC) has passed."
                + ("" if action == "register" else " Entries can no longer be changed, only removed.")
            ),
        )


@router.post("/tournaments/{tournament_id}/registrations", status_code=status.HTTP_201_CREATED)
def register_entry_endpoint(
    tournament_id: str,
    payload: RegisterEntryRequest,
    user: Optional[dict] = Depends(get_current_user),
):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    _check_registration_window(tournament_id)
    _execute_registration_create(tournament_id, payload, requesting_club_id=admin_club_id, enforce_club_match=True)
    return {"message": "Entry registered", "categoryCode": payload.categoryCode}


@router.post("/tournaments/{tournament_id}/registrations/admin-add", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_operator("registrations:manage"))])
def admin_register_entry_endpoint(tournament_id: str, payload: RegisterEntryRequest):
    _execute_registration_create(tournament_id, payload, requesting_club_id=None, enforce_club_match=False)
    return {"message": "Entry registered", "categoryCode": payload.categoryCode}


@router.get("/athletes/{athlete_id}")
def get_athlete_endpoint(athlete_id: str, user: Optional[dict] = Depends(get_current_user)):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")
    club_sport = get_club_sport(admin_club_id)

    doc = db.collection("athletes").document(athlete_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Athlete not found.")

    data = doc.to_dict()
    sport_data = (data.get("sports") or {}).get(club_sport, {})
    if sport_data.get("clubId") != admin_club_id:
        raise HTTPException(status_code=403, detail="You can only view athletes from your own club.")

    birthday = data.get("birthday")

    # firstNameDisplay/lastNameDisplay preserve original casing/diacritics
    # for editing; "firstName"/"lastName" themselves stay lowercased +
    # diacritic-stripped for the prefix-range search queries.
    return {
        "id": athlete_id,
        "displayName": data.get("displayName") or f"{data.get('firstName','')} {data.get('lastName','')}".strip(),
        "firstName": data.get("firstNameDisplay") or data.get("firstName", ""),
        "lastName": data.get("lastNameDisplay") or data.get("lastName", ""),
        "gender": data.get("gender"),
        "birthday": birthday.strftime("%Y-%m-%d") if hasattr(birthday, "strftime") else None,
        "birthYear": _birth_year(data),
        "country": data.get("country"),
        "sport": club_sport,
        "club": sport_data.get("clubName", ""),
        "clubId": sport_data.get("clubId"),
        "associationId": sport_data.get("associationId"),
        "rank": sport_data.get("rank"),
        "isPara": sport_data.get("isPara", False),
        "paraCategory": sport_data.get("paraCategory"),
    }


@router.put("/athletes/{athlete_id}")
async def update_athlete_endpoint(
    athlete_id: str,
    payload: UpdateAthleteRequest,
    user: Optional[dict] = Depends(get_current_user),
):
    """
    Edit counterpart to create_athlete_endpoint. Reuses the same club-scoped
    ADMIN check and the same firstName/lastName normalization + display-name
    handling, but resolves the athlete's *existing* sport entry (via the
    admin's own club sport) rather than accepting a sport from the client.
    """
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    club_sport = get_club_sport(admin_club_id)
    if not club_sport:
        raise HTTPException(status_code=500, detail="Club has no sport configured.")

    athlete_ref = db.collection("athletes").document(athlete_id)
    doc = athlete_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Athlete not found.")

    data = doc.to_dict()
    sport_data = (data.get("sports") or {}).get(club_sport, {})
    if sport_data.get("clubId") != admin_club_id:
        raise HTTPException(status_code=403, detail="You can only edit athletes from your own club.")

    try:
        birth_dt = datetime.strptime(payload.birthday, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid birthday format. Expected YYYY-MM-DD.")

    if payload.isPara and payload.paraCategory not in PARA_CATEGORIES:
        raise HTTPException(status_code=400, detail="A valid para category is required when isPara is set.")

    updated_sport_entry = dict(sport_data)
    updated_sport_entry["rank"] = payload.rank
    updated_sport_entry["isPara"] = payload.isPara
    if payload.isPara and payload.paraCategory:
        updated_sport_entry["paraCategory"] = payload.paraCategory
    else:
        updated_sport_entry.pop("paraCategory", None)

    association_id = (payload.associationId or "").strip()
    if association_id:
        updated_sport_entry["associationId"] = association_id
    else:
        updated_sport_entry.pop("associationId", None)

    athlete_ref.update({
        "firstName": normalize_name(payload.firstName),
        "lastName": normalize_name(payload.lastName),
        "firstNameDisplay": payload.firstName.strip(),
        "lastNameDisplay": payload.lastName.strip(),
        "displayName": f"{payload.firstName} {payload.lastName}",
        "gender": payload.gender.lower(),
        "birthday": birth_dt,
        "country": payload.country.upper(),
        f"sports.{club_sport}": updated_sport_entry,
    })

    return {"id": athlete_id, "message": "Athlete updated successfully"}


class MoveRegistrationRequest(BaseModel):
    athleteIds: List[str]
    oldCategoryCode: str
    oldAgeCode: str
    newEntryTypeCode: str
    newAgeCode: str
    newBeltClassCode: Optional[str] = None
    newParaClassCode: Optional[str] = None
    newGenderCode: str
    newCategoryCode: str
    newCategoryLabel: str


def _execute_registration_move(
    tournament_id: str,
    payload: MoveRegistrationRequest,
    requesting_club_id: Optional[str],
    enforce_ownership: bool,
) -> None:
    if not payload.athleteIds:
        raise HTTPException(status_code=400, detail="At least one athlete is required.")

    if payload.oldCategoryCode == payload.newCategoryCode:
        raise HTTPException(status_code=400, detail="New category is the same as the current one.")

    tournament_ref = db.collection("tournaments").document(tournament_id)
    tournament_doc = tournament_ref.get()
    sport = tournament_doc.to_dict().get("sport") if tournament_doc.exists else None

    entry_id = "-".join(sorted(payload.athleteIds))
    old_reg_ref = tournament_ref.collection("registrations").document(f"{payload.oldCategoryCode}_{entry_id}")
    new_reg_ref = tournament_ref.collection("registrations").document(f"{payload.newCategoryCode}_{entry_id}")
    old_roster_ref = tournament_ref.collection("division_rosters").document(payload.oldAgeCode)
    new_roster_ref = tournament_ref.collection("division_rosters").document(payload.newAgeCode)
    counts_ref = tournament_ref.collection("meta").document("categoryCounts")

    transaction = db.transaction()

    @firestore.transactional
    def _move(tx):
        old_reg_snap = old_reg_ref.get(transaction=tx)
        if not old_reg_snap.exists or old_reg_snap.to_dict().get("status", "active") != "active":
            raise HTTPException(status_code=404, detail="Existing registration not found.")
        old_data = old_reg_snap.to_dict()

        if enforce_ownership and old_data.get("clubId") != requesting_club_id:
            raise HTTPException(status_code=403, detail="You can only edit registrations from your own club.")

        new_reg_snap = new_reg_ref.get(transaction=tx)
        if new_reg_snap.exists and new_reg_snap.to_dict().get("status", "active") == "active":
            raise HTTPException(status_code=409, detail="An entry is already registered in the target category.")

        members = []
        athlete_docs: List[Tuple[str, dict]] = []
        for athlete_id in payload.athleteIds:
            athlete_doc = db.collection("athletes").document(athlete_id).get()
            if not athlete_doc.exists:
                raise HTTPException(status_code=404, detail=f"Athlete {athlete_id} not found.")
            athlete = athlete_doc.to_dict()
            members.append(_build_roster_member(athlete_id, athlete, sport))
            athlete_docs.append((athlete_id, athlete))

        # Para rules bind club edits only; staff (admin-move) are
        # unrestricted (see _execute_registration_create).
        if enforce_ownership:
            _validate_para_eligibility(
                tournament_id, payload.newEntryTypeCode, payload.newParaClassCode,
                payload.newCategoryCode, athlete_docs, sport,
            )

        tx.set(old_reg_ref, {"status": "moved", "movedTo": new_reg_ref.id}, merge=True)

        # clubName / associationId carry straight over from the existing
        # registration, falling back to the rebuilt members list for older
        # registration docs that predate these fields.
        club_name = old_data.get("clubName") or (members[0].get("club") if members else None)
        association_id = old_data.get("associationId") or (members[0].get("associationId") if members else None)

        tx.set(new_reg_ref, {
            "tournamentId": tournament_id,
            "entryTypeCode": payload.newEntryTypeCode,
            "ageCode": payload.newAgeCode,
            "beltClassCode": payload.newBeltClassCode,
            "paraClassCode": payload.newParaClassCode,
            "genderCode": payload.newGenderCode,
            "categoryCode": payload.newCategoryCode,
            "categoryLabel": payload.newCategoryLabel,
            "athleteIds": payload.athleteIds,
            "clubId": old_data.get("clubId"),
            "clubName": club_name,
            "associationId": association_id,
            "status": "active",
            "registeredAt": firestore.SERVER_TIMESTAMP,
            "movedFrom": old_reg_ref.id,
        })

        tx.update(old_roster_ref, {f"athletes.{payload.oldCategoryCode}.{entry_id}": firestore.DELETE_FIELD})

        tx.set(new_roster_ref, {
            "athletes": {payload.newCategoryCode: {entry_id: {"members": members}}}
        }, merge=True)

        tx.set(counts_ref, {
            payload.oldCategoryCode: firestore.Increment(-1),
            payload.newCategoryCode: firestore.Increment(1),
        }, merge=True)

        # NOTE: no registeredClubs write here on purpose — moving a
        # registration between categories never changes which club owns
        # the entry.

    try:
        _move(transaction)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Move failed: {exc}")


@router.put("/tournaments/{tournament_id}/registrations/move")
def move_registration_endpoint(
    tournament_id: str,
    payload: MoveRegistrationRequest,
    user: Optional[dict] = Depends(get_current_user),
):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    _check_registration_window(tournament_id, action="update")
    _execute_registration_move(tournament_id, payload, requesting_club_id=admin_club_id, enforce_ownership=True)
    return {"message": "Registration updated", "categoryCode": payload.newCategoryCode}


@router.put("/tournaments/{tournament_id}/registrations/admin-move",
            dependencies=[Depends(require_operator("registrations:manage"))])
def admin_move_registration_endpoint(tournament_id: str, payload: MoveRegistrationRequest):
    _execute_registration_move(tournament_id, payload, requesting_club_id=None, enforce_ownership=False)
    return {"message": "Registration updated", "categoryCode": payload.newCategoryCode}


def _execute_registration_remove(
    tournament_id: str,
    category_code: str,
    entry_id: str,
    age_code: str,
    requesting_club_id: Optional[str],
    enforce_ownership: bool,
) -> None:
    tournament_ref = db.collection("tournaments").document(tournament_id)
    reg_ref = tournament_ref.collection("registrations").document(f"{category_code}_{entry_id}")
    roster_ref = tournament_ref.collection("division_rosters").document(age_code)
    counts_ref = tournament_ref.collection("meta").document("categoryCounts")
    clubs_ref = tournament_ref.collection("meta").document("registeredClubs")  # keep club roll-up in sync

    transaction = db.transaction()

    @firestore.transactional
    def _remove(tx):
        reg_snap = reg_ref.get(transaction=tx)
        if not reg_snap.exists or reg_snap.to_dict().get("status", "active") != "active":
            raise HTTPException(status_code=404, detail="Registration not found.")

        reg_data = reg_snap.to_dict()
        if enforce_ownership and reg_data.get("clubId") != requesting_club_id:
            raise HTTPException(status_code=403, detail="You can only remove registrations for your own club.")

        tx.set(reg_ref, {"status": "withdrawn"}, merge=True)
        tx.update(roster_ref, {f"athletes.{category_code}.{entry_id}": firestore.DELETE_FIELD})
        tx.set(counts_ref, {category_code: firestore.Increment(-1)}, merge=True)

        club_id = reg_data.get("clubId")
        if club_id:
            tx.set(clubs_ref, {club_id: {"count": firestore.Increment(-1)}}, merge=True)

    try:
        _remove(transaction)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Remove failed: {exc}")


def _check_tournament_not_started(tournament_id: str) -> None:
    """
    Clubs can withdraw entries after the registration deadline, but not once
    the tournament itself has started (tournaments/{id}.dateTime). Staff
    admin-remove is not affected.
    """
    tournament_doc = db.collection("tournaments").document(tournament_id).get()
    if not tournament_doc.exists:
        raise HTTPException(status_code=404, detail="Tournament not found.")

    start_raw = (tournament_doc.to_dict() or {}).get("dateTime")
    if not start_raw:
        return

    start = None
    try:
        if hasattr(start_raw, "tzinfo"):  # Firestore Timestamp / datetime
            start = start_raw
        else:
            start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        start = None

    if start and datetime.now(timezone.utc) >= start:
        raise HTTPException(
            status_code=403,
            detail="The tournament has already started — registrations can no longer be removed.",
        )


@router.delete("/tournaments/{tournament_id}/registrations/{category_code}/{entry_id}")
def remove_registration_endpoint(
    tournament_id: str,
    category_code: str,
    entry_id: str,
    age_code: str = Query(..., description="Age division the roster entry lives under"),
    user: Optional[dict] = Depends(get_current_user),
):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    _check_tournament_not_started(tournament_id)
    _execute_registration_remove(
        tournament_id, category_code, entry_id, age_code,
        requesting_club_id=admin_club_id, enforce_ownership=True,
    )
    return {"message": "Registration removed"}


@router.delete("/tournaments/{tournament_id}/registrations/admin-remove/{category_code}/{entry_id}",
               dependencies=[Depends(require_operator("registrations:manage"))])
def admin_remove_registration_endpoint(
    tournament_id: str,
    category_code: str,
    entry_id: str,
    age_code: str = Query(..., description="Age division the roster entry lives under"),
):
    """
    Staff-only unguarded remove — the DELETE counterpart to
    admin_register_entry_endpoint / admin_move_registration_endpoint.
    Backs category_manager.html's trash-can button.

    TODO: same as the other admin-* endpoints in this file — gate behind
    real staff auth once it exists.
    """
    _execute_registration_remove(
        tournament_id, category_code, entry_id, age_code,
        requesting_club_id=None, enforce_ownership=False,
    )
    return {"message": "Registration removed"}


@router.get("/tournaments/{tournament_id}/category-counts")
def get_category_counts(tournament_id: str):
    doc = db.collection("tournaments").document(tournament_id).collection("meta").document("categoryCounts").get()
    counts = doc.to_dict() if doc.exists else {}
    total = sum(v for v in counts.values() if isinstance(v, (int, float)))
    return {"tournamentId": tournament_id, "categoryCounts": counts, "totalRegistered": total}


@router.get("/tournaments/{tournament_id}/registered-clubs")
def get_registered_clubs(tournament_id: str):
    """
    Admin-panel-facing read of the denormalized club roll-up: every club
    with at least one active registration in this tournament, and how
    many.
    """
    doc = db.collection("tournaments").document(tournament_id).collection("meta").document("registeredClubs").get()
    data = doc.to_dict() if doc.exists else {}
    clubs = [
        {"clubId": cid, "clubName": info.get("clubName", ""), "count": info.get("count", 0)}
        for cid, info in data.items()
        if info.get("count", 0) > 0
    ]
    clubs.sort(key=lambda c: c["clubName"].lower())
    return {"tournamentId": tournament_id, "clubs": clubs}


# ── POOMSAE DRAW ─────────────────────────────────────────────────────────
# Which poomsae each category performs in round 1, the semi-final and the
# final (two). Settings (named poomsae pools + which pool each age × rank
# group uses) and the draw itself live in ONE doc:
#   tournaments/{id}/meta/poomsaeDraw
#     pools:       [{id, name, poomsae: [key, ...]}]
#     assignments: {"<ageCode>|<beltClassCode>": poolId}
#     excludedRows: {"<entryType>|<ageCode>|<beltClassCode>": true/false}
#     excludedGroups: {"<ageCode>|<beltClassCode>": true/false}  (whole group skipped / drawn;
#                    only where it differs from the page default — classes C/D skipped)
#     draw:        {rows: [{key, label, poolId, round1, semifinal, final: [a, b]}],
#                   generatedAt}
# The random draw happens HERE, not in the browser (secrets.SystemRandom),
# so the result can't be nudged from a devtools console. Every row gets
# four DIFFERENT poomsae — nothing repeats across round 1, semi-final and
# the two finals.
POOMSAE_KEYS = [
    "taeguk_1", "taeguk_2", "taeguk_3", "taeguk_4",
    "taeguk_5", "taeguk_6", "taeguk_7", "taeguk_8",
    "koryo", "keumgang", "taebaek", "pyongwon",
    "sipjin", "jitae", "cheonkwon", "hansu",
]
POOMSAE_NAMES = {
    "taeguk_1": "Taeguk 1. Jang", "taeguk_2": "Taeguk 2. Jang", "taeguk_3": "Taeguk 3. Jang",
    "taeguk_4": "Taeguk 4. Jang", "taeguk_5": "Taeguk 5. Jang", "taeguk_6": "Taeguk 6. Jang",
    "taeguk_7": "Taeguk 7. Jang", "taeguk_8": "Taeguk 8. Jang",
    "koryo": "Koryo", "keumgang": "Keumgang", "taebaek": "Taebaek", "pyongwon": "Pyongwon",
    "sipjin": "Sipjin", "jitae": "Jitae", "cheonkwon": "Cheonkwon", "hansu": "Hansu",
}
POOMSAE_DRAW_SLOTS = 4  # round 1 + semi-final + 2 in the final


class PoomsaePool(BaseModel):
    id: str
    name: str
    poomsae: List[str]


class PoomsaeDrawConfig(BaseModel):
    pools: List[PoomsaePool]
    assignments: Dict[str, str] = {}
    # rowKey -> True (skip) / False (draw), only where the operator changed
    # the page's default (freestyle and para are skipped by default).
    excludedRows: Dict[str, bool] = {}
    # groupKey -> True (skip) / False (draw) for a whole age × rank group,
    # only where it differs from the page default (classes C/D skipped).
    excludedGroups: Dict[str, bool] = {}


class PoomsaeDrawRowRequest(BaseModel):
    key: str                 # "<entryTypeCode>|<ageCode>|<beltClassCode>"
    label: str               # e.g. "Individual Poomsae Cadets Class B"
    poolId: Optional[str] = None
    poomsae: List[str]       # the pool this row draws from


class PoomsaeDrawGenerateRequest(BaseModel):
    rows: List[PoomsaeDrawRowRequest]
    # False = redraw only these rows and keep every other row of the saved draw.
    replaceAll: bool = True


def _poomsae_draw_ref(tournament_id: str):
    return db.collection("tournaments").document(tournament_id).collection("meta").document("poomsaeDraw")


def _clean_poomsae_list(keys: List[str]) -> List[str]:
    """Known keys only, no duplicates, in canonical order."""
    wanted = set(keys or [])
    return [k for k in POOMSAE_KEYS if k in wanted]


@router.get("/tournaments/{tournament_id}/poomsae-draw",
            dependencies=[Depends(require_operator("brackets:manage"))])
def get_poomsae_draw(tournament_id: str):
    doc = _poomsae_draw_ref(tournament_id).get()
    data = doc.to_dict() if doc.exists else {}
    return {
        "tournamentId": tournament_id,
        "poomsaeKeys": POOMSAE_KEYS,
        "pools": data.get("pools"),              # None → the page applies its defaults
        "assignments": data.get("assignments") or {},
        "excludedRows": data.get("excludedRows") or {},
        "excludedGroups": data.get("excludedGroups") or {},
        "draw": data.get("draw"),
    }


@router.put("/tournaments/{tournament_id}/poomsae-draw/config",
            dependencies=[Depends(require_operator("brackets:manage"))])
def save_poomsae_draw_config(tournament_id: str, payload: PoomsaeDrawConfig):
    pool_ids = [p.id for p in payload.pools]
    if len(pool_ids) != len(set(pool_ids)):
        raise HTTPException(status_code=400, detail="Two pools share the same id.")
    pools = [{"id": p.id, "name": p.name.strip() or p.id, "poomsae": _clean_poomsae_list(p.poomsae)} for p in payload.pools]
    assignments = {k: v for k, v in (payload.assignments or {}).items() if v in pool_ids}
    excluded_rows = dict(payload.excludedRows or {})
    excluded_groups = {k: bool(v) for k, v in (payload.excludedGroups or {}).items()}
    # merge=<field list> replaces these maps WHOLE (plain merge=True would
    # deep-merge them, so an unticked exclusion could never be removed)
    # while leaving the saved draw untouched.
    _poomsae_draw_ref(tournament_id).set({
        "pools": pools,
        "assignments": assignments,
        "excludedRows": excluded_rows,
        "excludedGroups": excluded_groups,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }, merge=["pools", "assignments", "excludedRows", "excludedGroups", "updatedAt"])
    return {"ok": True, "pools": pools, "assignments": assignments,
            "excludedRows": excluded_rows, "excludedGroups": excluded_groups}


@router.post("/tournaments/{tournament_id}/poomsae-draw/generate",
             dependencies=[Depends(require_operator("brackets:manage"))])
def generate_poomsae_draw(tournament_id: str, payload: PoomsaeDrawGenerateRequest):
    if not payload.rows:
        raise HTTPException(status_code=400, detail="Nothing to draw.")

    too_small = []
    for row in payload.rows:
        if len(_clean_poomsae_list(row.poomsae)) < POOMSAE_DRAW_SLOTS:
            too_small.append(row.label)
    if too_small:
        raise HTTPException(
            status_code=400,
            detail=f"A draw needs at least {POOMSAE_DRAW_SLOTS} different poomsae in the pool "
                   f"(round 1, semi-final and two in the final). Too few for: {', '.join(too_small[:8])}"
                   + (f" and {len(too_small) - 8} more" if len(too_small) > 8 else ""),
        )

    rng = secrets.SystemRandom()
    drawn = {}
    for row in payload.rows:
        picks = rng.sample(_clean_poomsae_list(row.poomsae), POOMSAE_DRAW_SLOTS)
        drawn[row.key] = {
            "key": row.key,
            "label": row.label,
            "poolId": row.poolId,
            "round1": picks[0],
            "semifinal": picks[1],
            "final": [picks[2], picks[3]],
        }

    ref = _poomsae_draw_ref(tournament_id)
    rows = list(drawn.values())
    if not payload.replaceAll:
        existing = ((ref.get().to_dict() or {}).get("draw") or {}).get("rows") or []
        kept = [r for r in existing if r.get("key") not in drawn]
        # Keep the saved order; redrawn rows stay where they were.
        order = [r.get("key") for r in existing]
        merged = {r["key"]: r for r in kept}
        merged.update(drawn)
        rows = [merged[k] for k in order if k in merged] + [r for k, r in drawn.items() if k not in order]

    draw = {"rows": rows, "generatedAt": datetime.now(timezone.utc).isoformat(), "method": "server-random"}
    ref.set({"draw": draw, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return {"ok": True, "draw": draw}


# ── Drawn poomsae → match docs ─────────────────────────────────────────
# A draw row key is "<entryTypeCode>|<ageCode>|<beltClassCode>"; a category
# code starts with those same codes joined by "_" (category-schema.js:
# {entryType}_{age}[_{belt}][_{para}]_{gender}…). The longest matching
# prefix wins, so "seniors" never steals "seniors_under_30".
# Round → drawn slot: F → the two final poomsae, SF → semi-final, anything
# earlier (PR, QF, R16, RR…) → round 1.
def _draw_rows_of(tournament_id: str) -> List[Dict]:
    doc = _poomsae_draw_ref(tournament_id).get()
    data = doc.to_dict() if doc.exists else {}
    return ((data or {}).get("draw") or {}).get("rows") or []


def _draw_row_for_category(category_code: Optional[str], rows: List[Dict]) -> Optional[Dict]:
    code = str(category_code or "")
    best, best_len = None, -1
    for row in rows:
        parts = [p for p in str(row.get("key") or "").split("|") if p]
        if not parts:
            continue
        prefix = "_".join(parts) + "_"
        if code.startswith(prefix) and len(prefix) > best_len:
            best, best_len = row, len(prefix)
    return best


def _drawn_poomsae_keys(category_code: Optional[str], round_phase: Optional[str], rows: List[Dict]) -> List[str]:
    row = _draw_row_for_category(category_code, rows)
    if not row:
        return []
    if round_phase == "F":
        keys = list(row.get("final") or [])
    elif round_phase == "SF":
        keys = [row.get("semifinal")]
    else:
        keys = [row.get("round1")]
    return [k for k in keys if k in POOMSAE_NAMES]


def _poomsae_field(keys: List[str]) -> List[Dict]:
    return [{"key": k, "name": POOMSAE_NAMES[k]} for k in keys]


@router.post("/tournaments/{tournament_id}/poomsae-draw/apply-to-matches",
             dependencies=[Depends(require_operator("brackets:manage"))])
def apply_poomsae_draw_to_matches(
    tournament_id: str,
    sport: str = Query(...),
    discipline: str = Query(...),
):
    """
    Writes the current draw onto every match already pushed for this
    tournament — for a draw made (or redone) after the brackets were
    pushed. Matches whose category isn't drawn lose any old poomsae.
    """
    rows = _draw_rows_of(tournament_id)
    if not rows:
        raise HTTPException(status_code=400, detail="Nothing drawn yet.")
    matches_query = (
        db.collection("sports").document(sport.lower())
        .collection("disciplines").document(discipline.lower())
        .collection("matches")
        .where("tournamentId", "==", tournament_id)
    )
    updated = cleared = 0
    batch, pending = db.batch(), 0
    for doc in matches_query.stream():
        data = doc.to_dict() or {}
        keys = _drawn_poomsae_keys(data.get("categoryCode"), data.get("roundPhase"), rows)
        if keys:
            batch.update(doc.reference, {"poomsae": _poomsae_field(keys)})
            updated += 1
        elif data.get("poomsae"):
            batch.update(doc.reference, {"poomsae": firestore.DELETE_FIELD})
            cleared += 1
        else:
            continue
        pending += 1
        if pending >= 400:
            batch.commit()
            batch, pending = db.batch(), 0
    if pending:
        batch.commit()
    return {"ok": True, "updated": updated, "cleared": cleared}


@router.delete("/tournaments/{tournament_id}/poomsae-draw/draw",
               dependencies=[Depends(require_operator("brackets:manage"))])
def clear_poomsae_draw(tournament_id: str):
    _poomsae_draw_ref(tournament_id).set({"draw": None, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    return {"ok": True}


@router.get("/tournaments/{tournament_id}/division-rosters/{age_code}")
def get_division_roster(tournament_id: str, age_code: str):
    doc = (
        db.collection("tournaments").document(tournament_id)
        .collection("division_rosters").document(age_code).get()
    )
    athletes = doc.to_dict().get("athletes", {}) if doc.exists else {}
    return {"tournamentId": tournament_id, "ageCode": age_code, "athletes": athletes}


@router.get("/sports/{sport}/disciplines/{discipline}/pss-hit-level-sets")
def list_pss_hit_level_sets_endpoint(sport: str, discipline: str):
    docs = (
        db.collection("sports").document(sport)
        .collection("disciplines").document(discipline)
        .collection("pssHitLevelSets").stream()
    )
    return {"sport": sport, "discipline": discipline, "sets": [{"id": d.id, **d.to_dict()} for d in docs]}


class BracketCommitBracket(BaseModel):
    categoryCode: str
    categoryLabel: str
    discipline: str
    format: str
    system: str
    orderingStrategy: str
    # Optional — only single_elimination has a real seed-placement
    # strategy. cut_off and round_robin send null.
    placementStrategy: Optional[str] = None
    entries: List[Dict]
    pssHitLevelSetId: Optional[str] = None


class BracketCommitMatch(BaseModel):
    matchId: str
    bracketCategoryCode: str
    round: int
    matchNumber: int
    displayNumber: Optional[float] = None
    blue: Dict
    # Optional — a poomsae cut-off match is a solo, judged performance
    # with no opponent at all.
    red: Optional[Dict] = None
    status: str
    winnerEntryId: Optional[str] = None
    courtId: Optional[str] = None
    queuePosition: Optional[float] = None
    pssSize: Optional[int] = None
    hitLevel: Optional[int] = None
    pssHitLevelSetId: Optional[str] = None
    roundPhase: Optional[str] = None
    roundTime: Optional[str] = None
    breakTime: Optional[str] = None
    isRanked: bool = True  # official/ranked bout vs. friendly/exhibition — see insert_match_endpoint for the ad hoc counterpart
    # Equipment facts the bracket_builder.html scheduler already resolved
    # at generation time.
    resolvedVestGen: Optional[str] = None          # "gen2" | "gen3"
    requiresPlexiHelmet: bool = False               # competition-rule fact for this match's category
    scheduledWithRelaxedConstraints: bool = False    # true if placed via the generator's overflow path
    # POOMSAE only: the poomsae drawn for this match's category and round
    # (Poomsae Draw page) — one key for round 1 / semi-final, two for the
    # final. Stored on the match doc as [{key, name}] in performance order.
    poomsae: Optional[List[str]] = None


# Match fields only some disciplines use (kyorugi). commit_brackets_endpoint
# writes them only when the request includes them.
DISCIPLINE_ONLY_MATCH_FIELDS = (
    "pssSize", "hitLevel", "pssHitLevelSetId", "roundTime", "breakTime",
    "resolvedVestGen", "requiresPlexiHelmet", "scheduledWithRelaxedConstraints",
)


class BracketCommitRequest(BaseModel):
    sport: str
    discipline: str
    brackets: List[BracketCommitBracket]
    matches: List[BracketCommitMatch]
    # Session-local equipment configuration from bracket_builder.html,
    # written to tournaments/{id}/meta/equipment in the SAME commit.
    equipment: Optional[Dict] = None


@router.post("/tournaments/{tournament_id}/brackets/commit", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_operator("brackets:manage"))])
def commit_brackets_endpoint(tournament_id: str, payload: BracketCommitRequest):
    batch = db.batch()
    tournament_ref = db.collection("tournaments").document(tournament_id)
    tournament_doc = tournament_ref.get()
    tournament_name = tournament_doc.to_dict().get("title") if tournament_doc.exists else None

    for b in payload.brackets:
        bracket_ref = tournament_ref.collection("brackets").document()
        bracket_data = b.dict()
        if bracket_data.get("pssHitLevelSetId") is None:
            bracket_data.pop("pssHitLevelSetId", None)  # kyorugi only
        batch.set(bracket_ref, {
            **bracket_data,
            "tournamentId": tournament_id,
            "status": "generated",
            "createdAt": firestore.SERVER_TIMESTAMP,
        })

    matches_ref = (
        db.collection("sports").document(payload.sport)
        .collection("disciplines").document(payload.discipline)
        .collection("matches")
    )


    # Poomsae draw (Poomsae Draw page): the server attaches the drawn
    # poomsae itself, so it never depends on the browser having sent them.
    draw_rows = _draw_rows_of(tournament_id) if "poomsae" in (payload.discipline or "").lower() else []

    real_id_by_local_id = {}
    for m in payload.matches:
        match_number = m.displayNumber if m.displayNumber is not None else m.matchId
        real_id_by_local_id[m.matchId] = f"{tournament_id}_{str(int(match_number)) if isinstance(match_number, float) and match_number.is_integer() else str(match_number)}"

    for m in payload.matches:
        doc_id = real_id_by_local_id[m.matchId]
        match_ref = matches_ref.document(doc_id)

        def _resolve_corner(corner: Optional[Dict]) -> Optional[Dict]:
            if corner is None:
                return None
            corner = dict(corner)
            source = corner.get("source")
            if source and source.get("matchId") in real_id_by_local_id:
                corner["source"] = {**source, "matchId": real_id_by_local_id[source["matchId"]]}
            return corner

        match_doc = {
            "tournamentId": tournament_id,
            "tournamentName": tournament_name,
            "categoryCode": m.bracketCategoryCode,
            "bracketRound": m.round,
            "bracketMatchNumber": m.matchNumber,
            "displayNumber": m.displayNumber,
            "roundPhase": m.roundPhase,
            "blue": _resolve_corner(m.blue),
            "red": _resolve_corner(m.red),
            "status": m.status,
            "winnerEntryId": m.winnerEntryId,
            "courtId": m.courtId,
            "queuePosition": m.queuePosition,
            "isRanked": m.isRanked,
        }
        # Discipline-only fields (kyorugi vests / helmets / round timing /
        # scheduling flags) are written only when the builder actually sent
        # them — the poomsae builder doesn't, so its matches don't get
        # model defaults like requiresPlexiHelmet=false or roundTime.
        sent = getattr(m, "model_fields_set", None) or getattr(m, "__fields_set__", set())
        for field in DISCIPLINE_ONLY_MATCH_FIELDS:
            if field in sent:
                match_doc[field] = getattr(m, field)
        # Builder-sent keys win (it knows single-elimination round depth);
        # otherwise the server works them out from the saved draw.
        poomsae_keys = [k for k in (m.poomsae or []) if k in POOMSAE_NAMES] \
            or _drawn_poomsae_keys(m.bracketCategoryCode, m.roundPhase, draw_rows)
        if poomsae_keys:
            match_doc["poomsae"] = _poomsae_field(poomsae_keys)
        # Omit any field that's genuinely None rather than writing it as
        # an explicit null. Booleans like requiresPlexiHelmet=False are kept.
        match_doc = {k: v for k, v in match_doc.items() if v is not None}
        batch.set(match_ref, match_doc, merge=True)

    if payload.equipment is not None:
        equipment_ref = tournament_ref.collection("meta").document("equipment")
        batch.set(equipment_ref, {
            **payload.equipment,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })

    batch.commit()
    return {"message": "Brackets committed", "bracketCount": len(payload.brackets), "matchCount": len(payload.matches)}


@router.delete("/tournaments/{tournament_id}/brackets",
               dependencies=[Depends(require_operator("brackets:manage"))])
def clean_brackets_endpoint(
    tournament_id: str,
    sport: str = Query(..., description="Needed to locate this tournament's matches, which live under sports/{sport}/disciplines/{discipline}/matches, not under the tournament doc itself"),
    discipline: str = Query(...),
):
    """
    Wipes everything bracket_builder.html's "Push to Firebase" creates
    for this tournament: every bracket doc, every match doc, and the
    equipment meta doc.

    Deliberately does NOT touch registrations, division_rosters,
    categoryCounts, or registeredClubs.
    """
    tournament_ref = db.collection("tournaments").document(tournament_id)

    def _delete_in_batches(doc_refs: List) -> int:
        deleted = 0
        for i in range(0, len(doc_refs), 400):
            chunk = doc_refs[i:i + 400]
            batch = db.batch()
            for ref in chunk:
                batch.delete(ref)
            batch.commit()
            deleted += len(chunk)
        return deleted

    bracket_refs = [d.reference for d in tournament_ref.collection("brackets").stream()]
    deleted_brackets = _delete_in_batches(bracket_refs)

    matches_query = (
        db.collection("sports").document(sport)
        .collection("disciplines").document(discipline)
        .collection("matches")
        .where("tournamentId", "==", tournament_id)
    )
    match_refs = [d.reference for d in matches_query.stream()]
    deleted_matches = _delete_in_batches(match_refs)

    tournament_ref.collection("meta").document("equipment").delete()

    return {
        "message": "Brackets, matches, and equipment meta cleared.",
        "deletedBrackets": deleted_brackets,
        "deletedMatches": deleted_matches,
    }


# ═══════════════════════════════════════════════════════════════════════════
# LIVE QUEUE / MATCH ADMIN CONSOLE
# ═══════════════════════════════════════════════════════════════════════════
# Backs dashboard/live_queue.html. The match list + realtime updates are
# read directly by the browser via the Firestore web SDK; FastAPI only
# handles admin writes (reorder, status override, ad hoc insert) plus the
# one-time court summary on load. Reordering uses fractional indexing.
# SECURITY: Firestore rules gate reads of `matches`; lock them down before
# exposing the page.
# INDEX: the court query needs a composite index (tournamentId, courtId,
# queuePosition).


@router.get("/firebase-client-config")
def get_firebase_client_config():
    """
    Public (client-safe) Firebase config for the web SDK the live queue
    page uses for realtime onSnapshot listeners.
    """
    return {
        "apiKey": os.getenv("FIREBASE_WEB_API_KEY", ""),
        "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
        "projectId": os.getenv("FIREBASE_PROJECT_ID", ""),
        "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId": os.getenv("FIREBASE_APP_ID", ""),
    }


@router.get("/tournaments/{tournament_id}/courts")
def get_tournament_courts(tournament_id: str, repo: TournamentPort = Depends(get_tournament_repo)):
    """
    One-time summary used to build the court tab bar: every courtId in
    use for this tournament, how many matches are pending/ready/done on
    it, and which match is up next.
    """
    tournament = repo.getTournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    matches_ref = (
        db.collection("sports").document(tournament.sport)
        .collection("disciplines").document(tournament.discipline)
        .collection("matches")
        .where("tournamentId", "==", tournament_id)
    )

    courts: Dict[str, Dict] = {}
    for doc in matches_ref.stream():
        m = doc.to_dict()
        court_id = m.get("courtId") or "unassigned"
        c = courts.setdefault(court_id, {
            "courtId": court_id, "total": 0, "pending": 0, "ready": 0, "done": 0, "nextMatch": None,
        })
        c["total"] += 1
        status_val = m.get("status")
        is_done = status_val == "done" or m.get("winnerEntryId") is not None
        if is_done:
            c["done"] += 1
        elif status_val == "ready":
            c["ready"] += 1
        else:
            c["pending"] += 1

        if not is_done and status_val == "ready":
            qp = m.get("queuePosition")
            if qp is not None and (c["nextMatch"] is None or qp < c["nextMatch"]["queuePosition"]):
                c["nextMatch"] = {
                    "matchId": doc.id,
                    "queuePosition": qp,
                    "displayNumber": m.get("displayNumber"),
                    "categoryCode": m.get("categoryCode"),
                }

    return {
        "tournamentId": tournament_id,
        "sport": tournament.sport,
        "discipline": tournament.discipline,
        "courts": sorted(courts.values(), key=lambda c: str(c["courtId"])),
    }


def _fractional_midpoint(prev: Optional[float], nxt: Optional[float], fallback: float = 1.0) -> float:
    """
    Standard fractional/LexoRank-style indexing: the new value sits
    exactly between its two neighbours so nothing else has to move.
    """
    if prev is not None and nxt is not None:
        return (prev + nxt) / 2
    if prev is not None:
        return prev + 1
    if nxt is not None:
        return nxt - 1
    return fallback


class PositionUpdateRequest(BaseModel):
    courtId: str
    prevQueuePosition: Optional[float] = None
    nextQueuePosition: Optional[float] = None
    prevDisplayNumber: Optional[float] = None
    nextDisplayNumber: Optional[float] = None


@router.patch("/matches/{sport}/{discipline}/{match_id}/position",
              dependencies=[Depends(require_operator("matches:manage"))])
def reposition_match_endpoint(sport: str, discipline: str, match_id: str, payload: PositionUpdateRequest):
    """
    Drag-and-drop reorder / re-court. Only writes the one document that
    moved.
    """
    match_ref = (
        db.collection("sports").document(sport)
        .collection("disciplines").document(discipline)
        .collection("matches").document(match_id)
    )
    if not match_ref.get().exists:
        raise HTTPException(status_code=404, detail="Match not found")

    new_queue_position = _fractional_midpoint(payload.prevQueuePosition, payload.nextQueuePosition)
    update = {"courtId": payload.courtId, "queuePosition": new_queue_position}
    if payload.prevDisplayNumber is not None or payload.nextDisplayNumber is not None:
        update["displayNumber"] = _fractional_midpoint(
            payload.prevDisplayNumber, payload.nextDisplayNumber, fallback=new_queue_position
        )
    match_ref.set(update, merge=True)
    return {"message": "Match repositioned", "queuePosition": new_queue_position}


VALID_MATCH_STATUSES = {"pending", "ready", "done", "walkover"}


class MatchStatusUpdateRequest(BaseModel):
    status: str  # "pending" | "ready" | "done" | "walkover"
    winnerEntryId: Optional[str] = None


@router.patch("/matches/{sport}/{discipline}/{match_id}/status",
              dependencies=[Depends(require_operator("matches:manage"))])
def update_match_status_endpoint(sport: str, discipline: str, match_id: str, payload: MatchStatusUpdateRequest):
    """
    Manual status override for the admin console.
    """
    if payload.status not in VALID_MATCH_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_MATCH_STATUSES)}")

    match_ref = (
        db.collection("sports").document(sport)
        .collection("disciplines").document(discipline)
        .collection("matches").document(match_id)
    )
    if not match_ref.get().exists:
        raise HTTPException(status_code=404, detail="Match not found")

    update = {"status": payload.status, "assignment": "manual"}
    if payload.winnerEntryId is not None:
        update["winnerEntryId"] = payload.winnerEntryId
    elif payload.status not in ("done", "walkover"):
        # Resetting back to pending/ready clears a stale winner.
        update["winnerEntryId"] = None

    match_ref.set(update, merge=True)
    return {"message": "Status updated", "status": payload.status}


class InsertMatchCorner(BaseModel):
    athleteIds: List[str]
    entryId: Optional[str] = None


class InsertMatchRequest(BaseModel):
    courtId: str
    prevQueuePosition: Optional[float] = None
    nextQueuePosition: Optional[float] = None
    prevDisplayNumber: Optional[float] = None
    nextDisplayNumber: Optional[float] = None
    categoryCode: str
    categoryLabel: str
    blue: InsertMatchCorner
    red: InsertMatchCorner
    isRanked: bool = True
    roundPhase: Optional[str] = "EXH"


@router.post("/tournaments/{tournament_id}/matches/insert", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_operator("matches:manage"))])
def insert_match_endpoint(
    tournament_id: str,
    payload: InsertMatchRequest,
    repo: TournamentPort = Depends(get_tournament_repo),
):
    """
    Creates a brand-new match that slots in between two existing rows in
    the live queue, without renumbering anything else.
    """
    tournament = repo.getTournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    def _resolve_corner(corner: InsertMatchCorner) -> Dict:
        if not corner.athleteIds:
            raise HTTPException(status_code=400, detail="Each corner needs at least one athlete.")
        members = []
        for athlete_id in corner.athleteIds:
            doc = db.collection("athletes").document(athlete_id).get()
            if not doc.exists:
                raise HTTPException(status_code=404, detail=f"Athlete {athlete_id} not found.")
            members.append(doc.to_dict())
        name = " / ".join(
            m.get("displayName") or f"{m.get('firstName','')} {m.get('lastName','')}".strip() for m in members
        )
        first_sport_data = ((members[0].get("sports") or {}).get(tournament.sport) or {}) if members else {}
        return {
            "entryId": corner.entryId or "-".join(sorted(corner.athleteIds)),
            "athleteIds": corner.athleteIds,
            "name": name,
            "country": members[0].get("country") if members else None,
            "clubId": first_sport_data.get("clubId"),
            "clubName": first_sport_data.get("clubName"),
        }

    blue = _resolve_corner(payload.blue)
    red = _resolve_corner(payload.red)

    queue_position = _fractional_midpoint(payload.prevQueuePosition, payload.nextQueuePosition)
    display_number = _fractional_midpoint(
        payload.prevDisplayNumber, payload.nextDisplayNumber, fallback=queue_position
    )

    doc_id = f"{tournament_id}_{display_number}"
    match_ref = (
        db.collection("sports").document(tournament.sport)
        .collection("disciplines").document(tournament.discipline)
        .collection("matches").document(doc_id)
    )

    match_ref.set({
        "tournamentId": tournament_id,
        "tournamentName": tournament.title,
        "categoryCode": payload.categoryCode,
        "categoryLabel": payload.categoryLabel,
        "displayNumber": display_number,
        "roundPhase": payload.roundPhase,
        "blue": blue,
        "red": red,
        "status": "pending",
        "winnerEntryId": None,
        "courtId": payload.courtId,
        "queuePosition": queue_position,
        "isRanked": payload.isRanked,
        "source": "tournament_system_manual_insert",
        "assignment": "manual",
        "createdAt": firestore.SERVER_TIMESTAMP,
    })

    return {
        "message": "Match inserted",
        "matchId": doc_id,
        "queuePosition": queue_position,
        "displayNumber": display_number,
    }


@router.get("/tournaments/{tournament_id}/weighin-data",
            dependencies=[Depends(require_operator("weighin:view"))])
def get_weighin_data(tournament_id: str, repo: TournamentPort = Depends(get_tournament_repo)):
    """
    Single source of truth for the client-generated weigh-in sheet and
    backup registration sheet. Fresh read of active registrations,
    grouped by club. Registrations with no clubId are returned separately
    under "unassigned".
    """
    tournament = repo.getTournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    tournament_ref = db.collection("tournaments").document(tournament_id)
    regs = [
        d.to_dict() for d in tournament_ref.collection("registrations").stream()
        if d.to_dict().get("status", "active") == "active"
    ]

    athlete_ids = {aid for r in regs for aid in r.get("athleteIds", [])}
    athlete_refs = [db.collection("athletes").document(aid) for aid in athlete_ids]
    athletes = {snap.id: snap.to_dict() for snap in db.get_all(athlete_refs) if snap.exists}

    clubs_meta_doc = tournament_ref.collection("meta").document("registeredClubs").get()
    club_names = {cid: info.get("clubName", "") for cid, info in (clubs_meta_doc.to_dict() or {}).items()}

    by_club: Dict[str, Dict] = {}
    for r in regs:
        club_id = r.get("clubId")
        bucket_key = club_id or "__unassigned__"
        club = by_club.setdefault(bucket_key, {
            "clubId": club_id,
            "clubName": club_names.get(club_id, "") if club_id else None,
            "entries": [],
        })
        for athlete_id in r.get("athleteIds", []):
            a = athletes.get(athlete_id, {})
            club["entries"].append({
                "athleteId": athlete_id,
                "lastName": (a.get("lastName") or "").title(),
                "firstName": (a.get("firstName") or "").title(),
                "gender": r.get("genderCode"),
                "categoryLabel": r.get("categoryLabel"),
            })

    for club in by_club.values():
        club["entries"].sort(key=lambda e: (e["lastName"], e["firstName"]))

    real_clubs = sorted(
        (c for c in by_club.values() if c["clubId"]),
        key=lambda c: (c["clubName"] or "").lower(),
    )
    unassigned = by_club.get("__unassigned__")

    return {
        "tournamentId": tournament_id,
        "tournamentTitle": tournament.title,
        "clubs": real_clubs,
        "unassigned": unassigned,  # null if every registration has a real club
    }


# ═══════════════════════════════════════════════════════════════════════════
# FINAL PLACEMENTS / RESULTS COMPUTATION
# ═══════════════════════════════════════════════════════════════════════════

class CategoryResultSummary(BaseModel):
    categoryCode: str
    totalRounds: int
    placementsAssigned: int
    incompleteMatches: int
    status: str  # "complete" | "partial" | "skipped"
    detail: Optional[str] = None


@router.post("/tournaments/{tournament_id}/results/compute",
             dependencies=[Depends(require_operator("matches:manage"))])
def compute_tournament_results_endpoint(
    tournament_id: str,
    repo: TournamentPort = Depends(get_tournament_repo),
):
    """
    Walks every category's completed single-elimination bracket and
    derives final placements (1st, 2nd, joint-3rd, joint-5th, ...) from
    bracketRound + winnerEntryId, then writes each entry's placement onto
    its division_rosters entry.

    A match counts as decided when its status is "done", "walkover", or
    "completed" (TkStrike's FirebaseSyncPlugin).

    Loser at bracketRound r is placed at 2 ** (totalRounds - r) + 1; the
    final's winner is 1. A category is only processed once its final is
    decided. Idempotent per category.
    """
    tournament = repo.getTournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    matches_ref = (
        db.collection("sports").document(tournament.sport)
        .collection("disciplines").document(tournament.discipline)
        .collection("matches")
        .where("tournamentId", "==", tournament_id)
    )

    by_category: Dict[str, List[Dict]] = {}
    match_docs_by_category: Dict[str, List] = {}
    for doc in matches_ref.stream():
        m = doc.to_dict()
        code = m.get("categoryCode")
        if not code:
            continue
        by_category.setdefault(code, []).append(m)
        match_docs_by_category.setdefault(code, []).append(doc.reference)

    tournament_ref = db.collection("tournaments").document(tournament_id)
    results: List[CategoryResultSummary] = []

    DECIDED_STATUSES = ("done", "walkover", "completed")

    # ageCode -> {"athletes": {categoryCode: {entryId: {"placement": n}}}}
    roster_updates: Dict[str, Dict] = {}

    def _queue_placement(category_code: str, entry_id: str, placement: int) -> bool:
        reg_doc = tournament_ref.collection("registrations").document(f"{category_code}_{entry_id}").get()
        if not reg_doc.exists:
            return False
        age_code = reg_doc.to_dict().get("ageCode")
        if not age_code:
            return False
        bucket = roster_updates.setdefault(age_code, {"athletes": {}})
        bucket["athletes"].setdefault(category_code, {})[entry_id] = {"placement": placement}
        return True

    for category_code, matches in by_category.items():
        rounds = [m.get("bracketRound") for m in matches if m.get("bracketRound") is not None]
        if not rounds:
            results.append(CategoryResultSummary(
                categoryCode=category_code, totalRounds=0, placementsAssigned=0,
                incompleteMatches=len(matches), status="skipped",
                detail="No bracketRound data on any match — not a generated bracket.",
            ))
            continue
        total_rounds = max(rounds)

        final_matches = [m for m in matches if m.get("bracketRound") == total_rounds]
        final_match = final_matches[0] if final_matches else None
        final_decided = bool(
            final_match and final_match.get("status") in DECIDED_STATUSES and final_match.get("winnerEntryId")
        )
        if not final_decided:
            results.append(CategoryResultSummary(
                categoryCode=category_code, totalRounds=total_rounds, placementsAssigned=0,
                incompleteMatches=len(matches), status="skipped",
                detail="Final has not been decided yet.",
            ))
            continue

        assigned = 0
        incomplete = 0
        for m in matches:
            r = m.get("bracketRound")
            if r is None:
                continue
            decided = m.get("status") in DECIDED_STATUSES and m.get("winnerEntryId")
            if not decided:
                incomplete += 1
                continue

            blue_id = (m.get("blue") or {}).get("entryId")
            red_id = (m.get("red") or {}).get("entryId")
            winner_id = m.get("winnerEntryId")
            if not blue_id or not red_id or winner_id not in (blue_id, red_id):
                incomplete += 1
                continue
            loser_id = red_id if winner_id == blue_id else blue_id

            if _queue_placement(category_code, loser_id, 2 ** (total_rounds - r) + 1):
                assigned += 1
            if r == total_rounds and _queue_placement(category_code, winner_id, 1):
                assigned += 1

        results.append(CategoryResultSummary(
            categoryCode=category_code, totalRounds=total_rounds, placementsAssigned=assigned,
            incompleteMatches=incomplete, status="complete" if incomplete == 0 else "partial",
        ))

    roster_items = list(roster_updates.items())
    for i in range(0, len(roster_items), 400):
        batch = db.batch()
        for age_code, data in roster_items[i:i + 400]:
            batch.set(tournament_ref.collection("division_rosters").document(age_code), data, merge=True)
        batch.commit()

    decided_categories = {r.categoryCode for r in results if r.status in ("complete", "partial")}
    flag_refs = [ref for cat, refs in match_docs_by_category.items() if cat in decided_categories for ref in refs]
    for i in range(0, len(flag_refs), 400):
        batch = db.batch()
        for ref in flag_refs[i:i + 400]:
            batch.set(ref, {"resultsProcessed": True}, merge=True)
        batch.commit()

    return {
        "tournamentId": tournament_id,
        "categoriesProcessed": len([r for r in results if r.status != "skipped"]),
        "categoriesSkipped": len([r for r in results if r.status == "skipped"]),
        "results": [r.dict() for r in results],
    }


@router.get("/tournaments/{tournament_id}", response_model=TournamentResponse)
def tournament_page_endpoint(tournament_id: str, repo=Depends(get_tournament_repo)):
    """Acts as the dedicated view state for a single tournament profile."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return tournament


class CreateCaseRequest(BaseModel):
    name: str

def get_case_repo() -> FirebaseCaseRepository:
    return FirebaseCaseRepository(db)

@router.post("/cases", status_code=status.HTTP_201_CREATED)
def create_case_endpoint(payload: CreateCaseRequest, repo=Depends(get_case_repo)):
    """API endpoint for the Javascript prompt to send data to."""
    use_case = CreateCaseUseCase(repo)
    use_case.execute(name=payload.name)
    return {"message": "Case created successfully"}

@router.put("/tournaments/{tournament_id}", status_code=200,
            dependencies=[Depends(require_operator("tournament:edit"))])
def update_tournament_endpoint(
    tournament_id: str,
    payload: UpdateTournamentRequest,
    repo=Depends(get_tournament_repo),
):
    use_case = UpdateTournamentUseCase(repo)
    try:
        use_case.execute(
            tournament_id=tournament_id,
            title=payload.title,
            location=payload.location,
            courtNum=payload.courtNum,
            dateTime=payload.dateTime,
            sport=payload.sport.lower(),
            discipline=payload.discipline.lower(),
            isExternalPublic=payload.isExternalPublic,
            settings={
                "isStream": payload.isStream,
                "venueName": payload.venueName,
                "numbering": payload.numbering,
                "provider": payload.provider,
                "mode": payload.mode,
                "externalRegistrationUrl": (payload.externalRegistrationUrl or "").strip() or None,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"message": "Tournament updated."}

@router.patch("/tournaments/{tournament_id}/status",
              dependencies=[Depends(require_operator("tournament:archive"))])
def update_tournament_status(
    tournament_id: str,
    payload: StatusUpdate,
    repo: TournamentPort = Depends(get_tournament_repo),
    broadcast_repo=Depends(get_broadcast_repo),
    stream_key_repo=Depends(get_stream_key_repo),
):
    if payload.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {VALID_STATUSES}")

    use_case = SetTournamentStatusUseCase(repo, broadcast_repo, stream_key_repo)
    try:
        use_case.execute(tournament_id, payload.status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    return {"id": tournament_id, "status": payload.status}

@router.delete("/tournaments/{tournament_id}", status_code=200,
               dependencies=[Depends(require_operator("tournament:delete"))])
def delete_tournament_endpoint(
    tournament_id: str,
    repo: TournamentPort = Depends(get_tournament_repo),
    broadcast_repo=Depends(get_broadcast_repo),
    stream_key_repo=Depends(get_stream_key_repo),
):
    use_case = DeleteTournamentUseCase(repo, broadcast_repo, stream_key_repo)
    try:
        use_case.execute(tournament_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"message": "Tournament deleted."}

def normalize_name(value: str) -> str:
    """Lowercase and strip diacritics, e.g. 'Vidinská' -> 'vidinska'."""
    decomposed = unicodedata.normalize("NFD", value)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.lower().strip()


@router.post("/athletes", status_code=status.HTTP_201_CREATED)
async def create_athlete_endpoint(payload: CreateAthleteRequest, user: Optional[dict] = Depends(get_current_user)):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    club_doc = db.collection("clubs").document(admin_club_id).get()
    club_data = club_doc.to_dict() if club_doc.exists else {}
    club_name = club_data.get("name", "")
    club_sport = club_data.get("sport")
    if not club_sport:
        raise HTTPException(status_code=500, detail="Club has no sport configured.")

    try:
        birth_dt = datetime.strptime(payload.birthday, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid birthday format. Expected YYYY-MM-DD.")

    if payload.isPara and payload.paraCategory not in PARA_CATEGORIES:
        raise HTTPException(status_code=400, detail="A valid para category is required when isPara is set.")

    sport_entry = {
        "rank": payload.rank,
        "clubId": admin_club_id,
        "clubName": club_name,
        "isPara": payload.isPara,
    }
    if payload.isPara and payload.paraCategory:
        sport_entry["paraCategory"] = payload.paraCategory

    association_id = (payload.associationId or "").strip()
    if association_id:
        sport_entry["associationId"] = association_id

    athlete_data = {
        "firstName": normalize_name(payload.firstName),
        "lastName": normalize_name(payload.lastName),
        # Preserve original casing/diacritics for display + edit prefill.
        "firstNameDisplay": payload.firstName.strip(),
        "lastNameDisplay": payload.lastName.strip(),
        "displayName": f"{payload.firstName} {payload.lastName}",
        "gender": payload.gender.lower(),
        "birthday": birth_dt,
        "country": payload.country.upper(),
        "sports": {
            club_sport: sport_entry,
        },
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    _, doc_ref = db.collection("athletes").add(athlete_data)
    return {"id": doc_ref.id, "message": "Athlete created successfully"}


# ── SCHEMAS ────────────────────────────────────────────────────────────
class CreateTokenRequest(BaseModel):
    token: Optional[str] = None          # optional custom name; becomes the doc id
    role: str
    clubId: str
    clubName: Optional[str] = ""
    expiresAt: Optional[datetime] = None


# ── ENDPOINTS ──────────────────────────────────────────────────────────
@router.post("/tokens", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_operator("token:create"))])
def create_token_endpoint(payload: CreateTokenRequest):
    token_id = (payload.token or "").strip() or secrets.token_urlsafe(12)

    token_ref = db.collection("permission_tokens").document(token_id)
    if token_ref.get().exists:
        raise HTTPException(status_code=409, detail="A token with this name already exists.")

    token_ref.set({
        "clubId": payload.clubId,
        "clubName": payload.clubName or "",
        "role": payload.role,
        "permissions": [],
        "expiresAt": payload.expiresAt.isoformat() if payload.expiresAt else None,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })

    return {"token": token_id, "message": "Token created successfully"}


@router.get("/tokens/paginated",
            dependencies=[Depends(require_operator("token:view"))])
def list_tokens_paginated(
    limit: int = Query(5, ge=1, le=50),
    offset: int = Query(0, ge=0),
):
    query = (
        db.collection("permission_tokens")
        .order_by("createdAt", direction=firestore.Query.DESCENDING)
        .offset(offset)
        .limit(limit)
    )
    tokens = []
    for doc in query.stream():
        data = doc.to_dict()
        tokens.append({
            "token": doc.id,
            "role": data.get("role"),
            "clubId": data.get("clubId"),
            "clubName": data.get("clubName", ""),
            "expiresAt": data.get("expiresAt"),
        })

    return {
        "tokens": tokens,
        "has_more": len(tokens) == limit,
        "next_offset": offset + len(tokens),
    }