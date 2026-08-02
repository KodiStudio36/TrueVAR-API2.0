from fastapi import APIRouter, Depends, HTTPException, Request, status, Query
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional
from firebase_admin import firestore
import jwt
import os

from adapters.database.firebase_case_repository import FirebaseCaseRepository
from usecases.case_usecase import CreateCaseUseCase
from usecases.tournament_usecase import CreateTournamentUseCase, GetAllTournamentsUseCase, GetTournamentUseCase, UpdateTournamentUseCase
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore

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

class CreateAthleteRequest(BaseModel):
    firstName: str
    lastName: str
    gender: str
    birthday: str  # YYYY-MM-DD from HTML form
    country: str
    sport: str     # "taekwondo" or "boxing"
    rank: int

VALID_STATUSES = {"active", "archived"}

class StatusUpdate(BaseModel):
    status: str


@router.post("/tournaments", status_code=status.HTTP_201_CREATED)
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
        },
    )

    tournament_id = created_tournament.id

    # 2. Upload category JSON definition to tournament_categories/{tournamentId}
    #
    # payload.categories is the full category config document — the same
    # shape as taekwondo_categories.json:
    #     { sportSchemas: { <sport>: { key, label, disciplines: {
    #         <discipline>: { key, label, dimensions: [...] }, ... } } } }
    # "kyorugi" is a DISCIPLINE of the sport "taekwondo", not a sport in
    # its own right — sportSchemas is keyed by sport, and each sport's
    # disciplines can have entirely different dimensions (e.g. poomsae
    # has no weight brackets, but does have an entry_type dimension with
    # individual/pairs/team options, unlike kyorugi which only has
    # individual). Stored as-is, not iterated — see the earlier `dict(cat)`
    # ValueError this replaced for why enumerate() over a dict is wrong.
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
    repo: TournamentPort = Depends(get_tournament_repo),
):
    tournaments = repo.getTournamentsPaginated(status=status, limit=limit, offset=offset)
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
    """
    Returns the full category config document for this tournament — the
    same shape as taekwondo_categories.json:
        { sportSchemas: { <sport>: { key, label, disciplines: {
            <discipline>: { key, label, dimensions: [...] }, ... } } } }
    "kyorugi" is a DISCIPLINE of the sport "taekwondo" — sportSchemas is
    keyed by sport, each sport holds a `disciplines` map, and each
    discipline has its own `dimensions`: an optional 'entry_type'
    (individual/pairs/team — kyorugi only ever has 'individual', poomsae
    has all three), 'age' (range over birthYear, with an optional
    also_eligible_for on each option for cross-division eligibility),
    'gender' (discrete), and an optional 'weight' (bracket thresholds
    keyed by "<ageCode>|<genderCode>" — omitted entirely for disciplines
    with no weight classes). tournament.html picks
    sportSchemas[tournament.sport].disciplines[tournament.discipline]
    client-side and parses that discipline's `dimensions` into the full
    registrable category tree; see create_tournament_endpoint for where
    this doc is written.
    """
    doc = db.collection("tournament_categories").document(tournament_id).get()
    if not doc.exists:
        return {"tournamentId": tournament_id, "categories": {}}

    data = doc.to_dict()
    return {"tournamentId": tournament_id, "categories": data.get("categories", {})}


def _birth_year(athlete_data: dict) -> Optional[int]:
    """
    Athlete birthdate is stored as a Firestore Timestamp on the `birthday`
    field, not a precomputed integer. The Python Firestore client already
    deserializes Timestamp fields into tz-aware `datetime` objects, so no
    parsing is needed — just read `.year` off it. Returns None if the
    field is missing or isn't datetime-like, so callers can filter those
    athletes out rather than crash on them.
    """
    birthday = athlete_data.get("birthday")
    return birthday.year if hasattr(birthday, "year") else None


def _build_roster_member(athlete_id: str, athlete: dict, sport: Optional[str]) -> dict:
    """
    Builds one entry for the LEAN division_rosters doc.

    Deliberately excludes registeredAt — irrelevant to a fast "who am I
    facing" read; it lives on the registrations audit doc instead, where
    it belongs.

    clubId is included (not just club name) because the roster itself
    needs to answer "can the viewing admin edit this entry" without a
    second lookup — that's the permission check tournament.html uses to
    show/hide the Edit button next to each entry.

    rank is sport-scoped and OMITTED entirely (not set to null) for
    sports/athletes with no rank on file — e.g. boxing has no belt-style
    rank concept, so there's nothing meaningful to show, and a stray
    null field would just be noise in every roster read.
    """
    entry = {
        "athleteId": athlete_id,
        "name": athlete.get("displayName") or f"{athlete.get('firstName', '')} {athlete.get('lastName', '')}".strip(),
        "club": athlete.get("clubName", ""),
        "clubId": athlete.get("clubId"),
        "country": athlete.get("country"),
    }
    if sport:
        rank = ((athlete.get("sports") or {}).get(sport) or {}).get("rank")
        if rank is not None:
            entry["rank"] = rank
    return entry


def get_admin_club_id(user: Optional[dict]) -> Optional[str]:
    """
    Returns the single club this user administers, or None. An account can
    hold the ADMIN role in at most one club — enforced when invite tokens
    are consumed in auth_router.consume_invite_token — so `roles` should
    never contain more than one ADMIN entry. If it somehow did anyway
    (stale data from before that constraint existed), only the first
    match is used rather than treating the user as admin of several clubs.
    """
    roles = (user or {}).get("roles", {})
    for club_id, role in roles.items():
        if role == "ADMIN":
            return club_id
    return None

def create_session_jwt(user_data: dict, expires_delta: timedelta) -> str:
    """Signs an app-level JWT containing profile and roles."""
    to_encode = user_data.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_session_jwt(token: str) -> Optional[dict]:
    """Verifies and decodes the app JWT session cookie purely in CPU memory."""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    except Exception:
        return None


def get_user_roles(uid: str) -> dict:
    """Fetches all club roles for a user from Firestore (used only during login token minting)."""
    perms_docs = db.collection("user_permissions").where("uid", "==", uid).stream()
    roles = {}
    for doc in perms_docs:
        data = doc.to_dict()
        roles[data.get("clubId")] = data.get("role", "COACH")
    return roles


# ── FASTAPI DEPENDENCIES ──────────────────────────────────────────────────────

async def get_current_user(request: Request) -> Optional[dict]:
    """Decodes local app JWT session cookie.
    
    0 Firestore Reads, 0 Network Calls.
    """
    session_cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if not session_cookie:
        return None

    return decode_session_jwt(session_cookie)


@router.get("/athletes/search")
def search_athletes(
    q: str = Query(..., min_length=1, description="Prefix to match against first or last name"),
    limit: int = Query(8, ge=1, le=20),
    user: Optional[dict] = Depends(get_current_user),
):
    """
    Club-scoped athlete search for the "Register" picker on tournament.html.
    A club ADMIN types a name; this returns matching athletes from ONLY
    the one club they administer. Deliberately NOT age-restricted —
    with one Register button per entry type (not per age division),
    there's no division to scope by until AFTER an athlete is picked;
    age/gender eligibility is resolved client-side at that point instead
    (see resolveEligibleDivisions in tournament.html).

    Prefix matching mirrors the classic Firestore trick:
        where(field, ">=", key).where(field, "<=", key + "\uf8ff")
    run separately against firstName and lastName (already stored
    lowercase — see _birth_year's neighboring note on birthday — so no
    separate firstNameLower/lastNameLower shadow fields are needed, and
    Firestore can't OR two range filters on different fields in one query
    anyway), then merged and de-duplicated here.
    """
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    search_key = q.strip().lower()
    if not search_key:
        return {"athletes": []}

    athletes_ref = db.collection("athletes")

    seen_ids = set()
    candidates = []
    for field in ("firstName", "lastName"):
        query = (
            athletes_ref
            # .where("clubId", "==", admin_club_id)
            .where(field, ">=", search_key)
            .where(field, "<=", search_key + "\uf8ff")
            # .limit(over_fetch_limit)
        )
        for doc in query.stream():
            if doc.id in seen_ids:
                continue
            seen_ids.add(doc.id)
            data = doc.to_dict()
            candidates.append({"id": doc.id, **data, "birthYear": _birth_year(data)})

    candidates.sort(key=lambda a: (a.get("lastName", ""), a.get("firstName", "")))

    return {
        "athletes": [
            {
                "id": a["id"],
                # displayName is the properly-cased field ("Pavel Ižarik");
                # firstName/lastName are stored lowercase for the prefix
                # query above and were never meant for display — showing
                # them directly was a bug (search results and confirmation
                # text rendered "pavel ižarik" instead of "Pavel Ižarik").
                "displayName": a.get("displayName") or f"{a.get('firstName', '')} {a.get('lastName', '')}".strip(),
                "firstname": a.get("firstName", ""),
                "lastname": a.get("lastName", ""),
                "club": a.get("clubName", ""),
                "clubId": a.get("clubId"),
                "gender": a.get("gender"),
                "birthYear": a.get("birthYear"),
            }
            for a in candidates[:limit]
        ]
    }


@router.get("/athletes/search-admin")
def search_athletes_admin(
    q: str = Query(..., min_length=1, description="Prefix to match against first or last name"),
    limit: int = Query(8, ge=1, le=20),
):
    """
    Staff-only athlete search backing the category manager's "+ Add
    Athlete" button — searches every athlete on the platform, not one
    admin's club. No auth dependency at all: the staff dashboard context
    has no club-admin session to check in the first place, unlike
    search_athletes. (Functionally near-identical to search_athletes
    right now since that endpoint's own club filter is currently
    commented out too — but this one exists as its own unguarded route
    so it doesn't silently break if club scoping there gets restored.)

    TODO: same as admin_move_registration_endpoint — gate behind staff
    auth once it exists.
    """
    search_key = q.strip().lower()
    if not search_key:
        return {"athletes": []}

    athletes_ref = db.collection("athletes")
    seen_ids = set()
    candidates = []
    for field in ("firstName", "lastName"):
        query = (
            athletes_ref
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

    return {
        "athletes": [
            {
                "id": a["id"],
                "displayName": a.get("displayName") or f"{a.get('firstName', '')} {a.get('lastName', '')}".strip(),
                "club": a.get("clubName", ""),
                "clubId": a.get("clubId"),
                "gender": a.get("gender"),
                "birthYear": a.get("birthYear"),
            }
            for a in candidates[:limit]
        ]
    }


class RegisterEntryRequest(BaseModel):
    athleteIds: List[str]  # 1 for "individual" entries, 2+ for pairs/team — see entryTypeCode
    entryTypeCode: str      # e.g. "individual" — folded into categoryCode below to keep brackets disambiguated across entry types
    ageCode: str             # division code, e.g. "cadets" — also the division_rosters doc id
    genderCode: str          # e.g. "male" / "female"
    categoryCode: str        # e.g. "individual_cadets_male_45" — the concrete bracket, from parseCategories() client-side
    categoryLabel: str       # human-readable, e.g. "Individual · Cadets · Male -45kg", stored for display without recomputing


def _execute_registration_create(
    tournament_id: str,
    payload: RegisterEntryRequest,
    requesting_club_id: Optional[str],
    enforce_club_match: bool,
) -> None:
    """
    Shared transaction body behind both create endpoints:
      - register_entry_endpoint: club ADMIN registering their own
        athlete(s), club match enforced against requesting_club_id.
      - admin_register_entry_endpoint: staff category-manager "+ Add
        Athlete" button, enforce_club_match=False, requesting_club_id
        unused — any athlete from any club can be added to any category.

    Writes three documents in a single Firestore transaction (see the
    schema design discussion this follows) — registrations (ground-truth
    audit row, deterministic ID doubles as the dedupe guard),
    division_rosters (lean, fast-read roster), meta/categoryCounts
    (O(1) overview read). All three succeed or none do.
    """
    if not payload.athleteIds:
        raise HTTPException(status_code=400, detail="At least one athlete is required.")

    tournament_ref = db.collection("tournaments").document(tournament_id)
    tournament_doc = tournament_ref.get()
    sport = tournament_doc.to_dict().get("sport") if tournament_doc.exists else None

    # Re-fetch every member server-side — never trust the club attribution
    # the client happened to show in search results. Also builds the
    # roster's `members` list from ground truth.
    members = []
    for athlete_id in payload.athleteIds:
        athlete_doc = db.collection("athletes").document(athlete_id).get()
        if not athlete_doc.exists:
            raise HTTPException(status_code=404, detail=f"Athlete {athlete_id} not found.")
        athlete = athlete_doc.to_dict()
        if enforce_club_match and athlete.get("clubId") != requesting_club_id:
            raise HTTPException(status_code=403, detail="You can only register athletes from your own club.")
        members.append(_build_roster_member(athlete_id, athlete, sport))

    entry_id = "-".join(sorted(payload.athleteIds))

    reg_ref = tournament_ref.collection("registrations").document(f"{payload.categoryCode}_{entry_id}")
    roster_ref = tournament_ref.collection("division_rosters").document(payload.ageCode)
    counts_ref = tournament_ref.collection("meta").document("categoryCounts")

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
            "genderCode": payload.genderCode,
            "categoryCode": payload.categoryCode,
            "categoryLabel": payload.categoryLabel,
            "athleteIds": payload.athleteIds,
            # For the club-scoped path this is the registering admin's own
            # club (== every member's club, already enforced above). For
            # the staff path there's no requesting club at all, so fall
            # back to the first member's own clubId.
            "clubId": requesting_club_id or (members[0].get("clubId") if members else None),
            "status": "active",
            "registeredAt": firestore.SERVER_TIMESTAMP,
        })

        tx.set(roster_ref, {
            "athletes": {payload.categoryCode: {entry_id: {"members": members}}}
        }, merge=True)

        tx.set(counts_ref, {payload.categoryCode: firestore.Increment(1)}, merge=True)

    try:
        _register(transaction)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Registration failed: {exc}")


@router.post("/tournaments/{tournament_id}/registrations", status_code=status.HTTP_201_CREATED)
def register_entry_endpoint(
    tournament_id: str,
    payload: RegisterEntryRequest,
    user: Optional[dict] = Depends(get_current_user),
):
    """
    Registers one ENTRY — one athlete for "individual", several for
    "pairs"/"team" — into one concrete category, for a club ADMIN
    registering their own athlete(s). See _execute_registration_create
    for the actual transaction and admin_register_entry_endpoint for the
    unguarded staff counterpart used by the category manager.
    """
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    _execute_registration_create(tournament_id, payload, requesting_club_id=admin_club_id, enforce_club_match=True)
    return {"message": "Entry registered", "categoryCode": payload.categoryCode}


@router.post("/tournaments/{tournament_id}/registrations/admin-add", status_code=status.HTTP_201_CREATED)
def admin_register_entry_endpoint(tournament_id: str, payload: RegisterEntryRequest):
    """
    Staff-only counterpart to register_entry_endpoint, used by the
    category manager's "+ Add Athlete" button. Searches ALL athletes on
    the platform (see search_athletes_admin), not just one club's roster,
    and registers directly into whatever category is currently open with
    NO club-ownership or eligibility checks — same trust level as
    admin_move_registration_endpoint.

    TODO: same as admin_move_registration_endpoint — gate behind staff
    auth once it exists; dashboard_router.py has none today.
    """
    _execute_registration_create(tournament_id, payload, requesting_club_id=None, enforce_club_match=False)
    return {"message": "Entry registered", "categoryCode": payload.categoryCode}


@router.get("/athletes/{athlete_id}")
def get_athlete_endpoint(athlete_id: str, user: Optional[dict] = Depends(get_current_user)):
    """
    Single-athlete lookup, club-scoped like search_athletes. Used when
    editing an existing registration: the lean division_rosters entry
    deliberately doesn't carry birthYear/gender (see _build_roster_member),
    so re-running resolveEligibleCategories() client-side for an edit
    needs one fetch per member here rather than bloating every roster
    read with fields only the rare "edit" action actually needs.
    """
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    doc = db.collection("athletes").document(athlete_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Athlete not found.")

    data = doc.to_dict()
    if data.get("clubId") != admin_club_id:
        raise HTTPException(status_code=403, detail="You can only view athletes from your own club.")

    return {
        "id": athlete_id,
        "displayName": data.get("displayName") or f"{data.get('firstName', '')} {data.get('lastName', '')}".strip(),
        "club": data.get("clubName", ""),
        "clubId": data.get("clubId"),
        "gender": data.get("gender"),
        "birthYear": _birth_year(data),
    }


class MoveRegistrationRequest(BaseModel):
    athleteIds: List[str]
    oldCategoryCode: str
    oldAgeCode: str
    newEntryTypeCode: str
    newAgeCode: str
    newGenderCode: str
    newCategoryCode: str
    newCategoryLabel: str


def _execute_registration_move(
    tournament_id: str,
    payload: MoveRegistrationRequest,
    requesting_club_id: Optional[str],
    enforce_ownership: bool,
) -> None:
    """
    Shared transaction body behind both move endpoints:
      - move_registration_endpoint: club ADMIN editing their own entry,
        ownership enforced against requesting_club_id.
      - admin_move_registration_endpoint: staff category-manager drag-and-
        drop, enforce_ownership=False, requesting_club_id unused.

    Since registration doc IDs are deterministic from categoryCode
    (`{categoryCode}_{entryId}`), changing category means changing doc
    ID — there's no in-place rename. So this: marks the old registration
    `status: "moved"` (kept for the audit trail, not deleted outright),
    writes a fresh registration doc under the new ID, removes the roster
    entry from its old (possibly different) division_rosters doc, adds
    it to the new one, and adjusts categoryCounts for both the old and
    new bracket — all in one transaction.
    """
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
        for athlete_id in payload.athleteIds:
            athlete_doc = db.collection("athletes").document(athlete_id).get()
            if not athlete_doc.exists:
                raise HTTPException(status_code=404, detail=f"Athlete {athlete_id} not found.")
            athlete = athlete_doc.to_dict()
            members.append(_build_roster_member(athlete_id, athlete, sport))

        tx.set(old_reg_ref, {"status": "moved", "movedTo": new_reg_ref.id}, merge=True)

        tx.set(new_reg_ref, {
            "tournamentId": tournament_id,
            "entryTypeCode": payload.newEntryTypeCode,
            "ageCode": payload.newAgeCode,
            "genderCode": payload.newGenderCode,
            "categoryCode": payload.newCategoryCode,
            "categoryLabel": payload.newCategoryLabel,
            "athleteIds": payload.athleteIds,
            # Preserved from the ORIGINAL registration, not the requester's
            # own club — matters for the staff tool, where whoever drags a
            # card has no club of their own and moving an entry should
            # never silently reassign it to a different club.
            "clubId": old_data.get("clubId"),
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
    """
    Edits an existing registration — moves it to a different bracket
    and/or division (e.g. correcting a weight bracket, or moving an
    athlete into a division they're also eligible for). This is the
    "Edit" button next to each roster entry in tournament.html, gated
    client-side on the entry's clubId matching the viewing admin's club
    and re-checked here server-side against the OLD registration's
    clubId (never trust the client's claim of ownership). See
    _execute_registration_move for the actual transaction.
    """
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    _execute_registration_move(tournament_id, payload, requesting_club_id=admin_club_id, enforce_ownership=True)
    return {"message": "Registration updated", "categoryCode": payload.newCategoryCode}


@router.put("/tournaments/{tournament_id}/registrations/admin-move")
def admin_move_registration_endpoint(tournament_id: str, payload: MoveRegistrationRequest):
    """
    Staff-only counterpart to move_registration_endpoint, used by the
    internal drag-and-drop category manager (dashboard/category_manager.html)
    that finalizes the field ahead of bracket generation. Deliberately has
    NO club-ownership check and NO eligibility validation — staff can move
    any entry to any category; this tool exists specifically to correct
    things the public registration form's rules wouldn't allow.

    TODO: gate behind whatever staff/internal-dashboard auth eventually
    exists — dashboard_router.py currently has no auth dependency at all,
    so neither does this endpoint yet. Don't expose this publicly as-is.
    """
    _execute_registration_move(tournament_id, payload, requesting_club_id=None, enforce_ownership=False)
    return {"message": "Registration updated", "categoryCode": payload.newCategoryCode}


@router.delete("/tournaments/{tournament_id}/registrations/{category_code}/{entry_id}")
def admin_remove_registration_endpoint(
    tournament_id: str,
    category_code: str,
    entry_id: str,
    age_code: str = Query(..., description="Age division the roster entry lives under — division_rosters is keyed by this, not by categoryCode"),
):
    """
    Staff-only complete removal, used by the bin icon next to each entry
    in the category manager. No club-ownership or eligibility checks —
    same trust level as the other admin-* endpoints.

    Marks the registration `status: "withdrawn"` rather than hard-
    deleting the doc — consistent with how admin_move_registration_endpoint
    handles the audit trail (kept for history, e.g. "who was registered
    and later pulled") — while removing it from the fast-read
    division_rosters doc and decrementing categoryCounts, so it
    disappears from every roster/overview view immediately. From the
    UI's perspective this IS a complete removal; only the audit record
    persists invisibly underneath.

    TODO: same as the other admin-* endpoints — gate behind staff auth
    once it exists.
    """
    tournament_ref = db.collection("tournaments").document(tournament_id)
    reg_ref = tournament_ref.collection("registrations").document(f"{category_code}_{entry_id}")
    roster_ref = tournament_ref.collection("division_rosters").document(age_code)
    counts_ref = tournament_ref.collection("meta").document("categoryCounts")

    transaction = db.transaction()

    @firestore.transactional
    def _remove(tx):
        reg_snap = reg_ref.get(transaction=tx)
        if not reg_snap.exists or reg_snap.to_dict().get("status", "active") != "active":
            raise HTTPException(status_code=404, detail="Registration not found.")

        tx.set(reg_ref, {"status": "withdrawn"}, merge=True)
        tx.update(roster_ref, {f"athletes.{category_code}.{entry_id}": firestore.DELETE_FIELD})
        tx.set(counts_ref, {category_code: firestore.Increment(-1)}, merge=True)

    try:
        _remove(transaction)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Remove failed: {exc}")

    return {"message": "Registration removed"}


@router.get("/tournaments/{tournament_id}/category-counts")
def get_category_counts(tournament_id: str):
    """
    Single-document read backing the categories overview on tournament.html
    — O(1) regardless of tournament size, instead of reading every
    registration to count them. See register_entry_endpoint for where
    this doc is kept in sync (via firestore.Increment in the same
    transaction as the registration write, so it never drifts).
    """
    doc = db.collection("tournaments").document(tournament_id).collection("meta").document("categoryCounts").get()
    counts = doc.to_dict() if doc.exists else {}
    total = sum(v for v in counts.values() if isinstance(v, (int, float)))
    return {"tournamentId": tournament_id, "categoryCounts": counts, "totalRegistered": total}


@router.get("/tournaments/{tournament_id}/division-rosters/{age_code}")
def get_division_roster(tournament_id: str, age_code: str):
    """
    Returns the real registered athletes/teams for ONE age division — see
    register_entry_endpoint for where this doc is written (one doc per
    division, keyed athletes.{categoryCode}.{entryId}, each entry holding
    a `members` list). Fetched lazily by tournament.html: only when an
    admin actually expands that division in the categories browser, not
    for every division that merely exists — so opening the page costs one
    category-counts read, and each division you drill into costs exactly
    one more read, never a read per athlete.
    """
    doc = (
        db.collection("tournaments").document(tournament_id)
        .collection("division_rosters").document(age_code).get()
    )
    athletes = doc.to_dict().get("athletes", {}) if doc.exists else {}
    return {"tournamentId": tournament_id, "ageCode": age_code, "athletes": athletes}


# ── PSS hit-level reference (bracket_builder.html) ────────────────────
# PSS size + hit-level are DISCIPLINE-level reference data (the DAEDO/
# KP&P/etc PSS charts, keyed by weight category) — not tournament-
# specific config. Static, reusable across tournaments, so it lives
# under sports/{sport}/disciplines/{discipline}, matching the matches
# collection there — see upload_pss_hitlevels.py for how these docs get
# populated (a one-time seed per set, not something tournaments write to).
#
# MULTIPLE SETS can coexist side by side (different providers, or the
# same provider's chart revised in a later year) — this endpoint returns
# all of them, and bracket_builder.html lets the admin pick which one to
# apply per tournament rather than assuming there's only ever one.
#
# Court configuration (which physical vests sit on which court, rest-gap,
# age-order) is NOT stored here or anywhere in Firestore — it's genuinely
# per-session operational state that stays entirely client-side in
# bracket_builder.html, per an explicit correction: it should happen
# truly locally, not be persisted as tournament config the way an
# earlier version of this endpoint set assumed.

@router.get("/sports/{sport}/disciplines/{discipline}/pss-hit-level-sets")
def list_pss_hit_level_sets_endpoint(sport: str, discipline: str):
    """
    Returns every named PSS hit-level reference set available for this
    discipline — e.g. DAEDO's 2023 chart, a KP&P chart, a later-year
    revision. Each set: { id, provider, year, label, note, pssHitLevels }
    where pssHitLevels is { "cadets|male": [{maxWeight, pssSize, hitLevel}, ...], ... },
    index-parallel with the weight thresholds in the category schema.
    Payload stays small (~150 rows per set) even with several sets, so
    this returns full data for all of them in one call rather than a
    lightweight list + a second fetch per selection.
    """
    docs = (
        db.collection("sports").document(sport)
        .collection("disciplines").document(discipline)
        .collection("pssHitLevelSets").stream()
    )
    return {"sport": sport, "discipline": discipline, "sets": [{"id": d.id, **d.to_dict()} for d in docs]}



# ── Bracket commit ("Push to Firebase") ───────────────────────────────
# Everything upstream of this (seeding, placement, bracket structure,
# court ordering) runs client-side in bracket_builder.html — nothing
# touches Firestore until this one call, matching "done locally, then
# pushed" from the design discussion.

class BracketCommitBracket(BaseModel):
    categoryCode: str
    categoryLabel: str
    discipline: str
    format: str               # "duel" | "individual"
    system: str                # "single_elimination" | "round_robin" | "cut_off"
    orderingStrategy: str
    placementStrategy: str
    entries: List[Dict]        # [{ entryId, athleteIds, seed, clubId, country }]
    pssHitLevelSetId: Optional[str] = None  # which reference set (e.g. "daedo_2023") was used to derive pssSize/hitLevel on this bracket's matches


class BracketCommitMatch(BaseModel):
    matchId: str                # client-generated, e.g. "individual_cadets_male_45_r1_m3" — becomes the Firestore doc ID directly, so participant `source` pointers (referencing an earlier match by this same ID) resolve without a lookup step
    bracketCategoryCode: str
    round: int
    matchNumber: int
    participants: List[Dict]    # [{ entryId, athleteIds }] or [{ entryId: null, source: {matchId, slot} }] for TBD later-round slots
    status: str                  # "ready" | "pending" | "walkover"
    winnerEntryId: Optional[str] = None
    courtId: Optional[str] = None
    queuePosition: Optional[int] = None
    pssSize: Optional[int] = None      # e.g. 3 — looked up from the chosen pssHitLevelSet by the category's weight bracket
    hitLevel: Optional[int] = None      # hit-level from that same set/bracket
    pssHitLevelSetId: Optional[str] = None  # e.g. "daedo_2023" — kept on the match itself (not just the bracket) since matches live in their own top-level collection, independently queryable without joining back to the bracket doc



class BracketCommitRequest(BaseModel):
    sport: str
    discipline: str
    brackets: List[BracketCommitBracket]
    matches: List[BracketCommitMatch]


@router.post("/tournaments/{tournament_id}/brackets/commit", status_code=status.HTTP_201_CREATED)
def commit_brackets_endpoint(tournament_id: str, payload: BracketCommitRequest):
    """
    The "Push to Firebase" button. One Firestore batch write for every
    bracket doc (tournaments/{tid}/brackets/{id}) and every match doc
    (sports/{sport}/disciplines/{discipline}/matches/{matchId}, matching
    the single-matches-collection design from the earlier data-model
    discussion — no separate tournament-scoped matches subcollection).
    All-or-nothing: a batch either fully commits or fully fails, so a
    partial network error can't leave the tournament half-scheduled.

    No validation here (same trust level as the other admin-* endpoints
    in this file) — bracket_builder.html is expected to have already
    resolved byes, seeding, and court assignments before the admin hits
    Push.
    """
    batch = db.batch()
    tournament_ref = db.collection("tournaments").document(tournament_id)

    for b in payload.brackets:
        bracket_ref = tournament_ref.collection("brackets").document()
        batch.set(bracket_ref, {
            **b.dict(),
            "tournamentId": tournament_id,
            "status": "generated",
            "createdAt": firestore.SERVER_TIMESTAMP,
        })

    matches_ref = (
        db.collection("sports").document(payload.sport)
        .collection("disciplines").document(payload.discipline)
        .collection("matches")
    )
    for m in payload.matches:
        match_ref = matches_ref.document(m.matchId)
        batch.set(match_ref, {
            **m.dict(exclude={"matchId"}),
            "tournamentId": tournament_id,
            "source": "tournament_system",
            "assignment": "auto",
        })

    batch.commit()
    return {"message": "Brackets committed", "bracketCount": len(payload.brackets), "matchCount": len(payload.matches)}


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

# You'll need a dependency injection function for your Case Repo, similar to get_tournament_repo
def get_case_repo() -> FirebaseCaseRepository:
    return FirebaseCaseRepository(db) # Assuming you created this adapter

@router.post("/cases", status_code=status.HTTP_201_CREATED)
def create_case_endpoint(payload: CreateCaseRequest, repo=Depends(get_case_repo)):
    """API endpoint for the Javascript prompt to send data to."""
    use_case = CreateCaseUseCase(repo)
    use_case.execute(name=payload.name)
    return {"message": "Case created successfully"}

@router.put("/tournaments/{tournament_id}", status_code=200)
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
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"message": "Tournament updated."}

@router.patch("/tournaments/{tournament_id}/status")
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

@router.delete("/tournaments/{tournament_id}", status_code=200)
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

@router.post("/athletes", status_code=status.HTTP_201_CREATED)
async def create_athlete_endpoint(
    payload: CreateAthleteRequest,
    user: Optional[dict] = Depends(get_current_user)
):
    """Handles the creation of the athlete in Firestore."""
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    # 1. Fetch club name from Firestore to attach to the athlete
    club_doc = db.collection("clubs").document(admin_club_id).get()
    club_name = club_doc.to_dict().get("name", "") if club_doc.exists else ""

    # 2. Parse HTML date (YYYY-MM-DD) into a tz-aware datetime for Firestore
    try:
        birth_dt = datetime.strptime(payload.birthday, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid birthday format. Expected YYYY-MM-DD.")

    # 3. Construct athlete data matching your desired schema
    athlete_data = {
        "firstName": payload.firstName.lower(),
        "lastName": payload.lastName.lower(),
        "displayName": f"{payload.firstName.capitalize()} {payload.lastName.capitalize()}",
        "gender": payload.gender.lower(),
        "birthday": birth_dt,
        "country": payload.country.upper(),
        "clubId": admin_club_id,
        "clubName": club_name,
        "sports": {
            payload.sport: {
                "rank": payload.rank
            }
        },
        "createdAt": firestore.SERVER_TIMESTAMP
    }

    # 4. Save to Firestore
    _, doc_ref = db.collection("athletes").add(athlete_data)
    
    return {"id": doc_ref.id, "message": "Athlete created successfully"}