"""
Run once to create the first TOS operator, e.g.:
    python scripts/bootstrap_operator.py <firebase-auth-uid>
"""
import sys
from firebase_admin import firestore
from infrastructure.firebase_client import init_firestore

def main():
    if len(sys.argv) != 2:
        print("Usage: python scripts/bootstrap_operator.py <uid>")
        sys.exit(1)

    uid = sys.argv[1]
    db = init_firestore()
    db.collection("operators").document(uid).set({
        "uid": uid,
        "role": "TOS",
        "active": True,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "createdBy": "bootstrap-script",
    })
    print(f"{uid} is now TOS (TrueVAR Operator Supervisor)")

if __name__ == "__main__":
    main()