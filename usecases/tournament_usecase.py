from typing import List, Optional
from datetime import datetime
from domain.entities import Tournament
from domain.ports.tournament_port import TournamentPort

class CreateTournamentUseCase:
    def __init__(self, repo: TournamentPort):
        self.repo = repo

    def execute(self, title: str, location: str, courtNum: int, dateTime: datetime, isExternalPublic: bool,
                settings: dict, discipline: str, sport: str, isRegistrationOpen: bool) -> None:
        tournament = Tournament(
            id=None,
            title=title,
            location=location,
            courtNum=courtNum,
            dateTime=dateTime,
            settings=settings,
            discipline=discipline,
            sport=sport,
            isExternalPublic=isExternalPublic,
            status="active",
            isRegistrationOpen=isRegistrationOpen,
        )
        return self.repo.createTournament(tournament)

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
    def __init__(self, repo: TournamentPort):
        self.repo = repo

    def execute(self, tournament_id: str, title: str, location: str, courtNum: int, isExternalPublic: bool,
                dateTime: datetime, discipline: str, sport: str, settings: dict) -> None:
        tournament = self.repo.getTournament(tournament_id)
        if not tournament:
            raise ValueError(f"Tournament '{tournament_id}' not found.")
        tournament.title = title
        tournament.location = location
        tournament.courtNum = courtNum
        tournament.dateTime = dateTime
        tournament.discipline = discipline
        tournament.sport = sport
        tournament.settings = settings
        tournament.isExternalPublic = isExternalPublic
        self.repo.updateTournament(tournament)

class SetTournamentStatusUseCase:
    def __init__(self, tournament_repo, broadcast_repo, stream_key_repo):
        self.tournament_repo = tournament_repo
        self.broadcast_repo = broadcast_repo
        self.stream_key_repo = stream_key_repo

    def execute(self, tournament_id: str, status: str) -> None:
        tournament = self.tournament_repo.getTournament(tournament_id)
        if not tournament:
            raise ValueError("Tournament not found")

        self.tournament_repo.setTournamentStatus(tournament_id, status)

        # Cleanup only fires going INTO archived — restoring a tournament
        # doesn't try to resurrect broadcasts or re-book a stream key date;
        # that has to be a deliberate re-scheduling action afterward.
        if status == "archived":
            self.broadcast_repo.deleteAllForTournament(tournament_id)
            date_str = tournament.dateTime.strftime("%Y-%m-%d")
            self.stream_key_repo.releaseDate(date_str)

class DeleteTournamentUseCase:
    def __init__(self, tournament_repo, broadcast_repo, stream_key_repo):
        self.tournament_repo = tournament_repo
        self.broadcast_repo = broadcast_repo
        self.stream_key_repo = stream_key_repo

    def execute(self, tournament_id: str) -> None:
        tournament = self.tournament_repo.getTournament(tournament_id)
        if not tournament:
            raise ValueError("Tournament not found")

        # Same cleanup as archiving — a hard delete shouldn't leave orphaned
        # broadcasts or a stream-key date that never gets freed.
        self.broadcast_repo.deleteAllForTournament(tournament_id)
        date_str = tournament.dateTime.strftime("%Y-%m-%d")
        self.stream_key_repo.releaseDate(date_str)

        self.tournament_repo.deleteTournament(tournament_id)