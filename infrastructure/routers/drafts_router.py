import re
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from firebase_admin import firestore

from infrastructure.auth_common import db, get_current_user, get_admin_club_id

router = APIRouter()

# ── TOURNAMENT REQUESTS (DRAFTS) ─────────────────────────────────────────────
# Backs request_tournament.html. Anyone — logged in or not — can submit a
# request; it lands in tournament_draft/{autoId} with status "pending" for
# staff to review. Nothing here creates a real tournaments/{id} doc.

# Mirrors COURT_DISCIPLINES in request_tournament.html — keep in sync.
COURT_DISCIPLINES = {
    "kyorugi": "Kyorugi",
    "livestream": "Livestream",
    "livestream_ivr": "Livestream + IVR",
    "poomsae": "Poomsae",
}
MAX_DAYS = 7
MAX_COURTS_PER_DAY = 20
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class DraftRequester(BaseModel):
    firstname: str = ""
    lastname: str = ""
    email: str = ""


class DraftCourt(BaseModel):
    discipline: str


class DraftDay(BaseModel):
    courts: List[DraftCourt]


class CreateTournamentDraftRequest(BaseModel):
    # Only required for guests — ignored when a session cookie is present.
    requester: Optional[DraftRequester] = None
    title: str
    startDate: str  # YYYY-MM-DD from <input type="date">
    state: str
    city: str
    days: List[DraftDay]


def _resolve_requester(user: Optional[dict], payload: CreateTournamentDraftRequest) -> dict:
    if user:
        # Session JWT (see auth_router.google_auth_check) carries
        # uid / email / firstname / lastname.
        return {
            "isAuthenticated": True,
            "uid": user.get("uid"),
            "email": user.get("email"),
            "firstname": user.get("firstname", ""),
            "lastname": user.get("lastname", ""),
            "clubId": get_admin_club_id(user),
        }

    r = payload.requester or DraftRequester()
    first, last, email = r.firstname.strip(), r.lastname.strip(), r.email.strip().lower()
    if not first or not last:
        raise HTTPException(status_code=400, detail="First and last name are required when not logged in.")
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="A valid email address is required when not logged in.")
    return {
        "isAuthenticated": False,
        "uid": None,
        "email": email,
        "firstname": first,
        "lastname": last,
        "clubId": None,
    }


@router.post("/tournament-drafts", status_code=status.HTTP_201_CREATED)
def create_tournament_draft_endpoint(
    payload: CreateTournamentDraftRequest,
    user: Optional[dict] = Depends(get_current_user),
):
    title = payload.title.strip()
    city = payload.city.strip()
    state = payload.state.strip().upper()
    if not title:
        raise HTTPException(status_code=400, detail="Tournament name is required.")
    if not city:
        raise HTTPException(status_code=400, detail="City is required.")
    if not state:
        raise HTTPException(status_code=400, detail="State is required.")

    try:
        start_dt = datetime.strptime(payload.startDate, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid start date. Expected YYYY-MM-DD.")
    if start_dt.date() < datetime.now(timezone.utc).date():
        raise HTTPException(status_code=400, detail="Start date can't be in the past.")

    if not payload.days:
        raise HTTPException(status_code=400, detail="At least one day is required.")
    if len(payload.days) > MAX_DAYS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_DAYS} days are allowed.")

    requester = _resolve_requester(user, payload)

    days_doc = []
    for day_index, day in enumerate(payload.days):
        if not day.courts:
            raise HTTPException(status_code=400, detail=f"Day {day_index + 1} has no courts.")
        if len(day.courts) > MAX_COURTS_PER_DAY:
            raise HTTPException(status_code=400, detail=f"Day {day_index + 1} has more than {MAX_COURTS_PER_DAY} courts.")

        courts_doc = []
        for court_index, court in enumerate(day.courts):
            discipline = court.discipline.strip().lower()
            if discipline not in COURT_DISCIPLINES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Day {day_index + 1}, court {court_index + 1}: unknown discipline '{court.discipline}'.",
                )
            courts_doc.append({
                "courtNumber": court_index + 1,
                "discipline": discipline,
                "disciplineLabel": COURT_DISCIPLINES[discipline],
            })

        days_doc.append({
            "dayNumber": day_index + 1,
            "date": (start_dt + timedelta(days=day_index)).strftime("%Y-%m-%d"),
            "courtCount": len(courts_doc),
            "courts": courts_doc,
        })

    draft = {
        "title": title,
        "startDate": start_dt,  # Firestore Timestamp, same as tournaments.dateTime
        "endDate": start_dt + timedelta(days=len(days_doc) - 1),
        "state": state,
        "city": city,
        "days": days_doc,
        "dayCount": len(days_doc),
        # Peak courts on any single day — what tournaments.courtNum would
        # become if this draft is approved.
        "courtNum": max(d["courtCount"] for d in days_doc),
        "requester": requester,
        "status": "pending",
        "createdAt": firestore.SERVER_TIMESTAMP,
    }

    _, doc_ref = db.collection("tournament_draft").add(draft)
    return {"id": doc_ref.id, "message": "Tournament request submitted"}