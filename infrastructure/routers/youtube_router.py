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

  POST /api/youtube/stream-position     → current video position of a
                                          court's live stream (court devices)

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
    "YOUTUBE_REDIRECT_URI", "https://truevar.eu/youtube/callback"
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


# ══════════════════════════════════════════════════════════════════════════════
# Stream position — "where in this court's YouTube video are we right now?"
# ══════════════════════════════════════════════════════════════════════════════
#
# Called by the court devices (Poomsae Control Panel plugin) every time a
# poomsae starts, so the app can later open the recording at that moment.
#
# YouTube has NO API that returns a live stream's current playback
# position, so it is computed here:
#
#     position = (now − broadcast.actualStartTime) − time the stream was down
#
#   • actualStartTime: liveBroadcasts.list (1 quota unit), cached per
#     broadcast — it never changes once the broadcast is live.
#   • time down: the broadcasts are set NOT to end on disconnect, so a
#     10-minute outage keeps the same video but those 10 minutes never
#     reach the recording — every later poomsae would be 10 min off. A
#     background monitor polls liveStreams.list for EVERY watched court's
#     stream in ONE call (1 unit per poll, however many courts) and records
#     each outage (streamStatus not "active"). Outages are persisted to
#     youtube_sync/{broadcastId}, so a server restart doesn't lose them.
#     During an outage the position stays frozen at the moment it dropped.
#
# Quota (10,000 units/day by default): one poll every
# YOUTUBE_SYNC_POLL_SECONDS (default 15 s) while any court has asked in
# the last 2 h ≈ 240 units/hour, plus ~1 unit per broadcast per day.
#
# Firestore reads are cached: the court → broadcast mapping for
# YOUTUBE_SYNC_MAPPING_TTL seconds (default 10 min), the OAuth credentials
# for 30 min. A request normally causes no Firestore read and no YouTube
# call at all.
#
# Auth: header X-Internal-Secret must equal env INTERNAL_SECRET (same
# secret the Cloud Functions calls use).
#
# Precision: ± one poll interval per outage, plus the camera → encoder →
# YouTube delay (a few seconds — compensate with YOUTUBE_SYNC_LEAD_SECONDS,
# default 3, subtracted from every position so a link starts just early).

import asyncio
import time
from datetime import datetime, timezone

from fastapi import Header

SYNC_POLL_SECONDS = float(os.getenv("YOUTUBE_SYNC_POLL_SECONDS", "15"))
SYNC_MAPPING_TTL = float(os.getenv("YOUTUBE_SYNC_MAPPING_TTL", "600"))
SYNC_LEAD_SECONDS = float(os.getenv("YOUTUBE_SYNC_LEAD_SECONDS", "3"))
SYNC_WATCH_SECONDS = 2 * 3600       # stop polling a court nobody asked about for 2 h
SYNC_CREDS_TTL = 1800


def _parse_iso(value) -> Optional[float]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.timestamp()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iso(ts: Optional[float]) -> Optional[str]:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


class _BroadcastClock:
    """Everything known about one court's broadcast: when it went live,
    which ingest stream feeds it, and every outage so far."""

    def __init__(self, broadcast_id: str):
        self.broadcast_id = broadcast_id
        self.stream_id: Optional[str] = None
        self.started_at: Optional[float] = None     # actualStartTime
        self.ended_at: Optional[float] = None       # actualEndTime
        self.gaps: list = []                        # [[from, to], …] closed outages
        self.down_since: Optional[float] = None     # open outage
        self.stream_status: Optional[str] = None
        self.last_asked: float = 0.0
        self.loaded = False                         # gaps read from Firestore

    def lost_before(self, t: float) -> float:
        lost = sum(max(0.0, min(b, t) - a) for a, b in self.gaps if a < t)
        if self.down_since is not None and self.down_since < t:
            lost += t - self.down_since
        return lost

    def position_at(self, t: float) -> Optional[float]:
        if self.started_at is None or t < self.started_at:
            return None
        if self.ended_at is not None:
            t = min(t, self.ended_at)
        return max(0.0, (t - self.started_at) - self.lost_before(t))


class StreamPositionService:
    def __init__(self):
        self._clocks: dict = {}          # broadcastId -> _BroadcastClock
        self._mapping: dict = {}         # (tournamentId, court) -> (broadcastId | None, fetched_at)
        self._client_at = 0.0
        self._yt = None
        self._monitor: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    # ── YouTube client (OAuth credentials from Firestore, cached) ───────
    def _youtube(self, db) -> YouTubeService:
        """YouTubeService from the stored OAuth credentials — rebuilt every
        SYNC_CREDS_TTL so the Firestore credentials doc isn't read per request.
        (The access token itself refreshes inside google-auth as needed.)"""
        if self._yt is not None and time.time() - self._client_at < SYNC_CREDS_TTL:
            return self._yt
        creds = db.collection("youtube_auth").document("credentials").get()
        if not creds.exists or not (creds.to_dict() or {}).get("refresh_token"):
            raise HTTPException(status_code=401, detail="YouTube account is not connected.")
        self._yt, self._client_at = YouTubeService(creds.to_dict()), time.time()
        self._save_refreshed_credentials(db)
        return self._yt

    def _save_refreshed_credentials(self, db):
        if self._yt is not None and hasattr(self._yt, "get_updated_credentials"):
            try:
                db.collection("youtube_auth").document("credentials").update(self._yt.get_updated_credentials())
            except Exception:
                pass

    # ── tournament + court → broadcast (Firestore, cached) ──────────────
    def _broadcast_for(self, db, tournament_id: str, court: str) -> Optional[str]:
        key = (tournament_id, str(court))
        cached = self._mapping.get(key)
        if cached and time.time() - cached[1] < SYNC_MAPPING_TTL:
            return cached[0]
        broadcast_id = None
        try:
            court_number = int(court)
        except (TypeError, ValueError):
            court_number = None
        for doc in db.collection("scheduled_broadcasts").where("tournament_id", "==", tournament_id).stream():
            data = doc.to_dict() or {}
            if data.get("court_number") == court_number or str(data.get("court_number")) == str(court):
                broadcast_id = data.get("broadcast_id")   # == the YouTube video id
        self._mapping[key] = (broadcast_id, time.time())
        return broadcast_id

    # ── broadcast details (YouTube, until known) ────────────────────────
    def _refresh_broadcast(self, db, clock: _BroadcastClock):
        if not clock.loaded:
            doc = db.collection("youtube_sync").document(clock.broadcast_id).get()
            data = doc.to_dict() if doc.exists else {}
            clock.gaps = [[g.get("from"), g.get("to")] for g in (data or {}).get("gaps", []) if g.get("from") and g.get("to")]
            clock.down_since = (data or {}).get("downSince")
            clock.loaded = True
        if clock.started_at is not None and clock.stream_id is not None:
            return
        timing = self._youtube(db).get_broadcast_timing(clock.broadcast_id)
        if not timing:
            raise HTTPException(status_code=404, detail=f"YouTube broadcast {clock.broadcast_id} not found.")
        clock.started_at = _parse_iso(timing.get("actualStartTime"))
        clock.ended_at = _parse_iso(timing.get("actualEndTime"))
        clock.stream_id = timing.get("boundStreamId")

    def _persist(self, db, clock: _BroadcastClock):
        db.collection("youtube_sync").document(clock.broadcast_id).set({
            "broadcastId": clock.broadcast_id,
            "actualStartTime": _iso(clock.started_at),
            "gaps": [{"from": a, "to": b} for a, b in clock.gaps],
            "downSince": clock.down_since,
            "lostSeconds": round(clock.lost_before(time.time()), 1),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        })

    # ── outage monitor: ONE liveStreams.list call for every watched court ──
    def _poll_once(self, db):
        now = time.time()
        watched = [c for c in self._clocks.values()
                   if c.stream_id and c.started_at and c.ended_at is None and now - c.last_asked < SYNC_WATCH_SECONDS]
        if not watched:
            return False
        by_stream = {}
        for c in watched:
            by_stream.setdefault(c.stream_id, []).append(c)
        ids = list(by_stream)
        for i in range(0, len(ids), 50):
            statuses = self._youtube(db).get_stream_statuses(ids[i:i + 50])
            for sid in ids[i:i + 50]:
                for c in by_stream[sid]:
                    self._apply_status(db, c, statuses.get(sid, "missing"), now)
        return True

    def _apply_status(self, db, clock: _BroadcastClock, status: Optional[str], now: float):
        clock.stream_status = status
        receiving = status == "active"
        if not receiving and clock.down_since is None:
            clock.down_since = now
            self._persist(db, clock)
        elif receiving and clock.down_since is not None:
            clock.gaps.append([clock.down_since, now])
            clock.down_since = None
            self._persist(db, clock)

    async def _monitor_loop(self, db):
        while True:
            try:
                active = await asyncio.to_thread(self._poll_once, db)
            except Exception as exc:
                print(f"[stream-position] monitor poll failed: {exc}")
                active = True
            if not active:
                self._monitor = None
                return
            await asyncio.sleep(SYNC_POLL_SECONDS)

    def _ensure_monitor(self, db):
        if self._monitor is None or self._monitor.done():
            self._monitor = asyncio.create_task(self._monitor_loop(db))

    # ── the request ─────────────────────────────────────────────────────
    async def position(self, db, tournament_id: str, court: str, at: Optional[float]) -> dict:
        now = time.time()
        async with self._lock:
            broadcast_id = await asyncio.to_thread(self._broadcast_for, db, tournament_id, court)
            if not broadcast_id:
                raise HTTPException(status_code=404, detail=f"No YouTube broadcast scheduled for court {court}.")
            clock = self._clocks.get(broadcast_id) or self._clocks.setdefault(broadcast_id, _BroadcastClock(broadcast_id))
            clock.last_asked = now
            await asyncio.to_thread(self._refresh_broadcast, db, clock)
            if clock.started_at is not None and clock.ended_at is None:
                self._ensure_monitor(db)
        t = at if at is not None else now
        pos = clock.position_at(t)
        result = {
            "videoId": broadcast_id,
            "live": clock.started_at is not None and clock.ended_at is None,
            "streamStatus": clock.stream_status,
            "down": clock.down_since is not None and clock.down_since <= t,
            "lostSeconds": round(clock.lost_before(t), 1),
            "actualStartTime": _iso(clock.started_at),
            "serverTime": _iso(now),
            "at": _iso(t),
        }
        if pos is not None:
            seconds = max(0, int(pos - SYNC_LEAD_SECONDS))
            result["t"] = seconds
            result["url"] = f"https://www.youtube.com/watch?v={broadcast_id}&t={seconds}s"
        return result


stream_positions = StreamPositionService()


class StreamPositionRequest(BaseModel):
    tournamentId: str
    courtId: str
    # Optional ISO time to compute the position for (a device that couldn't
    # reach the server re-asks later with the time the poomsae started).
    at: Optional[str] = None


@router.post("/api/youtube/stream-position", tags=["YouTube"])
async def youtube_stream_position(
    payload: StreamPositionRequest,
    x_internal_secret: Optional[str] = Header(None),
    db=Depends(_db),
):
    secret = os.getenv("INTERNAL_SECRET")
    if not secret or x_internal_secret != secret:
        raise HTTPException(status_code=401, detail="Invalid internal secret.")
    at = _parse_iso(payload.at) if payload.at else None
    return await stream_positions.position(db, payload.tournamentId, payload.courtId, at)