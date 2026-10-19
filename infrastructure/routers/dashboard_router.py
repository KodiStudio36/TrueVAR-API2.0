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


def _field(obj, name: str, default=None):
    """Reads a field from a tournament whether it's a model or a plain dict."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _bracket_builder_discipline(tournament_id: str, tournament) -> str:
    """Which bracket builder serves this tournament: "kyorugi" or "poomsae".

    Same rule the builder page used to apply in the browser: the category
    schema decides. A discipline whose schema has a "weight" dimension is
    weight-class sparring (kyorugi); one without is judged forms (poomsae).
    The schema is looked up like the page does — the tournament's own
    sport/discipline key if present, otherwise the first one defined.
    Only when there is no schema yet does the discipline name decide.
    """
    sport = str(_field(tournament, "sport") or "").lower()
    discipline = str(_field(tournament, "discipline") or "").lower()
    by_name = "poomsae" if "poomsae" in discipline else "kyorugi"

    try:
        doc = init_firestore().collection("tournament_categories").document(tournament_id).get()
    except Exception:
        return by_name
    if not doc.exists:
        return by_name

    sport_schemas = ((doc.to_dict() or {}).get("categories") or {}).get("sportSchemas") or {}
    sport_schema = sport_schemas.get(sport) or next(iter(sport_schemas.values()), None)
    if not sport_schema:
        return by_name
    discipline_schemas = sport_schema.get("disciplines") or {}
    discipline_schema = discipline_schemas.get(discipline) or next(iter(discipline_schemas.values()), None)
    if not discipline_schema:
        return by_name

    dimensions = discipline_schema.get("dimensions") or []
    return "kyorugi" if any(d.get("key") == "weight" for d in dimensions) else "poomsae"


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
    """TCO and TOS only. Serves the kyorugi or the poomsae builder — one
    URL, the discipline is detected from the tournament's category schema
    (see _bracket_builder_discipline)."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    discipline = _bracket_builder_discipline(tournament_id, tournament)
    return templates.TemplateResponse(request, f"dashboard/bracket_builder_{discipline}.html", {
        "request": request, "tournament": tournament, "builder_discipline": discipline,
    })


@router.get("/tournaments/{tournament_id}/poomsae-draw",
            dependencies=[Depends(require_operator("brackets:manage"))])
async def poomsae_draw_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """TCO and TOS only — same permission as the bracket builder. Poomsae
    pools per age × rank group and the round 1 / semi-final / final draw
    (see the POOMSAE DRAW endpoints in api_router.py)."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(request, "dashboard/poomsae_draw.html", {
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


def _schedule_board_tournament(t, tournament_id=None) -> dict:
    """What the board needs to know about a tournament — which Firestore
    matches collection / RTDB courts to read, and how many courts it has."""
    dt = _field(t, "dateTime")
    return {
        "id": tournament_id or _field(t, "id"),
        "title": _field(t, "title") or "",
        "sport": str(_field(t, "sport") or "").lower(),
        "discipline": str(_field(t, "discipline") or "").lower(),
        "courtNum": int(_field(t, "courtNum") or 0),
        "dateTime": dt.isoformat() if hasattr(dt, "isoformat") else None,
    }


@router.get("/tournaments/{tournament_id}/schedule-board",
            dependencies=[Depends(require_operator("matches:manage"))])
async def schedule_board_control_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """TCO and TOS only — same permission as the live queue. The board's
    settings live in a cookie in the operator's browser, not on the server."""
    tournament = GetTournamentUseCase(repo).execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    try:
        active = repo.getTournamentsPaginated(status="active", limit=50, offset=0)
    except Exception:
        active = []
    candidates = [_schedule_board_tournament(t) for t in active if _field(t, "id") != tournament_id]

    return templates.TemplateResponse(request, "dashboard/schedule_board_control.html", {
        "request": request,
        "tournament": tournament,
        "host": _schedule_board_tournament(tournament, tournament_id),
        "candidates": candidates,
    })


@router.get("/tournaments/{tournament_id}/schedule-board/screen")
async def schedule_board_screen_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """The venue TV screen. Any operator role can open it (dashboard:view)."""
    tournament = GetTournamentUseCase(repo).execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return templates.TemplateResponse(request, "dashboard/schedule_board_screen.html", {
        "request": request,
        "host": _schedule_board_tournament(tournament, tournament_id),
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