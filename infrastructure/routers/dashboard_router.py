from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.templating import Jinja2Templates

from infrastructure.routers.api_router import get_case_repo
from usecases.case_usecase import GetAllCasesUseCase
from usecases.tournament_usecase import GetAllTournamentsUseCase, GetTournamentUseCase
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore

router = APIRouter(tags=["UI"])
templates = Jinja2Templates(directory="templates")

def get_tournament_repo() -> FirebaseTournamentRepository:
    db = init_firestore()
    return FirebaseTournamentRepository(db)

@router.get("/")
async def dashboard_page(
    request: Request, 
    tournament_repo=Depends(get_tournament_repo),
    case_repo=Depends(get_case_repo)  # Inject the Case repo here
):
    """Renders the main dashboard with all tournaments and cases."""
    # Fetch Tournaments
    tournament_use_case = GetAllTournamentsUseCase(tournament_repo)
    tournaments = tournament_repo.getTournamentsPaginated(status="active", limit=10, offset=0)
    
    # Fetch Cases
    case_use_case = GetAllCasesUseCase(case_repo)
    cases = case_use_case.execute()
    
    return templates.TemplateResponse(request, "dashboard.html", {
        "request": request,
        "tournaments": tournaments,
        "cases": cases,
    })

@router.get("/tournaments/create")
async def create_tournament_page(request: Request):
    """Renders the form to create a new tournament."""
    return templates.TemplateResponse(
        request, 
        "tournament_create.html", 
        {"request": request}
    )

@router.get("/tournaments/{tournament_id}")
async def tournament_detail_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """Renders the details of a specific tournament."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
        
    return templates.TemplateResponse(
        request,
        "tournament_detail.html", 
        {"request": request, "tournament": tournament}
    )

@router.get("/stream-keys")
async def stream_keys_page(request: Request):
    """Admin page for managing YouTube RTMP stream keys."""
    db = init_firestore()
    docs = db.collection("stream_keys").stream()
    keys = [{"id": doc.id, **doc.to_dict()} for doc in docs]
    return templates.TemplateResponse(
        request,
        "stream_keys.html",
        {"request": request, "keys": keys},
    )
