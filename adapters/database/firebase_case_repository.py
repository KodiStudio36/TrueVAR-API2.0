from typing import List, Optional
from datetime import datetime
from domain.ports.case_port import CasePort
from domain.ports.tournament_port import TournamentPort
from google.cloud.firestore import Client
from domain.entities import Case, Tournament
from domain.ports.tournament_port import TournamentPort

class FirebaseCaseRepository(CasePort):
    """Concrete implementation of outbound port talking to Firebase Firestore"""
    
    def __init__(self, db: Client):
        self.db = db
        self.collection = self.db.collection("cases")

    def createCase(self, case: Case) -> None:
        self.collection.add(case.toJson())

    def updateCase(self, case: Case) -> None:
        doc_ref = self.collection.document(case.id)
        doc_ref.set(case.toJson())

    def getCases(self) -> List[Case]:
        docs = self.collection.get()
        cases = []
        for doc in docs:
            data = doc.to_dict()
            cases.append(Case.fromJson(doc.id, data))
        return cases

    def getCase(self, case_id: str) -> Optional[Case]:
        doc_ref = self.collection.document(case_id).get()
        if not doc_ref.exists:
            return None
            
        data = doc_ref.to_dict()
        return Case.fromJson(doc_ref.id, data)
        