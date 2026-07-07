from abc import ABC, abstractmethod
from typing import List, Optional

from domain.entities import StreamKey


class StreamKeyPort(ABC):
    """Outbound port — the infrastructure layer implements this for Firestore."""

    @abstractmethod
    def addStreamKey(self, key: StreamKey) -> None:
        pass

    @abstractmethod
    def getStreamKeys(self) -> List[StreamKey]:
        pass

    @abstractmethod
    def getStreamKey(self, key_id: str) -> Optional[StreamKey]:
        pass

    @abstractmethod
    def updateStreamKey(self, key: StreamKey) -> None:
        pass

    @abstractmethod
    def deleteStreamKey(self, key_id: str) -> None:
        pass

    @abstractmethod
    def getAvailableKeysForDate(self, date_str: str) -> List[StreamKey]:
        """Return only keys whose used_dates list does NOT contain date_str."""
        pass