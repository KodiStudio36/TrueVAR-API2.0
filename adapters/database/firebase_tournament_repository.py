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

    def createTournament(self, tournament: Tournament) -> None:
        self.collection.add(tournament.toJson())

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
        self, status: str, limit: int = 10, offset: int = 0
    ) -> List[Tournament]:
        """
        Simple offset pagination, ordered newest-first. Fine for the
        volumes a single-org dashboard deals with; if this collection
        grows into the thousands, swap .offset() for a cursor
        (start_after on the last doc snapshot) since Firestore still
        reads+discards the skipped docs under the hood.
        """
        query = (
            self.collection
            .where("status", "==", status)
            .order_by("dateTime", direction="DESCENDING")
            .offset(offset)
            .limit(limit)
        )
        docs = query.stream()
        return [Tournament.fromJson(doc.id, doc.to_dict()) for doc in docs]

    def setTournamentStatus(self, tournament_id: str, status: str) -> None:
        self.collection.document(tournament_id).update({"status": status})
        
    def deleteTournament(self, tournament_id: str) -> None:
        self.collection.document(tournament_id).delete()