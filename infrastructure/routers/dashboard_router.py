from fastapi import APIRouter, Request, Depends, HTTPException

from infrastructure.templates import templates
from infrastructure.routers.operator_auth import require_operator
from infrastructure.routers.api_router import get_case_repo
from usecases.case_usecase import GetAllCasesUseCase
from usecases.tournament_usecase import GetAllTournamentsUseCase, GetTournamentUseCase
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore

# Router-level dependency: EVERY /dashboard route requires at minimum an
# active operator record (any role). This is what turns a non-operator's
# request into a redirect home, while still letting per-route
# dependencies below apply the stricter, role-specific permission that
# turns an under-privileged operator's request into a 403 page instead.
router = APIRouter(
    tags=["UI"],
    dependencies=[Depends(require_operator("dashboard:view"))],
)


def get_tournament_repo() -> FirebaseTournamentRepository:
    db = init_firestore()
    return FirebaseTournamentRepository(db)


@router.get("/")
async def dashboard_page(
    request: Request,
    tournament_repo=Depends(get_tournament_repo),
    case_repo=Depends(get_case_repo),
):
    """All operator roles (TRO/TAO/TCO/TOS) can view the dashboard list."""
    tournament_use_case = GetAllTournamentsUseCase(tournament_repo)
    tournaments = tournament_repo.getTournamentsPaginated(status="active", limit=10, offset=0)

    case_use_case = GetAllCasesUseCase(case_repo)
    cases = case_use_case.execute()

    return templates.TemplateResponse(request, "dashboard/dashboard.html", {
        "request": request,
        "tournaments": tournaments,
        "cases": cases,
    })


@router.get("/tournaments/create", dependencies=[Depends(require_operator("tournament:create"))])
async def create_tournament_page(request: Request):
    """TOS only — creation is explicitly out of scope for TCO."""
    return templates.TemplateResponse(request, "dashboard/tournament_create.html", {"request": request})


@router.get("/tournaments/{tournament_id}")
async def tournament_detail_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """All operator roles can open a tournament to view details."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(request, "dashboard/tournament_detail.html", {
        "request": request, "tournament": tournament,
    })


@router.get("/tournaments/{tournament_id}/categories",
            dependencies=[Depends(require_operator("categories:manage"))])
async def tournament_category_manager_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """TCO and TOS only."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(request, "dashboard/category_manager.html", {
        "request": request, "tournament": tournament,
    })


@router.get("/tournaments/{tournament_id}/brackets",
            dependencies=[Depends(require_operator("brackets:manage"))])
async def bracket_builder_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """TCO and TOS only."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(request, "dashboard/bracket_builder.html", {
        "request": request, "tournament": tournament,
    })


@router.get("/tournaments/{tournament_id}/live",
            dependencies=[Depends(require_operator("matches:manage"))])
async def live_queue_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """TCO and TOS only — TRO/TAO cannot touch the live queue."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(request, "dashboard/live_queue.html", {
        "request": request, "tournament": tournament,
    })


@router.get("/stream-keys", dependencies=[Depends(require_operator("stream_keys:manage"))])
async def stream_keys_page(request: Request):
    """TOS only."""
    db = init_firestore()
    docs = db.collection("stream_keys").stream()
    keys = [{"id": doc.id, **doc.to_dict()} for doc in docs]
    return templates.TemplateResponse(request, "dashboard/stream_keys.html", {
        "request": request, "keys": keys,
    })