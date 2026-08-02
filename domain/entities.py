from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Dict

@dataclass
class Tournament:
    id: str | None
    title: str
    isExternalPublic: Optional[bool]
    location: str
    courtNum: int
    dateTime: datetime
    sport: str
    discipline: str
    settings: dict
    isRegistrationOpen: Optional[bool] = False
    status: str = "active"
    playlistId: Optional[str] = None
    streams: Dict[str, Dict[str, str]] = field(default_factory=dict)

    def toJson(self):
        return {
            "title": self.title,
            "isExternalPublic": self.isExternalPublic,
            "status": self.status,
            "location": self.location,
            "courtNum": self.courtNum,
            "dateTime": self.dateTime,
            "sport": self.sport,
            "discipline": self.discipline,
            "isRegistrationOpen": self.isRegistrationOpen,
            "settings": self.settings,
            "playlistId": self.playlistId,
            "streams": self.streams,
        }
    
    def fromJson(id: str, data) -> Tournament:
        return Tournament(
            id=id,
            title=data["title"],
            isExternalPublic=data.get("isExternalPublic"),
            location=data["location"],
            courtNum=data["courtNum"],
            dateTime=data["dateTime"],
            sport=data["sport"],
            discipline=data["discipline"],
            isRegistrationOpen=data.get("isRegistrationOpen", False),
            settings=data["settings"],
            status=data["status"],
            playlistId=data.get("playlistId"),
            streams=data.get("streams", {}),
        )

@dataclass
class Case:
    id: Optional[str]
    name: str
    tournamentId: Optional[str]
    courtId: Optional[str]

    def toJson(self):
        return {
            "name": self.name,
            "tournamentId": self.tournamentId,
            "courtId": self.courtId,
        }
    
    def fromJson(id: str, data: dict) -> Tournament:
        return Case(
            id=id,
            name=data["name"],
            tournamentId=data.get('tournamentId'),
            courtId=data.get('courtId'),
        )

class StreamKey:
    """
    Represents one YouTube RTMP ingest point (pre-created in YouTube Studio).
    The system tracks which calendar dates it has already been assigned so
    two tournaments on the same day always get different keys.
    """

    def __init__(
        self,
        id: Optional[str],
        stream_key: str,    # The RTMP key string
        stream_id: str,     # YouTube LiveStream resource ID (e.g. "abc123")
        label: str = "",    # Human-readable name, e.g. "Key A"
        used_dates: Optional[List[str]] = None,  # ["2025-07-20", …]
    ):
        self.id = id
        self.stream_key = stream_key
        self.stream_id = stream_id
        self.label = label
        self.used_dates: List[str] = used_dates or []

    # ── helpers ──────────────────────────────────────────────────────────────
    def is_available_on(self, date_str: str) -> bool:
        return date_str not in self.used_dates

    def mark_used(self, date_str: str) -> None:
        if date_str not in self.used_dates:
            self.used_dates.append(date_str)

    # ── serialisation ────────────────────────────────────────────────────────
    def toJson(self) -> dict:
        return {
            "stream_key": self.stream_key,
            "stream_id": self.stream_id,
            "label": self.label,
            "used_dates": self.used_dates,
        }

    @classmethod
    def fromJson(cls, id: str, data: dict) -> "StreamKey":
        return cls(
            id=id,
            stream_key=data.get("stream_key", ""),
            stream_id=data.get("stream_id", ""),
            label=data.get("label", ""),
            used_dates=data.get("used_dates", []),
        )


class ScheduledBroadcast:
    """
    A record of one YouTube live broadcast that was created for a tournament
    court, stored in Firestore after scheduling so it survives restarts.
    """

    def __init__(
        self,
        id: Optional[str],
        tournament_id: str,
        court_number: int,
        broadcast_id: str,   # YouTube broadcast / video ID
        stream_key_id: str,  # FK → StreamKey.id
        playlist_id: str,    # YouTube playlist ID
        scheduled_time: datetime,
        title: str,
        youtube_url: str = "",
    ):
        self.id = id
        self.tournament_id = tournament_id
        self.court_number = court_number
        self.broadcast_id = broadcast_id
        self.stream_key_id = stream_key_id
        self.playlist_id = playlist_id
        self.scheduled_time = scheduled_time
        self.title = title
        self.youtube_url = youtube_url or f"https://youtube.com/watch?v={broadcast_id}"

    def toJson(self) -> dict:
        return {
            "tournament_id": self.tournament_id,
            "court_number": self.court_number,
            "broadcast_id": self.broadcast_id,
            "stream_key_id": self.stream_key_id,
            "playlist_id": self.playlist_id,
            "scheduled_time": self.scheduled_time.isoformat(),
            "title": self.title,
            "youtube_url": self.youtube_url,
        }

    @classmethod
    def fromJson(cls, id: str, data: dict) -> "ScheduledBroadcast":
        raw_time = data.get("scheduled_time")
        if isinstance(raw_time, str):
            scheduled_time = datetime.fromisoformat(raw_time)
        elif raw_time is None:
            scheduled_time = datetime.utcnow()
        else:
            scheduled_time = raw_time

        return cls(
            id=id,
            tournament_id=data.get("tournament_id", ""),
            court_number=data.get("court_number", 0),
            broadcast_id=data.get("broadcast_id", ""),
            stream_key_id=data.get("stream_key_id", ""),
            playlist_id=data.get("playlist_id", ""),
            scheduled_time=scheduled_time,
            title=data.get("title", ""),
            youtube_url=data.get("youtube_url", ""),
        )