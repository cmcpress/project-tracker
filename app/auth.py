"""
auth.py — Authentication and authorisation.

Phase 5A: stub implementation — always returns None (no auth in local mode).
Phase 5D: replace resolve_user() with real JWT validation and implement
          require_project_access() membership checks.

The before_request hook in app/__init__.py calls resolve_user() on every
request and stores the result in flask.g.current_user. Routes that need
membership checks use the @require_project_access decorator.
"""

from functools import wraps
import flask


def resolve_user():
    """
    Return the current authenticated user, or None in local mode.

    Phase 5A: always returns None (local mode, no auth required).
    Phase 5D: validates the JWT token from the Authorization header,
              looks up the user record, and returns a user dict.
    """
    return None


def require_project_access(role: str = "viewer"):
    """
    Decorator that enforces project membership in cloud mode.

    Phase 5A: no-op pass-through — all requests are allowed.
    Phase 5D: checks that flask.g.current_user has the required role
              on the project_id in the route kwargs.

    Usage:
        @bp.route("/api/projects/<int:project_id>/tasks")
        @require_project_access(role="viewer")
        def list_tasks(project_id):
            ...
    """
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            # Local mode: always allow
            if flask.g.get("mode") == "local":
                return f(*args, **kwargs)
            # Cloud mode (5D): membership check goes here
            return f(*args, **kwargs)
        return wrapped
    return decorator
