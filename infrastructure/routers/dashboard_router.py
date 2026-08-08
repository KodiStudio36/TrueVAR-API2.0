from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.templating import Jinja2Templates

from infrastructure.routers.api_router import get_case_repo
from usecases.case_usecase import GetAllCasesUseCase
from usecases.tournament_usecase import GetTournamentUseCase
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
    tournaments = tournament_repo.getTournamentsPaginated(status="active", limit=10, offset=0)
    
    # Fetch Cases
    case_use_case = GetAllCasesUseCase(case_repo)
    cases = case_use_case.execute()
    
    return templates.TemplateResponse(request, "dashboard/dashboard.html", {
        "request": request,
        "tournaments": tournaments,
        "cases": cases,
    })

@router.get("/tournaments/create")
async def create_tournament_page(request: Request):
    """Renders the form to create a new tournament."""
    return templates.TemplateResponse(
        request, 
        "dashboard/tournament_create.html", 
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
        "dashboard/tournament_detail.html", 
        {"request": request, "tournament": tournament}
    )

@router.get("/tournaments/{tournament_id}/categories")
async def tournament_category_manager_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """
    Staff-only drag-and-drop category finalization screen — lists every
    category for the tournament's discipline and lets staff move any
    entry between categories with no eligibility validation, ahead of
    bracket generation. See tournament_detail.html's "Manage Categories"
    link (shown only when isRegistrationOpen is true) for where this is
    linked from.
    """
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)

    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(
        request,
        "dashboard/category_manager.html",
        {"request": request, "tournament": tournament}
    )

@router.get("/tournaments/{tournament_id}/brackets")
async def bracket_builder_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """
    Bracket generation + court ordering — everything computes client-side
    in the browser (seeding, placement, byes, court assignment); nothing
    touches Firestore until the "Push to Firebase" button. See
    commit_brackets_endpoint in api_router.py for that one write.
    """
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)

    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(
        request,
        "dashboard/bracket_builder.html",
        {"request": request, "tournament": tournament}
    )

@router.get("/tournaments/{tournament_id}/live")
async def live_queue_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """
    Realtime match-queue admin console for a running tournament: every
    court's running order top-to-bottom, drag-and-drop reorder/re-court,
    ad hoc match insertion between two existing matches, and live
    pending/ready/done status via the Firestore client SDK — not
    polling. See dashboard/live_queue.html and, in api_router.py, the
    /tournaments/{id}/courts, /firebase-client-config,
    /matches/.../position, /matches/.../status and
    /tournaments/{id}/matches/insert endpoints this page talks to.

    See tournament_detail.html's "Live Match Queue" card for where this
    is linked from.
    """
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)

    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(
        request,
        "dashboard/live_queue.html",
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
        "dashboard/stream_keys.html",
        {"request": request, "keys": keys},
    )