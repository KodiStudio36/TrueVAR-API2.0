"""
infrastructure/routers/youtube_router.py
──────────────────────────────────────────
Mount this router in your main FastAPI app.  It provides:

  GET  /youtube/auth                    → redirect to Google OAuth
  GET  /youtube/callback                → handle OAuth return
  GET  /api/youtube/status              → is a YouTube account connected?
  POST /api/youtube/schedule/{t_id}     → schedule streams for a tournament
  GET  /api/tournaments/{t_id}/broadcasts → list stored broadcasts

  GET    /api/stream-keys               → list all stored stream keys
  POST   /api/stream-keys               → add a stream key
  DELETE /api/stream-keys/{key_id}      → remove a stream key

In main.py:
    from infrastructure.routers.youtube_router import router as yt_router
    app.include_router(yt_router)
"""

import base64
import json
import os
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from adapters.database.firebase_stream_key_repository import FirebaseStreamKeyRepository
from adapters.database.firebase_tournament_repository import FirebaseTournamentRepository
from domain.entities import StreamKey
from domain.ports.tournament_port import TournamentPort
from infrastructure.firebase_client import init_firestore
from services.youtube_service import YouTubeService, build_auth_url, exchange_code_for_tokens
from usecases.youtube_usecase import (
    AddStreamKeyUseCase,
    DeleteStreamKeyUseCase,
    GetStreamKeysUseCase,
    ScheduleStreamsUseCase,
)
from fastapi import File, UploadFile
from typing import List, Optional
from usecases.youtube_usecase import ThumbnailData

router = APIRouter()

# Resolved once at module load; safe for single-process servers.
REDIRECT_URI: str = os.getenv(
    "YOUTUBE_REDIRECT_URI", "http://localhost:8000/youtube/callback"
)


# ── Dependency helpers ────────────────────────────────────────────────────────

def _db():
    return init_firestore()


def get_stream_key_repo(db=Depends(_db)) -> FirebaseStreamKeyRepository:
    return FirebaseStreamKeyRepository(db)


def get_tournament_repo(db=Depends(_db)) -> FirebaseTournamentRepository:
    return FirebaseTournamentRepository(db)


# ══════════════════════════════════════════════════════════════════════════════
# OAuth endpoints
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/youtube/auth", tags=["YouTube OAuth"])
async def youtube_auth(tournament_id: str = Query(..., description="Tournament to return to after auth")):
    """
    Redirect the browser to Google's OAuth consent screen.
    The tournament_id is embedded in the state so we know where to return.
    """
    state_payload = json.dumps({"tournament_id": tournament_id})
    # URL-safe base64, no padding (we add it back in the callback)
    state = base64.urlsafe_b64encode(state_payload.encode()).decode().rstrip("=")
    return RedirectResponse(build_auth_url(REDIRECT_URI, state))


@router.get("/youtube/callback", tags=["YouTube OAuth"])
async def youtube_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    db=Depends(_db),
):
    """
    Google redirects here after the user grants (or denies) access.
    Exchanges the auth code for tokens and stores them in Firestore.
    """
    if error:
        return RedirectResponse(f"/dashboard?msg=YouTube+authentication+was+denied")

    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state parameter.")

    # Decode state → tournament_id
    try:
        padding = 4 - len(state) % 4
        state_data = json.loads(
            base64.urlsafe_b64decode(state + "=" * padding).decode()
        )
        tournament_id: str = state_data["tournament_id"]
    except Exception:
        raise HTTPException(status_code=400, detail="Malformed state parameter.")

    # Exchange code for tokens
    try:
        token_data = await exchange_code_for_tokens(code, REDIRECT_URI)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Token exchange failed: {exc}")

    if "error" in token_data:
        raise HTTPException(
            status_code=400,
            detail=f"Google token error: {token_data['error']}",
        )

    # Persist tokens (only token + refresh_token; client creds come from env)
    db.collection("youtube_auth").document("credentials").set({
        "token": token_data.get("access_token"),
        "refresh_token": token_data.get("refresh_token"),
    })

    return RedirectResponse(
        f"/dashboard/tournaments/{tournament_id}?msg=YouTube+connected+successfully"
    )


# ══════════════════════════════════════════════════════════════════════════════
# YouTube Status
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/api/youtube/status", tags=["YouTube"])
async def youtube_status(db=Depends(_db)):
    """Returns whether a YouTube account is currently linked."""
    doc = db.collection("youtube_auth").document("credentials").get()
    connected = doc.exists and bool((doc.to_dict() or {}).get("refresh_token"))
    return {"connected": connected}


@router.delete("/api/youtube/disconnect", tags=["YouTube"])
async def youtube_disconnect(db=Depends(_db)):
    """Remove stored YouTube credentials."""
    db.collection("youtube_auth").document("credentials").delete()
    return {"message": "YouTube account disconnected."}


# ══════════════════════════════════════════════════════════════════════════════
# Schedule Streams
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/api/youtube/schedule/{tournament_id}", tags=["YouTube"])
async def schedule_tournament_streams(
    tournament_id: str,
    thumbnails: Optional[List[UploadFile]] = File(None),
    stream_key_repo=Depends(get_stream_key_repo),
    tournament_repo: TournamentPort=Depends(get_tournament_repo),
    db=Depends(_db),
):
    tournament = tournament_repo.getTournament(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    if tournament.status == "archived":
        raise HTTPException(status_code=409, detail="Cannot schedule streams for an archived tournament.")

    creds_doc = db.collection("youtube_auth").document("credentials").get()
    if not creds_doc.exists or not (creds_doc.to_dict() or {}).get("refresh_token"):
        raise HTTPException(status_code=401, detail="YouTube account is not connected.")

    # ── Read uploaded files into memory ──
    thumb_data_list = []
    if thumbnails:
        for tf in thumbnails:
            content = await tf.read()
            thumb_data_list.append(ThumbnailData(mimetype=tf.content_type, content=content))

    yt = YouTubeService(creds_doc.to_dict())

    try:
        result = ScheduleStreamsUseCase(
            tournament_repo=tournament_repo,
            stream_key_repo=stream_key_repo,
            youtube_service=yt,
        ).execute(tournament_id, thumbnails=thumb_data_list)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    db.collection("youtube_auth").document("credentials").update(yt.get_updated_credentials())

    # 1. Save detailed records in scheduled_broadcasts (for admin / stream keys)
    streams_map = {}
    playlist_id = None

    for b in result["broadcasts"]:
        db.collection("scheduled_broadcasts").add({
            "tournament_id": tournament_id,
            "court_number": b["court_number"],
            "broadcast_id": b["broadcast_id"],
            "stream_key": b["stream_key"],
            "playlist_id": b["playlist_id"],
            "title": b["title"],
            "youtube_url": b["youtube_url"],
        })

        # Build public stream object for court_N
        court_key = f"court_{b['court_number']}"
        streams_map[court_key] = {
            "youtubeUrl": b["youtube_url"]
        }
        if not playlist_id and b.get("playlist_id"):
            playlist_id = b["playlist_id"]

    # 2. Denormalize streams & playlistId into the tournament document
    db.collection("tournaments").document(tournament_id).update({
        "playlistId": playlist_id,
        "streams": streams_map
    })

    return result


# ══════════════════════════════════════════════════════════════════════════════
# Broadcasts (read)
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/api/tournaments/{tournament_id}/broadcasts", tags=["YouTube"])
async def get_tournament_broadcasts(tournament_id: str, db=Depends(_db)):
    """List all previously scheduled broadcasts for a tournament."""
    docs = (
        db.collection("scheduled_broadcasts")
        .where("tournament_id", "==", tournament_id)
        .stream()
    )
    rows = []
    for doc in docs:
        data = doc.to_dict()
        rows.append(
            {
                "id": doc.id,
                "court_number": data.get("court_number"),
                "title": data.get("title"),
                "youtube_url": data.get("youtube_url"),
                "broadcast_id": data.get("broadcast_id"),
                "playlist_id": data.get("playlist_id"),
            }
        )
    rows.sort(key=lambda x: x.get("court_number") or 0)
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# Stream Key management
# ══════════════════════════════════════════════════════════════════════════════

class AddStreamKeyRequest(BaseModel):
    stream_key: str
    stream_id: str
    label: str = ""


@router.get("/api/stream-keys", tags=["Stream Keys"])
async def list_stream_keys(repo=Depends(get_stream_key_repo)):
    keys = GetStreamKeysUseCase(repo).execute()
    return [
        {
            "id": k.id,
            "label": k.label,
            "stream_key": k.stream_key,
            "stream_id": k.stream_id,
            "used_dates": k.used_dates,
        }
        for k in keys
    ]


@router.post("/api/stream-keys", status_code=201, tags=["Stream Keys"])
async def add_stream_key(payload: AddStreamKeyRequest, repo=Depends(get_stream_key_repo)):
    AddStreamKeyUseCase(repo).execute(
        stream_key=payload.stream_key,
        stream_id=payload.stream_id,
        label=payload.label,
    )
    return {"message": "Stream key added."}


@router.delete("/api/stream-keys/{key_id}", status_code=204, tags=["Stream Keys"])
async def delete_stream_key(key_id: str, repo=Depends(get_stream_key_repo)):
    DeleteStreamKeyUseCase(repo).execute(key_id)
    return {}