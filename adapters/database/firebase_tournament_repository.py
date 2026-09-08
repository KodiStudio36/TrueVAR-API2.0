from datetime import datetime, timezone
from typing import List, Optional
from datetime import datetime
import logging

from domain.ports.tournament_port import TournamentPort
from google.cloud.firestore import Client
from domain.entities import Tournament
from domain.ports.tournament_port import TournamentPort

from firebase_admin import db as rtdb  # Realtime Database, separate from Firestore

logger = logging.getLogger(__name__)

RTDB_URL = "https://easytkd-default-rtdb.europe-west1.firebasedatabase.app/"


class FirebaseTournamentRepository(TournamentPort):
    """Concrete implementation of outbound port talking to Firebase Firestore"""

    def __init__(self, db: Client):
        self.db = db
        self.collection = self.db.collection("tournaments")

    def _delete_rtdb_tournament(self, tournament_id: str) -> None:
        """
        Best-effort cleanup of tournaments/{tournament_id} in the Realtime
        Database. RTDB is a separate product from Firestore (different URL,
        different region here — europe-west1), so it needs its own
        reference with an explicit url= rather than relying on whatever
        default database the firebase_admin app was initialized with.

        Deleting a path that doesn't exist is a harmless no-op in RTDB, so
        this is safe to call unconditionally on both delete and archive.
        Wrapped in try/except so an RTDB outage doesn't roll back or fail
        a Firestore operation that already succeeded.
        """
        try:
            rtdb.reference(f"tournaments/{tournament_id}", url=RTDB_URL).delete()
        except Exception:
            logger.exception(
                "Failed to delete RTDB tournaments/%s (Firestore side already committed)",
                tournament_id,
            )

    def createTournament(self, tournament: Tournament) -> Tournament:
        # Generates a new auto-id reference before writing
        doc_ref = self.collection.document()
        tournament.id = doc_ref.id

        # Write to Firestore
        doc_ref.set(tournament.toJson())
        return tournament

    def updateTournament(self, tournament: Tournament) -> None:
        doc_ref = self.collection.document(tournament.id)
        doc_ref.set(tournament.toJson())

    def getTournaments(self) -> List[Tournament]:
        docs = self.collection.stream()
        tournaments = []
        for doc in docs:
            data = doc.to_dict()
            tournaments.append(Tournament.fromJson(doc.id, data))
        return tournaments

    def getTournament(self, tournament_id: str) -> Optional[Tournament]:
        doc_ref = self.collection.document(tournament_id).get()
        if not doc_ref.exists:
            return None

        data = doc_ref.to_dict()
        return Tournament.fromJson(doc_ref.id, data)

    def getTournamentsPaginated(
        self, status: str, limit: int = 10, offset: int = 0,
        isExternalPublic: Optional[bool] = None,
    ) -> List[Tournament]:
        query = self.db.collection("tournaments").where("status", "==", status)
        if isExternalPublic is not None:
            query = query.where("isExternalPublic", "==", isExternalPublic)
        query = query.order_by("dateTime").offset(offset).limit(limit)

        docs = query.stream()
        return [Tournament.fromJson(doc.id, doc.to_dict()) for doc in docs]

    def getTournamentsCursorPaginated(
        self, status: str, limit: int = 20,
        cursor_date_time: Optional[datetime] = None, cursor_id: Optional[str] = None,
    ) -> List[Tournament]:
        query = (
            self.collection
            .where("status", "==", status)
            .order_by("dateTime", direction="DESCENDING")
            .order_by("__name__", direction="DESCENDING")
            .limit(limit)
        )
        if cursor_date_time is not None and cursor_id is not None:
            query = query.start_after({"dateTime": cursor_date_time, "__name__": self.collection.document(cursor_id)})
        docs = query.stream()
        return [Tournament.fromJson(doc.id, doc.to_dict()) for doc in docs]

    def setTournamentStatus(self, tournament_id: str, status: str) -> None:
        self.collection.document(tournament_id).update({"status": status})
        if status == "archived":
            self._delete_rtdb_tournament(tournament_id)

    def deleteTournament(self, tournament_id: str) -> None:
        self.collection.document(tournament_id).delete()
        self._delete_rtdb_tournament(tournament_id)