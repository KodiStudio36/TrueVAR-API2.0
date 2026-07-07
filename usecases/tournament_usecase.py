from typing import List, Optional
from datetime import datetime
from domain.entities import Tournament
from domain.ports.tournament_port import TournamentPort

class CreateTournamentUseCase:
    def __init__(self, repo: TournamentPort):
        self.repo = repo

    def execute(self, title: str, location: str, courtNum: int, dateTime: datetime, settings: dict, discipline: str) -> None:
        tournament = Tournament(
            id=None, 
            title=title, 
            location=location, 
            courtNum=courtNum,
            dateTime=dateTime,
            settings=settings,
            discipline=discipline,
        )
        self.repo.createTournament(tournament)

class GetAllTournamentsUseCase:
    def __init__(self, repo: TournamentPort):
        self.repo = repo

    def execute(self) -> List[Tournament]:
        return self.repo.getTournaments()

class GetTournamentUseCase:
    def __init__(self, repo: TournamentPort):
        self.repo = repo

    def execute(self, tournament_id: str) -> Optional[Tournament]:
        return self.repo.getTournament(tournament_id)
    
class UpdateTournamentUseCase:
    """Overwrite mutable fields on an existing tournament document."""
 
    def __init__(self, repo: TournamentPort):
        self.repo = repo
 
    def execute(
        self,
        tournament_id: str,
        title: str,
        location: str,
        courtNum: int,
        dateTime: datetime,
        discipline: str,
        settings: dict,
    ) -> None:
        tournament = self.repo.getTournament(tournament_id)
        if not tournament:
            raise ValueError(f"Tournament '{tournament_id}' not found.")
 
        tournament.title = title
        tournament.location = location
        tournament.courtNum = courtNum
        tournament.dateTime = dateTime
        tournament.discipline = discipline
        tournament.settings = settings
 
        self.repo.updateTournament(tournament)
