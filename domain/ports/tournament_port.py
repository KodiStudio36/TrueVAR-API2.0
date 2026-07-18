from abc import ABC, abstractmethod
from typing import List, Optional
from domain.entities import Case, Tournament

class TournamentPort(ABC):
    """
    An outbound port interface. The infrastructure layer 
    must implement this to talk to Firebase.
    """
    @abstractmethod
    def createTournament(self, tournament: Tournament) -> None:
        pass

    @abstractmethod
    def updateTournament(self, tournament: Tournament) -> None:
        pass

    @abstractmethod
    def getTournaments(self) -> List[Tournament]:
        pass

    @abstractmethod
    def getTournament(self, tournament_id: str) -> Optional[Tournament]:
        pass

    @abstractmethod
    def getTournamentsPaginated(
        self, status: str, limit: int, offset: int
    ) -> List[Tournament]: ...

    @abstractmethod
    def setTournamentStatus(self, tournament_id: str, status: str) -> None: ...

    @abstractmethod
    def deleteTournament(self, tournament_id: str) -> None: ...