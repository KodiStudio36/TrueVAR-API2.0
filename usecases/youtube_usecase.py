"""
usecases/youtube_usecase.py
───────────────────────────
Use-cases for stream key management and YouTube live-stream scheduling.
"""

from typing import Any, Dict, List, Optional
from dataclasses import dataclass

from domain.entities import ScheduledBroadcast, StreamKey
from domain.ports.stream_key_port import StreamKeyPort
from domain.ports.tournament_port import TournamentPort
from services.youtube_service import YouTubeService


# ── Stream Key CRUD ────────────────────────────────────────────────────────────

class AddStreamKeyUseCase:
    def __init__(self, repo: StreamKeyPort):
        self.repo = repo

    def execute(self, stream_key: str, stream_id: str, label: str) -> None:
        key = StreamKey(id=None, stream_key=stream_key, stream_id=stream_id, label=label)
        self.repo.addStreamKey(key)


class GetStreamKeysUseCase:
    def __init__(self, repo: StreamKeyPort):
        self.repo = repo

    def execute(self) -> List[StreamKey]:
        return self.repo.getStreamKeys()


class DeleteStreamKeyUseCase:
    def __init__(self, repo: StreamKeyPort):
        self.repo = repo

    def execute(self, key_id: str) -> None:
        self.repo.deleteStreamKey(key_id)

@dataclass
class ThumbnailData:
    mimetype: str
    content: bytes


# ── YouTube Scheduling ────────────────────────────────────────────────────────

class ScheduleStreamsUseCase:
    def __init__(
        self,
        tournament_repo: TournamentPort,
        stream_key_repo: StreamKeyPort,
        youtube_service: YouTubeService,
    ):
        self.tournament_repo = tournament_repo
        self.stream_key_repo = stream_key_repo
        self.yt = youtube_service

    def execute(self, tournament_id: str, thumbnails: Optional[List[ThumbnailData]] = None) -> Dict[str, Any]:
        tournament = self.tournament_repo.getTournament(tournament_id) 
        if not tournament:
            raise ValueError(f"Tournament '{tournament_id}' not found.")

        date_str = tournament.dateTime.strftime("%Y-%m-%d")
        court_count: int = tournament.courtNum

        # Validate thumbnail count if provided
        if thumbnails and len(thumbnails) != court_count:
            raise ValueError(
                f"Expected exactly {court_count} thumbnails (one for each court), "
                f"but received {len(thumbnails)}."
            )

        available = self.stream_key_repo.getAvailableKeysForDate(date_str)
        if len(available) < court_count:
            raise ValueError(
                f"Not enough free stream keys for {date_str}. "
                f"Need {court_count}, only {len(available)} available."
            )

        selected_keys = available[:court_count]

        numbering = tournament.settings.get("numbering", "Court")
        venue = tournament.settings.get("venueName", tournament.location)

        playlist_resp = self.yt.create_playlist(
            title=f"{tournament.title}",
            description=(
                f"🏆 {tournament.title}\n\n"
                f"Welcome to the official livestream playlist for {tournament.title}.\n\n"
                f"📍 Location: {tournament.location}\n"
                f"📅 Date: {tournament.dateTime.strftime("%m-%d-%Y")}\n"
                f"🕒 Start time: {tournament.dateTime.strftime("%H:%M")}\n"
                f"🥋 Courts: {tournament.courtNum}\n\n"
                "This playlist contains all live broadcasts from the tournament, separated by court.\n"
                "Select the correct court livestream and follow the matches live.\n\n"
                "Powered by TrueVAR."
            ),
        )
        playlist_id: str = playlist_resp["id"]
        playlist_url = f"https://www.youtube.com/playlist?list={playlist_id}"

        broadcasts: List[Dict[str, Any]] = []

        for i, key in enumerate(selected_keys):
            court_num = i + 1
            court_display = court_num
            if (numbering == "Alphabet"): court_display = chr(65 + i)
            court_label = f"{venue} {court_display}"
            title = f"{tournament.title} {court_label}"

            broadcast_resp = self.yt.create_broadcast(
                title=title,
                scheduled_start=tournament.dateTime,
                description=(
                    f"🏆 {tournament.title} — {venue} {court_display}\n\n"
                    f"You are watching the official livestream from {venue} {court_display}.\n\n"
                    f"📍 Location: {tournament.location}\n"
                    f"📅 Date: {tournament.dateTime.strftime("%m-%d-%Y")}\n"
                    f"🕒 Start time: {tournament.dateTime.strftime("%H:%M")}\n"
                    f"🥋 Courts: {tournament.courtNum}\n\n"
                    f"This stream is part of the {tournament.title} tournament.\n"
                    "For other courts, check the tournament playlist on this channel.\n\n"
                    "Powered by TrueVAR."
                ),
            )
            broadcast_id: str = broadcast_resp["id"]

            self.yt.bind_broadcast_to_stream(broadcast_id, key.stream_id)
            self.yt.add_to_playlist(playlist_id, broadcast_id)

            # ── Upload corresponding thumbnail if provided ──
            if thumbnails:
                try:
                    self.yt.set_thumbnail(
                        video_id=broadcast_id,
                        image_bytes=thumbnails[i].content,
                        mimetype=thumbnails[i].mimetype
                    )
                except Exception as e:
                    # We log the error but don't fail the whole setup! The stream is already created.
                    print(f"Failed to set thumbnail for {venue} {court_display} (Video ID: {broadcast_id}): {e}")

            key.mark_used(date_str)
            self.stream_key_repo.updateStreamKey(key)

            broadcasts.append({
                "court_number": court_num,
                "broadcast_id": broadcast_id,
                "stream_key": key.stream_key,
                "playlist_id": playlist_id,
                "title": title,
                "youtube_url": f"https://youtube.com/watch?v={broadcast_id}",
            })

        return {
            "playlist_id": playlist_id,
            "playlist_url": playlist_url,
            "broadcasts": broadcasts,
        }