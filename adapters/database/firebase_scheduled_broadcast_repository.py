from google.cloud.firestore import Client
from domain.ports.scheduled_broadcast_port import ScheduledBroadcastPort


class FirebaseScheduledBroadcastRepository(ScheduledBroadcastPort):
    def __init__(self, db: Client):
        self.db = db
        self.col = self.db.collection("scheduled_broadcasts")

    def deleteAllForTournament(self, tournament_id: str) -> None:
        docs = self.col.where("tournament_id", "==", tournament_id).stream()
        batch = self.db.batch()
        pending = 0
        for doc in docs:
            batch.delete(doc.reference)
            pending += 1
            if pending == 500:  # Firestore batch write limit
                batch.commit()
                batch = self.db.batch()
                pending = 0
        if pending:
            batch.commit()