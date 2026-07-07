import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore import Client

def init_firestore() -> Client:
    """Initializes Firebase application using local or environment credentials."""
    if not firebase_admin._apps:
        # For local development, set GOOGLE_APPLICATION_CREDENTIALS env var to path of serviceAccountKey.json
        # Or explicitly pass credentials.Certificate("path/to/key.json")
        cred = credentials.Certificate("google_creds.json")
        firebase_admin.initialize_app(cred)

        
    return firestore.client()