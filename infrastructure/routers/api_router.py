import unicodedata

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
    associationId: Optional[str] = None  # optional, sport-scoped national/association federation ID

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

    def _club_fields(a: dict) -> dict:
        sport_data = (a.get("sports") or {}).get(club_sport, {})
        return {"club": sport_data.get("clubName", ""), "clubId": sport_data.get("clubId")}

    return {"athletes": [
        {
            "id": a["id"],
            "displayName": a.get("displayName") or f"{a.get('firstName','')} {a.get('lastName','')}".strip(),
            "firstname": a.get("firstName", ""), "lastname": a.get("lastName", ""),
            **_club_fields(a),
            "gender": a.get("gender"), "birthYear": a.get("birthYear"),
        }
        for a in candidates[:limit]
    ]}


@router.get("/athletes/search-admin")
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

    def _club_fields(a: dict) -> dict:
        sport_data = (a.get("sports") or {}).get(sport_key, {})
        return {"club": sport_data.get("clubName", ""), "clubId": sport_data.get("clubId")}

    return {"athletes": [
        {
            "id": a["id"],
            "displayName": a.get("displayName") or f"{a.get('firstName','')} {a.get('lastName','')}".strip(),
            **_club_fields(a),
            "country": a.get("country"), "gender": a.get("gender"), "birthYear": a.get("birthYear"),
        }
        for a in candidates[:limit]
    ]}


class RegisterEntryRequest(BaseModel):
    athleteIds: List[str]
    entryTypeCode: str
    ageCode: str
    genderCode: str
    categoryCode: str
    categoryLabel: str


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
    for athlete_id in payload.athleteIds:
        athlete_doc = db.collection("athletes").document(athlete_id).get()
        if not athlete_doc.exists:
            raise HTTPException(status_code=404, detail=f"Athlete {athlete_id} not found.")
        athlete = athlete_doc.to_dict()
        athlete_club_id = ((athlete.get("sports") or {}).get(sport) or {}).get("clubId")
        if enforce_club_match and athlete_club_id != requesting_club_id:
            raise HTTPException(status_code=403, detail="You can only register athletes from your own club.")
        members.append(_build_roster_member(athlete_id, athlete, sport))

    entry_id = "-".join(sorted(payload.athleteIds))

    club_id = requesting_club_id or (members[0].get("clubId") if members else None)
    club_name = members[0].get("club") if members else None

    reg_ref = tournament_ref.collection("registrations").document(f"{payload.categoryCode}_{entry_id}")
    roster_ref = tournament_ref.collection("division_rosters").document(payload.ageCode)
    counts_ref = tournament_ref.collection("meta").document("categoryCounts")
    # Denormalized club roll-up: which clubs have >=1 active registration in
    # this tournament, and how many, so the admin panel and the weigh-in /
    # backup sheet generator can group by club without scanning every
    # registration doc. Kept in the SAME transaction as the registration
    # write so it never drifts out of sync with the real registration count.
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
            "genderCode": payload.genderCode,
            "categoryCode": payload.categoryCode,
            "categoryLabel": payload.categoryLabel,
            "athleteIds": payload.athleteIds,
            "clubId": club_id,
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


@router.post("/tournaments/{tournament_id}/registrations", status_code=status.HTTP_201_CREATED)
def register_entry_endpoint(
    tournament_id: str,
    payload: RegisterEntryRequest,
    user: Optional[dict] = Depends(get_current_user),
):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        raise HTTPException(status_code=403, detail="Requires an ADMIN role in a club.")

    _execute_registration_create(tournament_id, payload, requesting_club_id=admin_club_id, enforce_club_match=True)
    return {"message": "Entry registered", "categoryCode": payload.categoryCode}


@router.post("/tournaments/{tournament_id}/registrations/admin-add", status_code=status.HTTP_201_CREATED)
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

    return {
        "id": athlete_id,
        "displayName": data.get("displayName") or f"{data.get('firstName','')} {data.get('lastName','')}".strip(),
        "club": sport_data.get("clubName", ""),
        "clubId": sport_data.get("clubId"),
        "associationId": sport_data.get("associationId"),
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

        # NOTE: no registeredClubs write here on purpose — moving a
        # registration between categories never changes which club owns
        # the entry (old_data["clubId"] carries straight over to the new
        # registration doc above), so the club roll-up counts stay correct
        # without touching them.

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

    _execute_registration_move(tournament_id, payload, requesting_club_id=admin_club_id, enforce_ownership=True)
    return {"message": "Registration updated", "categoryCode": payload.newCategoryCode}


@router.put("/tournaments/{tournament_id}/registrations/admin-move")
def admin_move_registration_endpoint(tournament_id: str, payload: MoveRegistrationRequest):
    _execute_registration_move(tournament_id, payload, requesting_club_id=None, enforce_ownership=False)
    return {"message": "Registration updated", "categoryCode": payload.newCategoryCode}


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
        if reg_data.get("clubId") != admin_club_id:
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
    many. Not used by the weigh-in/backup sheet generator (that endpoint
    below groups fresh off live registrations instead) — this is purely
    for fast "who's registered so far" UI.
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
    placementStrategy: str
    entries: List[Dict]
    pssHitLevelSetId: Optional[str] = None


class BracketCommitMatch(BaseModel):
    matchId: str
    bracketCategoryCode: str
    round: int
    matchNumber: int
    displayNumber: Optional[float] = None
    blue: Dict
    red: Dict
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


class BracketCommitRequest(BaseModel):
    sport: str
    discipline: str
    brackets: List[BracketCommitBracket]
    matches: List[BracketCommitMatch]


@router.post("/tournaments/{tournament_id}/brackets/commit", status_code=status.HTTP_201_CREATED)
def commit_brackets_endpoint(tournament_id: str, payload: BracketCommitRequest):
    batch = db.batch()
    tournament_ref = db.collection("tournaments").document(tournament_id)
    tournament_doc = tournament_ref.get()
    tournament_name = tournament_doc.to_dict().get("title") if tournament_doc.exists else None

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


    real_id_by_local_id = {}
    for m in payload.matches:
        match_number = m.displayNumber if m.displayNumber is not None else m.matchId
        real_id_by_local_id[m.matchId] = f"{tournament_id}_{str(int(match_number)) if isinstance(match_number, float) and match_number.is_integer() else str(match_number)}"

    for m in payload.matches:
        doc_id = real_id_by_local_id[m.matchId]
        match_ref = matches_ref.document(doc_id)

        def _resolve_corner(corner: Dict) -> Dict:
            corner = dict(corner)
            source = corner.get("source")
            if source and source.get("matchId") in real_id_by_local_id:
                corner["source"] = {**source, "matchId": real_id_by_local_id[source["matchId"]]}
            return corner

        batch.set(match_ref, {
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
            "pssSize": m.pssSize,
            "hitLevel": m.hitLevel,
            "roundTime": m.roundTime,
            "breakTime": m.breakTime,
            "isRanked": m.isRanked,
        }, merge=True)

    batch.commit()
    return {"message": "Brackets committed", "bracketCount": len(payload.brackets), "matchCount": len(payload.matches)}


# ═══════════════════════════════════════════════════════════════════════════
# LIVE QUEUE / MATCH ADMIN CONSOLE
# ═══════════════════════════════════════════════════════════════════════════
# Backs dashboard/live_queue.html. Design:
#   - The match LIST + realtime "is this fight done yet" updates are read
#     directly by the browser via the Firestore web SDK (see
#     get_firebase_client_config below) — no polling, and no backend
#     round-trip on every scroll/tick, which is what keeps this cheap.
#     FastAPI only handles the WRITES an admin makes (reorder, status
#     override, ad hoc insert) plus the one-time court summary on load.
#   - Reordering never renumbers the matches around it. Both the queue
#     order (queuePosition) and, for ad hoc inserted matches, the
#     scoreboard-facing number (displayNumber) use classic fractional/
#     LexoRank-style indexing: take the midpoint of the two neighbouring
#     values. That's where decimals like 101.5 or 0.5 come from — one
#     write, regardless of how many matches sit on either side.
#   - SECURITY: since the browser talks to Firestore directly for reads,
#     Firestore security rules (not this file) are what gate who can read
#     the matches collection. This whole file currently has no staff auth
#     (see the TODOs on the admin-* endpoints above), so before exposing
#     this page, lock down both the Firestore rules for `matches` and add
#     real auth in front of the endpoints below — right now anyone who
#     can reach this route can rewrite the running order.
#   - INDEX: the court query below (tournamentId == X AND courtId == Y,
#     ordered by queuePosition) needs a Firestore composite index. The
#     Firestore console/CLI will offer to create it the first time the
#     query runs and errors with a "failed-precondition" link — do that
#     once per sport/discipline collection before going live.


@router.get("/firebase-client-config")
def get_firebase_client_config():
    """
    Public (client-safe) Firebase config for the web SDK the live queue
    page uses for realtime onSnapshot listeners. These values are not
    secrets — Firestore security rules are what actually gate access,
    same as any Firebase web app — so this just surfaces env vars rather
    than hardcoding a project into the template.
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
    One-time (per page load / court-bar refresh) summary used to build
    the court tab bar: every courtId in use for this tournament, how
    many matches are pending/ready/done on it, and which match is up
    next. Everything AFTER this initial load is realtime via the client
    SDK — this endpoint is just what lets the page know which courts and
    counts to show before subscribing to any of them.
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
    Falls back to prev+1 / nxt-1 at either end of the list, and to
    `fallback` when there's nothing on the court yet.
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


@router.patch("/matches/{sport}/{discipline}/{match_id}/position")
def reposition_match_endpoint(sport: str, discipline: str, match_id: str, payload: PositionUpdateRequest):
    """
    Drag-and-drop reorder / re-court. The client sends the queuePosition
    of whichever two matches now straddle the drop spot (None at either
    end of a court's list); see _fractional_midpoint for how the new
    value is derived. Only writes the one document that moved — nothing
    else in the queue is touched. If the drop also crosses a boundary
    where the scoreboard-facing displayNumber matters, pass
    prev/nextDisplayNumber too and it gets the same treatment.
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


@router.patch("/matches/{sport}/{discipline}/{match_id}/status")
def update_match_status_endpoint(sport: str, discipline: str, match_id: str, payload: MatchStatusUpdateRequest):
    """
    Manual status override for the admin console. TkStrike's
    FirebaseSyncPlugin normally owns this once a fight is actually
    fought (see commit_brackets_endpoint's docstring on the match doc
    being a hybrid), but staff need an escape hatch: forcing a fight
    ready ahead of its scheduled slot, calling a no-show a walkover, or
    correcting a status that got stuck. Setting winnerEntryId here is
    what "done" and "walkover" mean in practice — pass the winning
    corner's entryId along with the status.
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
        # Resetting back to pending/ready clears a stale winner instead
        # of leaving it dangling on a fight that's no longer "done".
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


@router.post("/tournaments/{tournament_id}/matches/insert", status_code=status.HTTP_201_CREATED)
def insert_match_endpoint(
    tournament_id: str,
    payload: InsertMatchRequest,
    repo: TournamentPort = Depends(get_tournament_repo),
):
    """
    The "+" that appears when hovering the gap between two rows in the
    live queue — creates a brand-new match that slots in right there,
    without renumbering anything else. Uses the same fractional-index
    trick as reposition_match_endpoint for BOTH queuePosition (its spot
    in the running order) and displayNumber (the scoreboard number,
    e.g. 101 and 102 becoming 101.5), so this is a single document write.

    isRanked defaults to True but exists specifically for this endpoint:
    an admin slotting in a late add-on or a friendly/exhibition bout
    between two real bracket fights sets it False so results reporting
    and standings can skip it — see BracketCommitMatch.isRanked for the
    same flag on normally-scheduled matches.
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


@router.get("/tournaments/{tournament_id}/weighin-data")
def get_weighin_data(tournament_id: str, repo: TournamentPort = Depends(get_tournament_repo)):
    """
    Single source of truth for the two client-generated backup documents
    (weigh-in sheet, backup registration sheet) — see
    dashboard/category_manager.html's "Generate Weigh-in Sheet" /
    "Generate Registration Sheet" buttons, which fetch this once and
    render an actual PDF entirely client-side with jsPDF (drawn as
    vectors — not the browser's print engine — specifically so the
    output is byte-identical regardless of which browser/OS/printer
    driver opens it). Nothing here is persisted; it's a fresh read of
    active registrations, grouped by club, every time it's called.

    Registrations with no clubId (e.g. entries added via admin-add
    without a requesting club) are returned separately under
    "unassigned" rather than folded into any real club's roster, so the
    client can render them as their own unlabeled page(s).
    """
    tournament = repo.getTournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    tournament_ref = db.collection("tournaments").document(tournament_id)
    regs = [
        d.to_dict() for d in tournament_ref.collection("registrations").stream()
        if d.to_dict().get("status", "active") == "active"
    ]

    # Batch-resolve every referenced athlete once, instead of one read per
    # registration entry.
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

    sport_entry = {"rank": payload.rank, "clubId": admin_club_id, "clubName": club_name}
    association_id = (payload.associationId or "").strip()
    if association_id:
        sport_entry["associationId"] = association_id

    athlete_data = {
        "firstName": normalize_name(payload.firstName),
        "lastName": normalize_name(payload.lastName),
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

import secrets  # add to imports at top

# ── SCHEMAS ────────────────────────────────────────────────────────────
class CreateTokenRequest(BaseModel):
    token: Optional[str] = None          # optional custom name; becomes the doc id
    role: str
    clubId: str
    clubName: Optional[str] = ""
    expiresAt: Optional[datetime] = None


# ── ENDPOINTS ──────────────────────────────────────────────────────────
@router.post("/tokens", status_code=status.HTTP_201_CREATED)
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


@router.get("/tokens/paginated")
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