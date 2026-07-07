from ssl import _create_default_https_context

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from datetime import datetime
from typing import List

from adapters.database.firebase_case_repository import FirebaseCaseRepository
from usecases.case_usecase import CreateCaseUseCase
from usecases.tournament_usecase import CreateTournamentUseCase, GetAllTournamentsUseCase, GetTournamentUseCase, UpdateTournamentUseCase
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore

router = APIRouter()
db = init_firestore()

# Dependency Injection for Repository
def get_tournament_repo() -> FirebaseTournamentRepository:
    return FirebaseTournamentRepository(db)

# Pydantic Schemas for API Serialization/Validation
class CreateTournamentRequest(BaseModel):
    title: str
    location: str
    courtNum: int
    dateTime: datetime
    discipline: str
    isStream: bool
    venueName: str
    numbering: str

class TournamentResponse(BaseModel):
    id: str | None
    title: str
    location: str
    courtNum: int
    dateTime: datetime
    discipline: str
    settings: dict

    class Config:
        from_attributes = True


@router.post("/tournaments", status_code=status.HTTP_201_CREATED)
def create_tournament_endpoint(payload: CreateTournamentRequest, repo=Depends(get_tournament_repo)):
    """Acts as the form submission endpoint to create a tournament."""
    use_case = CreateTournamentUseCase(repo)
    use_case.execute(
        title=payload.title,
        location=payload.location,
        courtNum=payload.courtNum,
        dateTime=payload.dateTime,
        discipline=payload.discipline,
        settings={
            "isStream": payload.isStream,
            "venueName": payload.venueName,
            "numbering": payload.numbering,
        },
    )
    return {}, 200


@router.get("/tournaments", response_model=List[TournamentResponse])
def dashboard_endpoint(repo=Depends(get_tournament_repo)):
    """Acts as the dashboard aggregator endpoint providing all tournaments."""
    use_case = GetAllTournamentsUseCase(repo)
    return use_case.execute()


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

class UpdateTournamentRequest(BaseModel):
    title: str
    location: str
    courtNum: int
    dateTime: datetime
    discipline: str
    isStream: bool
    venueName: str
    numbering: str
 
 
@router.put("/tournaments/{tournament_id}", status_code=200)
def update_tournament_endpoint(
    tournament_id: str,
    payload: UpdateTournamentRequest,
    repo=Depends(get_tournament_repo),
):
    """Update an existing tournament's fields in-place."""
    use_case = UpdateTournamentUseCase(repo)
    try:
        use_case.execute(
            tournament_id=tournament_id,
            title=payload.title,
            location=payload.location,
            courtNum=payload.courtNum,
            dateTime=payload.dateTime,
            discipline=payload.discipline,
            settings={
                "isStream": payload.isStream,
                "venueName": payload.venueName,
                "numbering": payload.numbering,
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"message": "Tournament updated."}
 
