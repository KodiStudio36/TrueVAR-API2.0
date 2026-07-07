from abc import ABC, abstractmethod

class ScheduledBroadcastPort(ABC):
    @abstractmethod
    def deleteAllForTournament(self, tournament_id: str) -> None: ...