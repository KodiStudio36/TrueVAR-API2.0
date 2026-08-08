from datetime import datetime, timezone
from typing import List, Optional
from datetime import datetime
from domain.ports.tournament_port import TournamentPort
from google.cloud.firestore import Client
from domain.entities import Tournament
from domain.ports.tournament_port import TournamentPort

class FirebaseTournamentRepository(TournamentPort):
    """Concrete implementation of outbound port talking to Firebase Firestore"""
    
    def __init__(self, db: Client):
        self.db = db
        self.collection = self.db.collection("tournaments")

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
        """
        Simple offset pagination, ordered newest-first. Fine for the
        volumes a single-org dashboard deals with; if this collection
        grows into the thousands, swap .offset() for a cursor
        (start_after on the last doc snapshot) since Firestore still
        reads+discards the skipped docs under the hood.
        """
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
        """
        Cursor pagination for the tournaments list page's infinite scroll —
        start_after on explicit field VALUES (not a server-held cursor
        object, and not offset()), so Firestore only ever reads the page
        actually being returned, never the pages skipped to get there.
        Cheap however many pages deep the admin scrolls, unlike
        getTournamentsPaginated above.

        order_by(dateTime, id) with BOTH cursor values (not just dateTime)
        is what makes this stable: dateTime alone isn't guaranteed unique
        across tournaments, and start_after on a non-unique field can
        skip or repeat rows sitting on the exact same value. The document
        id as a tiebreaker fixes that — same pattern as any keyset
        pagination over a non-unique sort column.
        """
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
        
    def deleteTournament(self, tournament_id: str) -> None:
        self.collection.document(tournament_id).delete()