"""
Settings / Club management router.

Adds:
  Pages (no prefix, mirrors auth_router.py's page routes):
    GET  /settings          - profile card + club card (My Club / Create Club)
    GET  /clubs/new         - club creation form
    GET  /clubs/mine        - admin's club dashboard: searchable, paginated roster

  API (explicit /api prefix, mirrors auth_router.py's /api/auth/* convention):
    POST /api/clubs                        - create a club, makes caller its ADMIN
    GET  /api/clubs/{club_id}/athletes     - paginated + searched roster for a club

Wire this up the same way auth_router.py is included in the main app, e.g.:
    from infrastructure.routers import club_router
    app.include_router(club_router.router)
"""

from typing import Optional
import pycountry

from fastapi import APIRouter, Request, Response, HTTPException, Depends, status, Query
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from firebase_admin import auth, firestore

from infrastructure.firebase_client import init_firestore
from infrastructure.routers.api_router import (
    EXPIRES_IN,
    SESSION_COOKIE_NAME,
    create_session_jwt,
    get_admin_club_id,
    get_current_user,
    get_user_roles,
)

router = APIRouter(tags=["Settings & Clubs"])
templates = Jinja2Templates(directory="templates")
db = init_firestore()


# ── SCHEMAS ────────────────────────────────────────────────────────────────

class CreateClubRequest(BaseModel):
    name: str
    state: str  # Selected Country (maps to Alpha-3)
    city: str   # City/Locality text input
    sport: str  # e.g., "taekwondo" or "box"


# ── HELPERS ────────────────────────────────────────────────────────────────

def _to_alpha3(country_str: str) -> str:
    """Helper to ensure input country string resolves to Alpha-3 code."""
    c_str = country_str.strip()
    if len(c_str) == 3:
        return c_str.upper()
    try:
        match = pycountry.countries.get(name=c_str) or pycountry.countries.search_fuzzy(c_str)[0]
        return match.alpha_3
    except Exception:
        return c_str[:3].upper()

def _get_athlete_count(club_id: str, sport: str) -> Optional[int]:
    try:
        agg = db.collection("athletes").where(f"sports.{sport}.clubId", "==", club_id).count().get()
        return agg[0][0].value
    except Exception:
        return None


def _reissue_session(user: dict, response: Response) -> None:
    """After a role change (e.g. creating a club), mint a fresh session JWT
    with up-to-date roles so /settings reflects it without a re-login."""
    uid = user.get("uid")
    roles = get_user_roles(uid)
    jwt_payload = {k: v for k, v in user.items() if k != "exp"}
    jwt_payload["roles"] = roles
    session_token = create_session_jwt(jwt_payload, EXPIRES_IN)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_token,
        max_age=int(EXPIRES_IN.total_seconds()),
        httponly=True,
        secure=False,  # Set to True in production with HTTPS
        samesite="lax",
    )


# ── PAGES ──────────────────────────────────────────────────────────────────

@router.get("/settings")
async def settings_page(request: Request, user: Optional[dict] = Depends(get_current_user)):
    if not user:
        return RedirectResponse(url="/login", status_code=303)

    admin_club_id = get_admin_club_id(user)
    club_name = None
    athlete_count = None

    if admin_club_id:
        club_doc = db.collection("clubs").document(admin_club_id).get()
        club_data = club_doc.to_dict() if club_doc.exists else {}
        club_name = club_data.get("name")
        athlete_count = _get_athlete_count(admin_club_id, club_data.get("sport"))

    return templates.TemplateResponse(request, "settings.html", {
        "request": request, "user": user, "admin_club_id": admin_club_id,
        "club_name": club_name, "athlete_count": athlete_count,
    })


@router.get("/clubs/new")
async def create_club_page(request: Request, user: Optional[dict] = Depends(get_current_user)):
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    if get_admin_club_id(user):
        # Already administers a club — nothing to create.
        return RedirectResponse(url="/clubs/mine", status_code=303)

    return templates.TemplateResponse(request, "create_club.html", {"request": request, "user": user})


@router.get("/clubs/mine")
async def my_club_page(request: Request, user: Optional[dict] = Depends(get_current_user)):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id:
        return RedirectResponse(url="/settings", status_code=303)

    club_doc = db.collection("clubs").document(admin_club_id).get()
    club_name = club_doc.to_dict().get("name") if club_doc.exists else "Your Club"

    return templates.TemplateResponse(request, "my_club.html", {
        "request": request,
        "user": user,
        "club_id": admin_club_id,
        "club_name": club_name,
    })


# ── API ────────────────────────────────────────────────────────────────────

@router.post("/api/clubs", status_code=status.HTTP_201_CREATED)
async def create_club_endpoint(payload: CreateClubRequest, response: Response, user: Optional[dict] = Depends(get_current_user)):
    if not user:
        raise HTTPException(status_code=401, detail="Login required.")

    uid = user.get("uid")
    raw_name = payload.name.strip()
    city_state = payload.city.strip()
    sport = payload.sport.strip().lower()

    if not raw_name:
        raise HTTPException(status_code=400, detail="Club name is required.")
    if not payload.state:
        raise HTTPException(status_code=400, detail="Country/State must be selected.")
    if not city_state:
        raise HTTPException(status_code=400, detail="City/State locality is required.")
    if not sport:
        raise HTTPException(status_code=400, detail="Sport is required.")

    existing_docs = db.collection("user_permissions").where("uid", "==", uid).stream()
    for doc in existing_docs:
        if doc.to_dict().get("role") == "ADMIN":
            raise HTTPException(status_code=409, detail="This account already administers a club.")

    alpha3_country = _to_alpha3(payload.state)
    formatted_name = raw_name
    lower_name = formatted_name.lower()

    club_ref = db.collection("clubs").document()
    club_ref.set({
        "country": alpha3_country,
        "lowerName": lower_name,
        "name": formatted_name,
        "state": city_state,
        "sport": sport,
        "verifiedStatus": False,
        "ownerUid": uid,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })
    club_id = club_ref.id

    perm_doc_id = f"{uid}_{club_id}"
    db.collection("user_permissions").document(perm_doc_id).set({
        "uid": uid,
        "clubId": club_id,
        "clubName": formatted_name,
        "role": "ADMIN",
        "permissions": [],
        "grantedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    _reissue_session(user, response)
    return {"id": club_id, "message": "Club created successfully", "redirectUrl": "/clubs/mine"}


@router.get("/api/clubs/{club_id}/athletes")
def list_club_athletes(
    club_id: str,
    search: str = Query(""),
    limit: int = Query(10, ge=1, le=50),
    offset: int = Query(0, ge=0),
    user: Optional[dict] = Depends(get_current_user),
):
    admin_club_id = get_admin_club_id(user)
    if not admin_club_id or admin_club_id != club_id:
        raise HTTPException(status_code=403, detail="You can only view your own club's athletes.")

    club_doc = db.collection("clubs").document(club_id).get()
    club_sport = club_doc.to_dict().get("sport") if club_doc.exists else None
    if not club_sport:
        raise HTTPException(status_code=500, detail="Club has no sport configured.")

    search_key = search.strip().lower()
    all_athletes = []
    for doc in db.collection("athletes").where(f"sports.{club_sport}.clubId", "==", club_id).stream():
        data = doc.to_dict()
        first, last = (data.get("firstName") or "").lower(), (data.get("lastName") or "").lower()
        if search_key and search_key not in first and search_key not in last:
            continue
        birthday = data.get("birthday")
        all_athletes.append({
            "id": doc.id,
            "displayName": data.get("displayName") or f"{data.get('firstName','')} {data.get('lastName','')}".strip(),
            "gender": data.get("gender"),
            "country": data.get("country"),
            "birthYear": birthday.year if hasattr(birthday, "year") else None,
            "sports": list((data.get("sports") or {}).keys()),
        })

    all_athletes.sort(key=lambda a: a["displayName"].lower())
    total = len(all_athletes)
    page = all_athletes[offset: offset + limit]
    return {"athletes": page, "total": total, "limit": limit, "offset": offset, "hasMore": offset + limit < total}