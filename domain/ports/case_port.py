from abc import ABC, abstractmethod
from typing import List, Optional
from domain.entities import Case, Tournament

class CasePort(ABC):
    """
    An outbound port interface. The infrastructure layer 
    must implement this to talk to Firebase.
    """
    @abstractmethod
    def createCase(self, case: Case) -> None:
        pass

    @abstractmethod
    def updateCase(self, case: Case) -> None:
        pass

    @abstractmethod
    def getCases(self) -> List[Case]:
        pass

    @abstractmethod
    def getCase(self, tournament_id: str) -> Optional[Case]:
        pass