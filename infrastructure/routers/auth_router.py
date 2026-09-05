from datetime import timedelta, datetime, timezone
from typing import Optional


from fastapi import APIRouter, Request, Response, HTTPException, Depends, status
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from firebase_admin import auth, firestore

from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from infrastructure.firebase_client import init_firestore
from infrastructure.auth_common import EXPIRES_IN, SESSION_COOKIE_NAME, create_session_jwt, get_admin_club_id, get_current_user, get_user_roles
from usecases.tournament_usecase import GetAllTournamentsUseCase, GetTournamentUseCase

router = APIRouter(tags=["Auth & Showcase"])
templates = Jinja2Templates(directory="templates")
db = init_firestore()


# ── SCHEMAS ───────────────────────────────────────────────────────────────────

class GoogleAuthRequest(BaseModel):
    idToken: str
    inviteToken: Optional[str] = None

class CompleteProfileRequest(BaseModel):
    idToken: str
    firstname: str
    lastname: str
    birthday: str
    inviteToken: Optional[str] = None


# ── JWT SESSION HELPERS ────────────────────────────────────────────────────────


def get_tournament_repo() -> FirebaseTournamentRepository:
    db = init_firestore()
    return FirebaseTournamentRepository(db)


# ── INVITE TOKEN CONSUMER ─────────────────────────────────────────────────────

def consume_invite_token(uid: str, token_str: str) -> Optional[dict]:
    """Validates token, grants Firestore permissions, sets Firebase Custom Claims, and deletes token."""
    if not token_str:
        return None

    token_ref = db.collection("permission_tokens").document(token_str)
    token_doc = token_ref.get()

    if not token_doc.exists:
        raise HTTPException(status_code=400, detail="Invalid or expired invite token.")

    token_data = token_doc.to_dict()

    # Expiration check
    expires_at = token_data.get("expiresAt")
    if expires_at:
        if isinstance(expires_at, str):
            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))

        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)

        if datetime.now(timezone.utc) > expires_at:
            token_ref.delete()
            raise HTTPException(status_code=400, detail="Invite token has expired.")

    club_id = token_data.get("clubId")
    role = token_data.get("role", "USER")
    perm_doc_id = f"{uid}_{club_id}"

    # ── Single-club-admin constraint ───────────────────────────────────
    # An account may hold the ADMIN role in at most one club. Re-consuming
    # an ADMIN invite for a club the user already administers is fine
    # (idempotent); an ADMIN invite for a *different* club is rejected.
    # Non-admin roles (e.g. COACH) are unaffected — a user can still
    # belong to multiple clubs, just not administer more than one.
    if role == "ADMIN":
        existing_docs = db.collection("user_permissions").where("uid", "==", uid).stream()
        for doc in existing_docs:
            data = doc.to_dict()
            if data.get("role") == "ADMIN" and data.get("clubId") != club_id:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"This account already administers another club "
                        f"({data.get('clubName') or data.get('clubId')}). "
                        f"An account can only be ADMIN of one club at a time."
                    ),
                )

    # 1. Store persistent permissions record in Firestore
    db.collection("user_permissions").document(perm_doc_id).set({
        "uid": uid,
        "clubId": club_id,
        "clubName": token_data.get("clubName", ""),
        "role": role,
        "permissions": token_data.get("permissions", []),
        "grantedAt": firestore.SERVER_TIMESTAMP
    }, merge=True)

    # 2. Update Firebase Auth Custom Claims for external parity
    user = auth.get_user(uid)
    existing_claims = user.custom_claims or {}
    roles = existing_claims.get("roles", {})
    roles[club_id] = role
    existing_claims["roles"] = roles
    auth.set_custom_user_claims(uid, existing_claims)

    # 3. Delete consumed token
    token_ref.delete()

    return token_data


# ── API ENDPOINTS ─────────────────────────────────────────────────────────────

@router.post("/api/auth/google")
async def google_auth_check(payload: GoogleAuthRequest, response: Response):
    try:
        # 1. Verify Google ID token using Firebase Auth
        decoded = auth.verify_id_token(payload.idToken)
        uid = decoded.get("uid")
        email = decoded.get("email", "")

        # 2. Consume invite token if present
        if payload.inviteToken:
            consume_invite_token(uid, payload.inviteToken)

        # 3. Check if user profile exists in Firestore
        user_doc = db.collection("users").document(uid).get()

        if user_doc.exists:
            user_data = user_doc.to_dict()
            roles = get_user_roles(uid)

            # 4. Mint local App JWT containing profile + roles
            jwt_payload = {
                "uid": uid,
                "email": email,
                "firstname": user_data.get("firstname", ""),
                "lastname": user_data.get("lastname", ""),
                "photoUrl": user_data.get("photoUrl", ""),
                "roles": roles,
            }
            session_token = create_session_jwt(jwt_payload, EXPIRES_IN)

            response.set_cookie(
                key=SESSION_COOKIE_NAME,
                value=session_token,
                max_age=int(EXPIRES_IN.total_seconds()),
                httponly=True,
                secure=False,  # Set to True in production with HTTPS
                samesite="lax",
            )
            return {"exists": True, "redirectUrl": "/"}
        else:
            return {"exists": False, "redirectUrl": "/register"}

    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Authentication failed: {str(e)}")


@router.post("/api/auth/complete-profile")
async def complete_profile(payload: CompleteProfileRequest, response: Response):
    try:
        # 1. Verify Google ID token
        decoded = auth.verify_id_token(payload.idToken)
        uid = decoded.get("uid")
        email = decoded.get("email")
        photo_url = decoded.get("picture", "")
        firstname = payload.firstname.strip()
        lastname = payload.lastname.strip()

        # 2. Save profile in Firestore
        db.collection("users").document(uid).set({
            "email": email,
            "photoUrl": photo_url,
            "firstname": firstname,
            "lastname": lastname,
            "birthday": payload.birthday,
            "createdAt": firestore.SERVER_TIMESTAMP
        })

        # 3. Consume invite token if provided
        if payload.inviteToken:
            consume_invite_token(uid, payload.inviteToken)

        # 4. Fetch fresh roles map
        roles = get_user_roles(uid)

        # 5. Mint local App JWT with complete details
        jwt_payload = {
            "uid": uid,
            "email": email,
            "firstname": firstname,
            "lastname": lastname,
            "photoUrl": photo_url,
            "roles": roles,
        }
        session_token = create_session_jwt(jwt_payload, EXPIRES_IN)

        response.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=session_token,
            max_age=int(EXPIRES_IN.total_seconds()),
            httponly=True,
            secure=False,  # Set to True in production with HTTPS
            samesite="lax",
        )

        return {"message": "Profile complete", "redirectUrl": "/"}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/logout")
async def logout(response: Response):
    """Clears session cookie and redirects to login."""
    res = RedirectResponse(url="/login")
    res.delete_cookie(SESSION_COOKIE_NAME)
    return res


# ── PAGES ─────────────────────────────────────────────────────────────────────

@router.get("/")
async def main_page(
    request: Request, 
    user: Optional[dict] = Depends(get_current_user),
    tournament_repo=Depends(get_tournament_repo),
):
    """Renders main dashboard with tournaments."""
    tournaments = tournament_repo.getTournamentsPaginated(status="active", limit=10, offset=0, isExternalPublic=True)

    return templates.TemplateResponse(request, "main.html", {
        "request": request,
        "user": user,
        "tournaments": tournaments
    })


@router.get("/login")
async def login_page(request: Request, user: Optional[dict] = Depends(get_current_user)):
    if user:
        return RedirectResponse(url="/")
    return templates.TemplateResponse(request, "login.html", {"request": request, "user": None})


@router.get("/register")
async def register_page(request: Request, user: Optional[dict] = Depends(get_current_user)):
    return templates.TemplateResponse(request, "register.html", {"request": request, "user": user})


@router.get("/tournaments/{tournament_id}")
async def tournament_detail_page(
    tournament_id: str,
    request: Request,
    user: Optional[dict] = Depends(get_current_user),
    tournament_repo=Depends(get_tournament_repo),
):
    """Tournament detail view fetched from Firestore."""
    use_case = GetTournamentUseCase(tournament_repo)
    tournament = use_case.execute(tournament_id)

    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")

    return templates.TemplateResponse(request, "tournament.html", {
        "request": request,
        "user": user,
        "tournament": tournament,
        "admin_club_id": get_admin_club_id(user),
    })

@router.get("/athletes/new")
async def render_create_athlete_page(
    request: Request,
    user: Optional[dict] = Depends(get_current_user)
):
    admin_club_id = get_admin_club_id(user)
    club_country = ""
    club_sport = ""

    if admin_club_id:
        club_doc = db.collection("clubs").document(admin_club_id).get()
        if club_doc.exists:
            data = club_doc.to_dict()
            club_country = data.get("country", "").upper()
            club_sport = data.get("sport", "").lower()

    return templates.TemplateResponse(request, "create_athlete.html", {
        "request": request,
        "club_country": club_country,
        "club_sport": club_sport
    })