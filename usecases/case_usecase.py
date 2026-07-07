from typing import List, Optional
from datetime import datetime
from domain.entities import Case, Tournament
from domain.ports.case_port import CasePort
from domain.ports.tournament_port import TournamentPort

class CreateCaseUseCase:
    def __init__(self, repo: CasePort):
        self.repo = repo

    def execute(self, name: str) -> None:
        case = Case(id=None, name=name, tournamentId=None, courtId=None)
        self.repo.createCase(case)

class GetAllCasesUseCase:
    def __init__(self, repo: CasePort):
        self.repo = repo

    def execute(self) -> List[Case]:
        return self.repo.getCases()

class GetCaseUseCase:
    def __init__(self, repo: CasePort):
        self.repo = repo

    def execute(self, case_id: str) -> Optional[Case]:
        return self.repo.getCase(case_id)