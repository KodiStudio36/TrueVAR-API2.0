"""
services/youtube_service.py
───────────────────────────
Thin wrapper around the YouTube Data API v3 for live-streaming operations.

We deliberately avoid google-auth-oauthlib's Flow object for the server
OAuth callback because it performs a state-binding check that requires the
same in-process Flow instance that initiated the redirect — which is not
possible in a stateless server.  Instead we:

  1. Build the auth URL manually with urllib.parse.urlencode
  2. Exchange the code via a direct httpx POST to the token endpoint
  3. Construct a google.oauth2.credentials.Credentials from the token data

Required env vars:
  GOOGLE_CLIENT_ID      – from Google Cloud Console
  GOOGLE_CLIENT_SECRET  – from Google Cloud Console
  YOUTUBE_REDIRECT_URI  – full callback URL registered in Cloud Console,
                          e.g. https://yourdomain.com/youtube/callback

Required pip packages:
  google-api-python-client
  google-auth
  httpx
"""

import io
from googleapiclient.http import MediaIoBaseUpload
import os
from datetime import datetime
from typing import Any, Dict
from urllib.parse import urlencode

import httpx
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# ── constants ──────────────────────────────────────────────────────────────────

SCOPES = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]
GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"


# ── OAuth helpers ──────────────────────────────────────────────────────────────

def build_auth_url(redirect_uri: str, state: str) -> str:
    """Return the Google OAuth consent-screen URL."""
    print(os.getenv("GOOGLE_CLIENT_ID", ""))
    params = {
        "client_id": os.getenv("GOOGLE_CLIENT_ID", ""),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "state": state,
        "access_type": "offline",   # forces refresh_token to be issued
        "prompt": "consent",        # always re-prompt so refresh_token is fresh
    }
    return f"{GOOGLE_AUTH_ENDPOINT}?{urlencode(params)}"


async def exchange_code_for_tokens(code: str, redirect_uri: str) -> dict:
    """
    Exchange an authorisation code for access + refresh tokens.
    Returns the raw JSON from the token endpoint.
    Raises httpx.HTTPStatusError on failure.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            GOOGLE_TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": os.getenv("GOOGLE_CLIENT_ID", ""),
                "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", ""),
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        return resp.json()


# ── YouTube API service ────────────────────────────────────────────────────────

class YouTubeService:
    """
    Wraps the YouTube Data API v3 for live-streaming.

    Pass the dict that was stored in Firestore (keys: token, refresh_token).
    The constructor auto-refreshes an expired access token.
    """

    def __init__(self, credentials_dict: dict):
        self._creds = Credentials(
            token=credentials_dict.get("token"),
            refresh_token=credentials_dict.get("refresh_token"),
            token_uri=GOOGLE_TOKEN_ENDPOINT,
            client_id=os.getenv("GOOGLE_CLIENT_ID", ""),
            client_secret=os.getenv("GOOGLE_CLIENT_SECRET", ""),
            scopes=SCOPES,
        )
        if self._creds.expired and self._creds.refresh_token:
            self._creds.refresh(Request())

        self._yt = build("youtube", "v3", credentials=self._creds)

    def get_updated_credentials(self) -> dict:
        """Call after any API work so the (possibly refreshed) token is persisted."""
        return {
            "token": self._creds.token,
            "refresh_token": self._creds.refresh_token,
        }

    # ── LiveBroadcasts ────────────────────────────────────────────────────────

    def create_broadcast(
        self,
        title: str,
        scheduled_start: datetime,
        description: str = "",
    ) -> Dict[str, Any]:
        """Insert a new YouTube LiveBroadcast resource and return the API response."""
        body = {
            "snippet": {
                "title": title,
                # YouTube requires UTC ISO-8601 with milliseconds
                "scheduledStartTime": scheduled_start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "description": description,
            },
            "status": {
                "privacyStatus": "public",
                "selfDeclaredMadeForKids": False,
            },
            "contentDetails": {
                "enableAutoStart": True,
                "enableAutoStop": True,
                "recordFromStart": True,
                "enableDvr": True,
            },
        }
        return (
            self._yt.liveBroadcasts()
            .insert(part="snippet,status,contentDetails", body=body)
            .execute()
        )

    def bind_broadcast_to_stream(
        self, broadcast_id: str, stream_id: str
    ) -> Dict[str, Any]:
        """Bind a LiveBroadcast to a pre-existing LiveStream (RTMP ingest)."""
        return (
            self._yt.liveBroadcasts()
            .bind(part="id,contentDetails", id=broadcast_id, streamId=stream_id)
            .execute()
        )

    # ── Playlists ─────────────────────────────────────────────────────────────

    def create_playlist(self, title: str, description: str = "") -> Dict[str, Any]:
        """Create a public playlist and return the API response."""
        body = {
            "snippet": {"title": title, "description": description},
            "status": {"privacyStatus": "public"},
        }
        return (
            self._yt.playlists()
            .insert(part="snippet,status", body=body)
            .execute()
        )

    def add_to_playlist(self, playlist_id: str, video_id: str) -> Dict[str, Any]:
        """Append a video (or broadcast) to a playlist."""
        body = {
            "snippet": {
                "playlistId": playlist_id,
                "resourceId": {"kind": "youtube#video", "videoId": video_id},
            }
        }
        return (
            self._yt.playlistItems()
            .insert(part="snippet", body=body)
            .execute()
        )
    
    def set_thumbnail(self, video_id: str, image_bytes: bytes, mimetype: str = "image/jpeg") -> Dict[str, Any]:
        """Upload a custom thumbnail for a video/broadcast."""
        media = MediaIoBaseUpload(io.BytesIO(image_bytes), mimetype=mimetype, resumable=True)
        return self._yt.thumbnails().set(
            videoId=video_id,
            media_body=media
        ).execute()