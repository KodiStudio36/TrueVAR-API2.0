from calendar import monthrange
from datetime import date, datetime, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request, Depends, HTTPException

from infrastructure.templates import templates
from infrastructure.routers.operator_auth import (
    require_operator, list_operator_cards, operator_can, tournament_operator_meta, operator_profile,
    OperatorForbiddenError, register_template_globals,
)
from usecases.tournament_usecase import GetTournamentUseCase
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore
from infrastructure.routers.inventory_router import (
    list_inventory_cards, inventory_groups, get_inventory_item_detail, tournament_scheduled_items,
    INVENTORY_TYPES, CASE_TYPE,
)
from infrastructure.auth_common import get_current_user


async def _attach_nav_user(request: Request) -> None:
    """Puts the session user on request.state so dashboard/base.html can
    draw the profile chip on every admin page without each route having
    to pass `user` into its template context."""
    request.state.user = await get_current_user(request)


# Router-level dependencies: EVERY /dashboard route requires at minimum an
# active operator record (any role). This is what turns a non-operator's
# request into a redirect home, while still letting per-route
# dependencies below apply the stricter, role-specific permission that
# turns an under-privileged operator's request into a 403 page instead.
# The second one only exposes the session user to the navbar.
router = APIRouter(
    tags=["UI"],
    dependencies=[Depends(require_operator("dashboard:view")), Depends(_attach_nav_user)],
)


# can(request, "<permission>") in every template — hide what a role can't use.
# can(request, "<permission>"), nav_roles(...), operator_profile(...) in
# templates. NOTE: this only covers the shared infrastructure.templates
# instance — a router that makes its own Jinja2Templates(...) must call
# register_template_globals on it too (see operator_auth.py).
register_template_globals(templates)


def get_tournament_repo() -> FirebaseTournamentRepository:
    db = init_firestore()
    return FirebaseTournamentRepository(db)


def _field(obj, name: str, default=None):
    """Reads a field from a tournament whether it's a model or a plain dict."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


# ── DASHBOARD CALENDAR ────────────────────────────────────────────────────
# Rows = the current month and the next three; columns = Week 1–4 of each
# month by day of month (1–7, 8–14, 15–21, 22–last day, so Week 4 holds
# 7–10 days). Dates are taken in the venue time zone, so a tournament at
# 00:30 local time isn't pushed into the previous day/week by UTC.
CALENDAR_TZ = ZoneInfo("Europe/Bratislava")
CALENDAR_MONTHS = 4
CALENDAR_WEEKS = ((1, 7), (8, 14), (15, 21), (22, 31))  # Week 4 is cut to the month's last day
# Pin / list-stripe colour per discipline. A discipline not listed here
# gets a stable colour from FALLBACK_COLORS (same name → same colour on
# every load), so new disciplines work without touching this file.
DISCIPLINE_COLORS = {      # first match wins — keep "freestyle" before "poomsae"
    "freestyle": "#7c3aed",   # violet
    "kyorugi": "#dc2626",     # red
    "poomsae": "#2563eb",     # blue
    "boxing": "#d97706",      # amber
}
FALLBACK_COLORS = ("#16a34a", "#0891b2", "#db2777", "#65a30d", "#475569")


def _discipline_color(discipline: str) -> str:
    key = (discipline or "").lower()
    for name, color in DISCIPLINE_COLORS.items():
        if name in key:  # "poomsae_freestyle" etc. still match on purpose
            return color
    if not key:
        return FALLBACK_COLORS[-1]
    return FALLBACK_COLORS[sum(map(ord, key)) % (len(FALLBACK_COLORS) - 1)]


def _discipline_label(discipline: str) -> str:
    return (discipline or "Unknown").replace("_", " ").strip().title()
DASHBOARD_LIST_SIZE = 5
ACTIVE_PAGE_SIZE = 50
ACTIVE_MAX_PAGES = 20  # safety stop: at most 1000 active tournaments


def _local_datetime(value) -> Optional[datetime]:
    """Firestore timestamp, datetime or ISO string → aware datetime in
    CALENDAR_TZ. Naive datetimes are taken as UTC."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(CALENDAR_TZ)


MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _date_label(d: date) -> str:
    """12 Sep 2026 — fixed English abbreviations, independent of server locale."""
    return f"{d.day} {MONTH_ABBR[d.month - 1]} {d.year}"


def _registration_label(t, now: datetime) -> str:
    """Value of the hover card's "Regist." row."""
    if not _field(t, "isRegistrationOpen", False):
        external = (_field(t, "settings") or {}).get("externalRegistrationUrl")
        return "External" if external else "Closed"
    deadline = _local_datetime((_field(t, "settings") or {}).get("registrationDeadline"))
    if deadline is None:
        return "Open"
    if deadline < now:
        return "Closed"
    return f"till {_date_label(deadline)}, {deadline:%H:%M}"


def _all_active_tournaments(repo) -> list:
    return _all_tournaments(repo, "active")


def _all_tournaments(repo, status: str) -> list:
    out, offset = [], 0
    for _ in range(ACTIVE_MAX_PAGES):
        page = repo.getTournamentsPaginated(status=status, limit=ACTIVE_PAGE_SIZE, offset=offset)
        out.extend(page)
        if len(page) < ACTIVE_PAGE_SIZE:
            break
        offset += len(page)
    return out


def _dashboard_entries(tournaments, now: datetime) -> List[dict]:
    """Active tournaments sorted by date (undated last). Each carries its
    discipline colour (calendar pin + list stripe) and what the pin's hover
    card shows."""
    entries = []
    for t in tournaments:
        dt = _local_datetime(_field(t, "dateTime"))
        settings = _field(t, "settings") or {}
        discipline = str(_field(t, "discipline") or "").lower()
        entries.append({
            "id": _field(t, "id"),
            "title": _field(t, "title") or "Untitled tournament",
            "location": _field(t, "location") or "",
            "venue": settings.get("venueName") or "",
            "sport": _discipline_label(str(_field(t, "sport") or "")),
            "discipline": _discipline_label(discipline),
            "color": _discipline_color(discipline),
            "courts": _field(t, "courtNum"),
            "isStream": bool(settings.get("isStream")),
            "registration": _registration_label(t, now),
            "date": dt.date() if dt else None,
            "dateLabel": _date_label(dt) if dt else "no date",
            "timeLabel": dt.strftime("%H:%M") if dt else "",
        })
    entries.sort(key=lambda e: (e["date"] is None, e["date"] or date.max, e["title"].lower()))
    return entries


def _discipline_legend(entries: List[dict]) -> List[dict]:
    seen = {}
    for e in entries:
        seen.setdefault(e["discipline"], e["color"])
    return [{"label": k, "color": v} for k, v in sorted(seen.items())]


def _build_calendar(entries: List[dict], today: date) -> List[dict]:
    months = []
    for i in range(CALENDAR_MONTHS):
        year = today.year + (today.month - 1 + i) // 12
        month = (today.month - 1 + i) % 12 + 1
        last_day = monthrange(year, month)[1]

        weeks = []
        for start, end in CALENDAR_WEEKS:
            end = min(end, last_day)
            first, last = date(year, month, start), date(year, month, end)
            weeks.append({
                "range": f"{start}.–{end}.",
                "pins": [e for e in entries if e["date"] and first <= e["date"] <= last],
                "isCurrent": first <= today <= last,
                "isPast": last < today,
            })
        months.append({"label": f"{MONTH_ABBR[month - 1].upper()} {year}", "weeks": weeks})
    return months


@router.get("/")
async def dashboard_page(request: Request, tournament_repo=Depends(get_tournament_repo)):
    """All operator roles (TRO/TAO/TCO/TOS) can view the dashboard."""
    now = datetime.now(CALENDAR_TZ)
    entries = _dashboard_entries(_all_active_tournaments(tournament_repo), now)

    # Mark the tournaments the viewing operator is free / selected for
    # (their own operators doc, already loaded by require_operator).
    me = getattr(request.state, "operator", None) or {}
    mine_selected = set(me.get("selectedTournamentIds") or [])
    mine_free = set(me.get("availableTournamentIds") or [])
    for e in entries:
        e["me"] = "selected" if e["id"] in mine_selected else ("free" if e["id"] in mine_free else None)

    # The list under the calendar: the next DASHBOARD_LIST_SIZE tournaments
    # from today, soonest first. Past and undated ones are on "View all".
    upcoming = [e for e in entries if e["date"] is not None and e["date"] >= now.date()]

    return templates.TemplateResponse(request, "dashboard/dashboard.html", {
        "request": request,
        "calendar": _build_calendar(entries, now.date()),
        "legend": _discipline_legend(entries),
        "tournaments": upcoming[:DASHBOARD_LIST_SIZE],
        "tournaments_me": any(e["me"] for e in entries),
        "pending_drafts": _pending_draft_count(request),
    })


@router.get("/tournaments")
async def all_tournaments_page(request: Request, tournament_repo=Depends(get_tournament_repo)):
    """All operator roles. One timeline, furthest future at the top down to
    the oldest past at the bottom, in three sections:
      1. upcoming — active, dated today or later (undated first)
      2. past     — still active (not archived) but dated before today
      3. archived — loaded 10 at a time by the page from
                    /dashboard/tournaments/archived
    """
    now = datetime.now(CALENDAR_TZ)
    today = now.date()
    entries = _dashboard_entries(_all_active_tournaments(tournament_repo), now)

    undated = [e for e in entries if e["date"] is None]
    upcoming = undated + sorted((e for e in entries if e["date"] is not None and e["date"] >= today),
                                key=lambda e: e["date"], reverse=True)
    past = sorted((e for e in entries if e["date"] is not None and e["date"] < today),
                  key=lambda e: e["date"], reverse=True)

    return templates.TemplateResponse(request, "dashboard/tournaments_all.html", {
        "request": request,
        "upcoming": upcoming,
        "past": past,
        "pending_drafts": _pending_draft_count(request),
    })


ARCHIVED_PAGE = 5


@router.get("/tournaments/archived")
async def archived_tournaments_fragment(request: Request, offset: int = 0, tournament_repo=Depends(get_tournament_repo)):
    """HTML of the next ARCHIVED_PAGE (5) archived tournaments, newest first,
    for the All tournaments page's "Load more". Sorted here because the
    repository's paginated query doesn't return them by date. X-Has-More /
    X-Next-Offset headers drive the button."""
    entries = _dashboard_entries(_all_tournaments(tournament_repo, "archived"), datetime.now(CALENDAR_TZ))
    entries.sort(key=lambda e: e["date"] or date.min, reverse=True)
    offset = max(offset, 0)
    page = entries[offset:offset + ARCHIVED_PAGE]
    next_offset = offset + len(page)
    return templates.TemplateResponse(
        request, "dashboard/_archived_rows.html", {"request": request, "tournaments": page},
        headers={"X-Has-More": "1" if next_offset < len(entries) else "0", "X-Next-Offset": str(next_offset)},
    )


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


@router.get("/tournaments/create", dependencies=[Depends(require_operator("tournament:create"))])
async def create_tournament_page(request: Request, draft: Optional[str] = None):
    """TOS only — creation is explicitly out of scope for TCO.
    ?draft=<id> pre-fills one tournament per discipline of that request
    (see _draft_schedule_plan); ?copy_from=<id> is handled by the page."""
    plan = None
    if draft:
        if not operator_can(request, "drafts:manage"):
            raise HTTPException(status_code=403, detail="You can't schedule tournament requests.")
        doc = init_firestore().collection("tournament_draft").document(draft).get()
        if not doc.exists:
            raise HTTPException(status_code=404, detail="Draft not found")
        plan = _draft_schedule_plan(doc.id, doc.to_dict() or {})
    return templates.TemplateResponse(request, "dashboard/tournament_create.html", {
        "request": request, "draft": plan,
    })


def tournament_categories_info(tournament_id: str) -> Optional[dict]:
    """For the edit page: is there a categories file, and what's in it."""
    snap = init_firestore().collection("tournament_categories").document(tournament_id).get()
    if not snap.exists:
        return None
    d = snap.to_dict() or {}
    schemas = (d.get("categories") or {}).get("sportSchemas") or {}
    disciplines = [f"{sport} · {disc}" for sport, s in schemas.items()
                   for disc in ((s or {}).get("disciplines") or {})]
    stamp = d.get("updatedAt") or d.get("createdAt")
    return {
        "fileName": d.get("fileName"),
        "disciplines": disciplines,
        "updated": _date_label(stamp.date()) if hasattr(stamp, "date") else None,
    }


@router.get("/tournaments/{tournament_id}/edit", dependencies=[Depends(require_operator("tournament:edit"))])
async def edit_tournament_page(request: Request, tournament_id: str):
    """tournament_create.html in edit mode: one section, prefilled with the
    stored values. Times go into the form as raw UTC digits — the same
    convention the create form uses."""
    snap = init_firestore().collection("tournaments").document(tournament_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Tournament not found")
    t = snap.to_dict() or {}
    settings = t.get("settings") or {}

    def utc_input(value) -> str:
        local = _local_datetime(value)
        return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M") if local else ""

    edit = {
        "id": tournament_id,
        "title": t.get("title") or "",
        "location": t.get("location") or "",
        "courtNum": t.get("courtNum") or 1,
        "dateTime": utc_input(t.get("dateTime")),
        "sport": t.get("sport") or "",
        "discipline": t.get("discipline") or "",
        "provider": settings.get("provider") or "",
        "mode": settings.get("mode") or "",
        "venueName": settings.get("venueName") or "Court",
        "numbering": settings.get("numbering") or "Numbers",
        "isStream": bool(settings.get("isStream")),
        "isRegistrationOpen": bool(t.get("isRegistrationOpen")),
        "registrationDeadline": utc_input(settings.get("registrationDeadline")),
        "externalRegistrationUrl": settings.get("externalRegistrationUrl") or "",
        "categories": tournament_categories_info(tournament_id),
        "status": t.get("status") or "active",
    }
    return templates.TemplateResponse(request, "dashboard/tournament_create.html", {
        "request": request, "draft": None, "edit": edit,
    })


@router.get("/tournaments/{tournament_id}")
async def tournament_detail_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """All operator roles can open a tournament to view details."""
    use_case = GetTournamentUseCase(repo)
    tournament = use_case.execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    # Equipment card: tournaments/{id}/meta/inventory (see inventory_router).
    try:
        scheduled_items = tournament_scheduled_items(tournament_id)
    except Exception:
        scheduled_items = []

    # Operators card: tournaments/{id}/meta/operators (see operator_auth).
    me_uid = (getattr(request.state, "operator", None) or {}).get("uid")
    try:
        ops = tournament_operator_meta(tournament_id, me_uid)
    except Exception:
        ops = {"selected": [], "free": [], "me": None}
    if not operator_can(request, "operator:manage"):
        ops["free"] = []   # only TOS sees who's free (the viewer still sees their own status)

    # Card order depends on how close the tournament is (Bratislava days):
    # "prep" 1–2 days before, "day" on the day, otherwise "normal".
    start = _local_datetime(_field(tournament, "dateTime"))
    days_left = (start.date() - datetime.now(CALENDAR_TZ).date()).days if start else None
    card_phase = "day" if days_left == 0 else ("prep" if days_left in (1, 2) else "normal")

    return templates.TemplateResponse(request, "dashboard/tournament_detail.html", {
        "request": request, "tournament": tournament, "scheduled_items": scheduled_items,
        "ops": ops, "me_uid": me_uid, "card_phase": card_phase,
        "tournament_past": days_left is not None and days_left < 0,
        "summary": _tournament_summary(tournament_id, tournament),
    })


def _tournament_summary(tournament_id: str, tournament) -> dict:
    """The few facts the header card shows, read from the raw document so
    fields the Tournament model may not carry (isExternalPublic,
    splitGroup, playlistId) are there too. Times are Bratislava time."""
    try:
        raw = init_firestore().collection("tournaments").document(tournament_id).get().to_dict() or {}
    except Exception:
        raw = {}
    settings = raw.get("settings") or _field(tournament, "settings") or {}
    start = _local_datetime(raw.get("dateTime") or _field(tournament, "dateTime"))
    # Deadlines are entered as raw UTC digits ("23:59") — show them that way.
    deadline = _local_datetime(settings.get("registrationDeadline"))
    deadline = deadline.astimezone(timezone.utc) if deadline else None
    discipline = raw.get("discipline") or _field(tournament, "discipline") or ""
    courts = raw.get("courtNum") or _field(tournament, "courtNum") or 0
    venue = (settings.get("venueName") or "Court").strip()

    if "isExternalPublic" in raw:
        public = bool(raw["isExternalPublic"])
    else:  # older tournaments: kept in settings, missing = public (the old default)
        public = bool(settings.get("isExternalPublic", True))

    split = raw.get("splitGroup") or {}
    days = []
    for i, tid in enumerate(split.get("tournamentIds") or []):
        days.append({"id": tid, "day": i + 1, "current": tid == tournament_id})

    if raw.get("isRegistrationOpen", _field(tournament, "isRegistrationOpen")):
        registration = {"kind": "open",
                        "until": _date_label(deadline.date()) + deadline.strftime(", %H:%M") if deadline else None,
                        "closed": bool(deadline and deadline < datetime.now(timezone.utc))}
    elif settings.get("externalRegistrationUrl"):
        registration = {"kind": "external", "url": settings["externalRegistrationUrl"]}
    else:
        registration = {"kind": "none"}

    return {
        "date": f"{('Mon','Tue','Wed','Thu','Fri','Sat','Sun')[start.weekday()]} {_date_label(start.date())}" if start else "Date TBD",
        "time": start.strftime("%H:%M") if start else "",
        "location": raw.get("location") or _field(tournament, "location") or "TBD",
        "discipline": _discipline_label(discipline),
        "sport": (raw.get("sport") or _field(tournament, "sport") or "").title(),
        "color": _discipline_color(discipline),
        "courts": f"{courts} {venue}{'s' if courts != 1 and not venue.endswith('s') else ''}",
        "mode": settings.get("mode"),
        "public": public,
        "status": raw.get("status") or _field(tournament, "status") or "active",
        "registration": registration,
        "stream": bool(settings.get("isStream")),
        "playlistId": raw.get("playlistId") or _field(tournament, "playlistId"),
        "split": {"day": split.get("day"), "days": split.get("days") or len(days), "list": days} if days else None,
    }


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


@router.get("/tournaments/{tournament_id}/split-days",
            dependencies=[Depends(require_operator("tournament:create"))])
async def split_days_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """TOS only (tournament:create) — split one tournament into several days
    (see the SPLIT A TOURNAMENT INTO DAYS endpoints in api_router.py)."""
    tournament = GetTournamentUseCase(repo).execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return templates.TemplateResponse(request, "dashboard/split_days.html", {
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
            dependencies=[Depends(require_operator("schedule_board:manage"))])
async def schedule_board_control_page(request: Request, tournament_id: str, repo=Depends(get_tournament_repo)):
    """Every operator role (schedule_board:manage) — the one tool TRO/TAO
    get. The board's settings live in a cookie in the operator's browser,
    not on the server."""
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


# ── TOURNAMENT DRAFTS (requests from request_tournament.html) ────────────
# tournament_draft/{id}, written by POST /api/tournament-drafts. Few of them,
# so the page reads them all — no pagination. TOS only ("drafts:manage" is
# in nobody's permission set, so only the TOS wildcard has it).
DRAFT_COURT_COLORS = {
    "kyorugi": DISCIPLINE_COLORS["kyorugi"],
    "poomsae": DISCIPLINE_COLORS["poomsae"],
    "livestream": "#0891b2",
    "livestream_ivr": "#db2777",
}
DRAFT_COURT_LABELS = {
    "kyorugi": "Kyorugi", "poomsae": "Poomsae",
    "livestream": "Livestream", "livestream_ivr": "Livestream + IVR",
}
WEEKDAY_ABBR = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _draft_day(day: dict) -> dict:
    try:
        d = date.fromisoformat(str(day.get("date") or ""))
        label = f"{WEEKDAY_ABBR[d.weekday()]} {_date_label(d)}"
    except ValueError:
        label = str(day.get("date") or "")
    courts, counts = [], {}
    for c in day.get("courts") or []:
        key = str(c.get("discipline") or "").lower()
        name = c.get("disciplineLabel") or DRAFT_COURT_LABELS.get(key) or key.title()
        courts.append({"number": c.get("courtNumber"), "label": name,
                       "color": DRAFT_COURT_COLORS.get(key, FALLBACK_COLORS[-1])})
        counts[name] = counts.get(name, 0) + 1
    return {
        "number": day.get("dayNumber"),
        "dateLabel": label,
        "courts": courts,
        "summary": ", ".join(f"{n} {name}" for name, n in counts.items()),
    }


def _draft_card(doc_id: str, d: dict) -> dict:
    start, end = _local_datetime(d.get("startDate")), _local_datetime(d.get("endDate"))
    created = _local_datetime(d.get("createdAt"))
    done_at = _local_datetime(d.get("doneAt") or d.get("scheduledAt"))
    status = str(d.get("status") or "pending").lower()
    r = d.get("requester") or {}
    days = [_draft_day(day) for day in d.get("days") or []]
    return {
        "id": doc_id,
        "title": d.get("title") or "Untitled request",
        "status": "done" if status in ("done", "successful") else status,
        "startDate": start,
        "dateRange": (_date_label(start) if start else "no date")
                     + (f" – {_date_label(end)}" if end and start and end.date() != start.date() else ""),
        "dayCount": d.get("dayCount") or len(days),
        "courtNum": d.get("courtNum") or max((len(x["courts"]) for x in days), default=0),
        "totalCourts": sum(len(x["courts"]) for x in days),
        "location": ", ".join(p for p in (d.get("city"), d.get("state")) if p),
        "requesterName": f"{r.get('firstname', '')} {r.get('lastname', '')}".strip() or "Unknown",
        "requesterEmail": r.get("email") or "",
        "requesterAccount": bool(r.get("isAuthenticated")),
        "requesterClubId": r.get("clubId"),
        "createdLabel": f"{_date_label(created)}, {created:%H:%M}" if created else "",
        "doneAt": done_at,
        "doneLabel": f"{_date_label(done_at)}, {done_at:%H:%M}" if done_at else "",
        "tournaments": [t for t in (d.get("tournaments") or []) if t.get("id")],
        "days": days,
    }


def _draft_cards() -> List[dict]:
    cards = [_draft_card(doc.id, doc.to_dict() or {})
             for doc in init_firestore().collection("tournament_draft").stream()]
    far = datetime.max.replace(tzinfo=CALENDAR_TZ)
    # Pending first, soonest tournament first.
    cards.sort(key=lambda c: (c["status"] != "pending", c["startDate"] or far))
    return cards


def _pending_draft_count(request: Request) -> Optional[int]:
    """For the "Drafts (n)" links — only read for operators who can open drafts."""
    if not operator_can(request, "drafts:manage"):
        return None
    try:
        q = init_firestore().collection("tournament_draft").where("status", "==", "pending")
        return sum(1 for _ in q.stream())
    except Exception:
        return None


DONE_PAGE = 10


def _done_drafts(cards: List[dict]) -> List[dict]:
    far_past = datetime.min.replace(tzinfo=CALENDAR_TZ)
    done = [c for c in cards if c["status"] == "done"]
    done.sort(key=lambda c: c["doneAt"] or far_past, reverse=True)  # newest first
    return done


@router.get("/drafts", dependencies=[Depends(require_operator("drafts:manage"))])
async def drafts_page(request: Request):
    """TOS only — tournament requests waiting for review. Done drafts
    (scheduled, or marked done by hand) are hidden; the page loads them
    10 at a time from /dashboard/drafts/done."""
    cards = _draft_cards()
    open_cards = [c for c in cards if c["status"] != "done"]
    used = {c["label"]: c["color"] for card in cards for day in card["days"] for c in day["courts"]}
    return templates.TemplateResponse(request, "dashboard/drafts.html", {
        "request": request,
        "pending": open_cards,
        "done_count": len(cards) - len(open_cards),
        "legend": [{"label": k, "color": v} for k, v in used.items()],
    })


@router.get("/drafts/done", dependencies=[Depends(require_operator("drafts:manage"))])
async def done_drafts_fragment(request: Request, offset: int = 0):
    """HTML of the next DONE_PAGE done drafts (newest first) for the drafts
    page's "Load done drafts" button. X-Has-More / X-Next-Offset headers
    drive the button."""
    done = _done_drafts(_draft_cards())
    offset = max(offset, 0)
    page = done[offset:offset + DONE_PAGE]
    next_offset = offset + len(page)
    return templates.TemplateResponse(
        request, "dashboard/_draft_cards.html", {"request": request, "drafts": page},
        headers={"X-Has-More": "1" if next_offset < len(done) else "0", "X-Next-Offset": str(next_offset)},
    )


# ── Draft → tournaments plan (create page, ?draft=<id>) ─────────────────
# One tournament per discipline used in the draft. Courts = the most courts
# that discipline has on any single day; date = the first day it's used.
# More than one discipline → title gets the discipline name appended
# ("BA Open 2026 Kyorugi"). Sport/provider/mode are chosen by the page
# (DRAFT_PRESETS in tournament_create.html), which owns SPORT_DATA.
def _draft_schedule_plan(doc_id: str, d: dict) -> dict:
    groups: Dict[str, dict] = {}
    for day in d.get("days") or []:
        per_day: Dict[str, int] = {}
        for c in day.get("courts") or []:
            key = str(c.get("discipline") or "").lower()
            per_day[key] = per_day.get(key, 0) + 1
        for key, n in per_day.items():
            g = groups.setdefault(key, {
                "discipline": key,
                "label": DRAFT_COURT_LABELS.get(key) or key.replace("_", " ").title(),
                "courtNum": 0, "date": day.get("date"), "days": [],
            })
            g["courtNum"] = max(g["courtNum"], n)
            g["days"].append(day.get("dayNumber"))

    order = list(DRAFT_COURT_LABELS)
    plan = sorted(groups.values(), key=lambda g: order.index(g["discipline"]) if g["discipline"] in order else 99)
    base = (d.get("title") or "").strip()
    for g in plan:
        g["title"] = f"{base} {g['label']}" if len(plan) > 1 else base
        try:
            g["dateLabel"] = _draft_day({"date": g["date"]})["dateLabel"]
        except Exception:
            g["dateLabel"] = g["date"] or ""
    status = str(d.get("status") or "pending").lower()
    return {
        "id": doc_id,
        "title": base,
        "status": "done" if status in ("done", "successful") else status,
        "city": d.get("city") or "",
        "state": d.get("state") or "",
        "tournaments": plan,
    }


# Display order + one-line meaning of each role on the operators page.
OPERATOR_GROUPS = [
    ("TOS", "Full access"),
    ("TCO", "Runs the competition"),
    ("TAO", "Schedule board only"),
    ("TRO", "Schedule board only"),
]


@router.get("/operators", dependencies=[Depends(require_operator("operator:manage"))])
async def operators_page(request: Request):
    """TOS only — operator cards + "Add operator" (API: /api/operators in
    operator_auth.py)."""
    return templates.TemplateResponse(request, "dashboard/operators.html", {
        "request": request,
        "operators": list_operator_cards(),
        "roles": [r for r, _ in OPERATOR_GROUPS],
        "groups": OPERATOR_GROUPS,
        "me": request.state.operator.get("uid"),
    })


@router.get("/operators/{uid}")
async def operator_profile_page(request: Request, uid: str):
    """An operator's profile: rank (role), tournaments worked, upcoming ones.
    TOS can open anyone's; every other operator only their own."""
    me_uid = (getattr(request.state, "operator", None) or {}).get("uid")
    if uid != me_uid and not operator_can(request, "operator:manage"):
        raise OperatorForbiddenError("You can only view your own operator profile.")
    profile = operator_profile(uid)
    if not profile:
        raise HTTPException(status_code=404, detail="Operator not found")
    return templates.TemplateResponse(request, "dashboard/operator_profile.html", {
        "request": request, "p": profile, "is_me": uid == me_uid,
    })


@router.get("/inventory", dependencies=[Depends(require_operator("inventory:manage"))])
async def inventory_page(request: Request):
    """TOS only — all hardware as cards, one section per type (API:
    /api/inventory in inventory_router.py)."""
    items = list_inventory_cards()
    return templates.TemplateResponse(request, "dashboard/inventory.html", {
        "request": request,
        "groups": inventory_groups(items),
        "total": len(items),
        "types": INVENTORY_TYPES,
        "case_type": CASE_TYPE,
    })


@router.get("/inventory/{item_id}", dependencies=[Depends(require_operator("inventory:manage"))])
async def inventory_item_page(request: Request, item_id: str):
    """TOS only — one item: photo, description, case binding, edit/delete,
    and its bug reports (inventory/{id}/bugs)."""
    item = get_inventory_item_detail(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    return templates.TemplateResponse(request, "dashboard/inventory_item.html", {
        "request": request, "item": item,
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


@router.get("/tournaments/{tournament_id}/marketing/results")
async def marketing_results_page(
    tournament_id: str,
    request: Request,
    tournament_repo=Depends(get_tournament_repo),
    # + the operator/permission dependency your live-queue route uses
):
    tournament = GetTournamentUseCase(tournament_repo).execute(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
 
    return templates.TemplateResponse(request, "dashboard/marketing_results.html", {
        "request": request,
        "tournament": tournament,
    })