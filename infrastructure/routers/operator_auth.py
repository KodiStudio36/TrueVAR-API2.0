from datetime import datetime
from typing import Optional, List, Dict

from fastapi import APIRouter, Request, Depends, HTTPException, status
from pydantic import BaseModel
from firebase_admin import firestore

from infrastructure.auth_common import db, get_current_user

# ── Exceptions ───────────────────────────────────────────────────────────
# Two distinct denial types so the exception handler in main.py can tell
# them apart: a plain visitor with no operator record gets bounced home
# quietly, but a real operator hitting a page above their role gets a
# proper "not authorized" page — never a blank redirect that looks like
# the page simply doesn't exist.

class OperatorAuthRequiredError(HTTPException):
    def __init__(self, detail: str = "Operator sign-in required."):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


class OperatorForbiddenError(HTTPException):
    def __init__(self, detail: str = "You do not have permission to access this page."):
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


# ── Roles & permissions ──────────────────────────────────────────────────

OPERATOR_ROLES = {"TRO", "TAO", "TCO", "TOS"}

# None = wildcard (all permissions). TOS "can do anything".
ROLE_PERMISSIONS: Dict[str, Optional[set]] = {
    "TRO": {"dashboard:view", "tournament:view"},
    "TAO": {"dashboard:view", "tournament:view"},
    "TCO": {
        "dashboard:view", "tournament:view",
        "brackets:manage",
        "categories:manage",
        "broadcasts:manage",
        "matches:manage",
        "registrations:manage",
        "weighin:view",
    },
    "TOS": None,
}


def role_has_permission(role: str, permission: str) -> bool:
    perms = ROLE_PERMISSIONS.get(role)
    if perms is None:
        return True  # TOS wildcard
    return permission in perms


# ── Operator record lookup ────────────────────────────────────────────────
# One point-read by uid. Candidate to fold into the session JWT later
# (with a small operatorVersion field for cheap revocation) if this shows
# up hot — same pattern discussed for club roles.

def get_operator_record(uid: str) -> Optional[dict]:
    doc = db.collection("operators").document(uid).get()
    if not doc.exists:
        return None
    data = doc.to_dict()
    if not data.get("active", True):
        return None
    if data.get("role") not in OPERATOR_ROLES:
        return None
    return data


# ── Dependency factory ─────────────────────────────────────────────────────

def require_operator(permission: str):
    """
    Usage: Depends(require_operator("brackets:manage"))
    Raises OperatorAuthRequiredError if the caller isn't a known, active
    operator at all (-> redirect home on /dashboard, plain 403 on /api).
    Raises OperatorForbiddenError if they ARE an operator but their role
    lacks this permission (-> 403 page on /dashboard, 403 JSON on /api).
    """
    async def _dependency(request: Request, user: Optional[dict] = Depends(get_current_user)) -> dict:
        if not user or not user.get("uid"):
            raise OperatorAuthRequiredError()

        operator = get_operator_record(user["uid"])
        if not operator:
            raise OperatorAuthRequiredError()

        if not role_has_permission(operator["role"], permission):
            raise OperatorForbiddenError(
                f"Your role ({operator['role']}) does not have '{permission}' access."
            )

        request.state.operator = operator
        return operator

    return _dependency


# ── Operator management (TOS only) ─────────────────────────────────────────

class CreateOperatorRequest(BaseModel):
    uid: str
    role: str


class UpdateOperatorRoleRequest(BaseModel):
    role: str


operator_router = APIRouter(prefix="/api/operators", tags=["Operators"])


@operator_router.post("", status_code=status.HTTP_201_CREATED,
                       dependencies=[Depends(require_operator("operator:manage"))])
def create_operator(payload: CreateOperatorRequest, request: Request):
    if payload.role not in OPERATOR_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(OPERATOR_ROLES)}")

    caller = request.state.operator
    db.collection("operators").document(payload.uid).set({
        "uid": payload.uid,
        "role": payload.role,
        "active": True,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "createdBy": caller.get("uid"),
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return {"message": "Operator granted", "uid": payload.uid, "role": payload.role}


@operator_router.get("", dependencies=[Depends(require_operator("operator:manage"))])
def list_operators():
    docs = db.collection("operators").stream()
    return {"operators": [d.to_dict() for d in docs]}


@operator_router.patch("/{uid}", dependencies=[Depends(require_operator("operator:manage"))])
def update_operator_role(uid: str, payload: UpdateOperatorRoleRequest):
    if payload.role not in OPERATOR_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(OPERATOR_ROLES)}")
    db.collection("operators").document(uid).set(
        {"role": payload.role, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return {"message": "Role updated", "uid": uid, "role": payload.role}


@operator_router.delete("/{uid}", dependencies=[Depends(require_operator("operator:manage"))])
def revoke_operator(uid: str):
    db.collection("operators").document(uid).set(
        {"active": False, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True
    )
    return {"message": "Operator revoked", "uid": uid}