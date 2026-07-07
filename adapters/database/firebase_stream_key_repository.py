from typing import List, Optional

from google.cloud.firestore import Client

from domain.entities import StreamKey
from domain.ports.stream_key_port import StreamKeyPort


class FirebaseStreamKeyRepository(StreamKeyPort):
    """Concrete Firestore adapter for StreamKey persistence."""

    def __init__(self, db: Client):
        self.db = db
        self.col = self.db.collection("stream_keys")

    # ── write ─────────────────────────────────────────────────────────────────

    def addStreamKey(self, key: StreamKey) -> None:
        self.col.add(key.toJson())

    def updateStreamKey(self, key: StreamKey) -> None:
        self.col.document(key.id).set(key.toJson())

    def deleteStreamKey(self, key_id: str) -> None:
        self.col.document(key_id).delete()

    # ── read ──────────────────────────────────────────────────────────────────

    def getStreamKeys(self) -> List[StreamKey]:
        return [StreamKey.fromJson(doc.id, doc.to_dict()) for doc in self.col.stream()]

    def getStreamKey(self, key_id: str) -> Optional[StreamKey]:
        doc = self.col.document(key_id).get()
        if not doc.exists:
            return None
        return StreamKey.fromJson(doc.id, doc.to_dict())

    def getAvailableKeysForDate(self, date_str: str) -> List[StreamKey]:
        return [k for k in self.getStreamKeys() if k.is_available_on(date_str)]