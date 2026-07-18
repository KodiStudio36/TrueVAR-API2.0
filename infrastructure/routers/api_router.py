from ssl import _create_default_https_context

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from datetime import datetime
from typing import List

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

    class Config:
        from_attributes = True

VALID_STATUSES = {"active", "archived"}

class StatusUpdate(BaseModel):
    status: str


@router.post("/tournaments", status_code=status.HTTP_201_CREATED)
def create_tournament_endpoint(payload: CreateTournamentRequest, repo=Depends(get_tournament_repo)):
    use_case = CreateTournamentUseCase(repo)
    use_case.execute(
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
    return {}, 200


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
            }
            for t in tournaments
        ],
        "has_more": len(tournaments) == limit,  # heuristic: a full page implies there may be another
        "next_offset": offset + len(tournaments),
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