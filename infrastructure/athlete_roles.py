"""
Athlete roles — extra jobs a person registered in an association can hold.

Everyone in `athletes` is a competitor; that is not a role. Roles are the
additional jobs on top of that, stored per sport next to clubId / rank:

    athletes/{id}.sports.{sport}.roles        = ["coach", "referee"]
    athletes/{id}.sports.{sport}.roleDetails  = {
        "coach":   {"licenseId": "...", "level": "..."},
        "referee": {"licenseId": "...", "level": "International"},
    }

Roles are sport-scoped on purpose: a taekwondo coach is not a boxing coach,
and the club that "owns" the person is already sport-scoped (clubId).

A missing `roles` field means no extra roles, so existing docs need no
migration.

Who can set which role:
  - coach   → the club admin, on the athlete create/edit page
  - referee → somewhere else (federation / staff tooling, not built yet).
              The club edit page never adds or removes it.
"""
from typing import Dict, List, Optional

ROLE_COACH = "coach"
ROLE_REFEREE = "referee"

VALID_ROLES = (ROLE_COACH, ROLE_REFEREE)

ROLE_LABELS = {
    ROLE_COACH: "Coach",
    ROLE_REFEREE: "Referee",
}

# Roles that can be registered on a tournament as officials.
TOURNAMENT_OFFICIAL_ROLES = VALID_ROLES

# Roles a CLUB admin may register on a tournament themselves. Referees are
# assigned by tournament staff (operator admin-add endpoint).
CLUB_REGISTRABLE_ROLES = (ROLE_COACH,)

# Roles the club-facing athlete create/edit page may switch on or off.
# Anything else on the profile is left exactly as it is.
CLUB_EDITABLE_ROLES = (ROLE_COACH,)

# Free-text detail fields kept per role.
ROLE_DETAIL_KEYS = ("licenseId", "level")


def sport_data_of(athlete: Optional[dict], sport: Optional[str]) -> dict:
    if not sport:
        return {}
    return ((athlete or {}).get("sports") or {}).get(sport) or {}


def roles_of(sport_data: Optional[dict]) -> List[str]:
    """Roles in canonical order. Missing field → no extra roles."""
    roles = (sport_data or {}).get("roles")
    if not isinstance(roles, list):
        return []
    return [r for r in VALID_ROLES if r in roles]


def has_role(sport_data: Optional[dict], role: str) -> bool:
    return role in roles_of(sport_data)


def clean_roles(roles: Optional[List[str]]) -> List[str]:
    """Known roles only, canonical order. Empty is fine — just a competitor."""
    wanted = {str(r).strip().lower() for r in (roles or [])}
    return [r for r in VALID_ROLES if r in wanted]


def clean_role_details(details: Optional[Dict], roles: List[str]) -> Dict[str, Dict[str, str]]:
    """Only the given roles, only known keys, no empty strings."""
    out: Dict[str, Dict[str, str]] = {}
    for role in roles:
        raw = (details or {}).get(role) or {}
        if not isinstance(raw, dict):
            continue
        kept = {k: str(raw.get(k) or "").strip() for k in ROLE_DETAIL_KEYS}
        kept = {k: v for k, v in kept.items() if v}
        if kept:
            out[role] = kept
    return out


def role_details_of(sport_data: Optional[dict], role: str) -> Dict[str, str]:
    return ((sport_data or {}).get("roleDetails") or {}).get(role) or {}


def apply_roles(
    sport_entry: dict,
    requested: Optional[List[str]],
    details: Optional[Dict],
    editable=CLUB_EDITABLE_ROLES,
) -> None:
    """
    Updates roles + roleDetails on a sports.{sport} entry in place.

    Only the `editable` roles follow the request; every other role already
    on the entry (e.g. referee, granted elsewhere) is kept along with its
    details, whatever the request says.
    """
    current = roles_of(sport_entry)
    kept = [r for r in current if r not in editable]
    chosen = [r for r in clean_roles(requested) if r in editable]
    roles = [r for r in VALID_ROLES if r in set(kept) | set(chosen)]

    old_details = sport_entry.get("roleDetails") or {}
    new_details = {r: old_details[r] for r in kept if r in old_details}
    new_details.update(clean_role_details(details, chosen))

    if roles:
        sport_entry["roles"] = roles
    else:
        sport_entry.pop("roles", None)
    if new_details:
        sport_entry["roleDetails"] = new_details
    else:
        sport_entry.pop("roleDetails", None)