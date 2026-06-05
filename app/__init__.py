"""
app/__init__.py — Flask application factory.

Creates and configures the Flask app, registers all blueprints,
and sets up error handlers. Called once at startup from main.py.

Phase 5A additions:
  - before_request hook: attaches current_user and mode to flask.g
  - /api/mode endpoint: tells the frontend whether local or cloud
  - data_changed Blinker signal: defined here, subscribed in 5F
"""

import sys
import os
import logging
import flask
from flask import Flask, jsonify
from blinker import Namespace

# ---------------------------------------------------------------------------
# Application-level signals (Phase 5A — subscribed in Phase 5F)
# ---------------------------------------------------------------------------

_signals = Namespace()
data_changed = _signals.signal("data-changed")
"""
Fired after a successful write commit. Subscribe in Phase 5F to broadcast
changes via Flask-SocketIO. Sender should pass keyword args:
    data_changed.send(project_id=<id>, entity=<str>, action=<str>)
"""


def _resource_path(*parts: str) -> str:
    """
    Return an absolute path to a bundled resource.

    - In a PyInstaller .exe: relative to sys._MEIPASS (PyInstaller's temp
      extraction directory where data files are unpacked).
    - In script mode: relative to the project root (parent of app/).
    """
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS          # type: ignore[attr-defined]
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def create_app() -> Flask:
    """
    Create and return the configured Flask application.
    Registers all route blueprints and attaches global error handlers.
    """
    app = Flask(
        __name__,
        static_folder=_resource_path("static"),
        template_folder=_resource_path("templates"),
    )
    app.config["JSON_SORT_KEYS"] = False
    # Disable HTTP caching for all responses — WebView2 (Edge) caches
    # static files aggressively, which causes stale JS to be served after
    # code changes. no-store forces a fresh fetch every time.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    @app.after_request
    def no_cache(response):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    # ------------------------------------------------------------------
    # Request context — attach user and mode to flask.g (Phase 5A)
    # Phase 5D: replace resolve_user() stub with real JWT validation.
    # ------------------------------------------------------------------
    @app.before_request
    def _attach_request_context():
        from app.auth import resolve_user
        from app.database import is_local_mode
        flask.g.current_user = resolve_user()
        flask.g.mode = "local" if is_local_mode() else "cloud"

    # ------------------------------------------------------------------
    # Mode endpoint — lets the frontend know local vs cloud (Phase 5A)
    # ------------------------------------------------------------------
    @app.route("/api/mode")
    def get_mode():
        """Return the current database mode and connection info."""
        from app.database import is_local_mode, _pg_config
        if is_local_mode():
            return jsonify({"mode": "local"})
        host = _pg_config.get("host", "") if _pg_config else ""
        return jsonify({"mode": "cloud", "host": host})

    # ------------------------------------------------------------------
    # Register route blueprints
    # ------------------------------------------------------------------
    from app.routes.projects import bp as projects_bp
    from app.routes.tasks import bp as tasks_bp
    from app.routes.dependencies import bp as dependencies_bp
    from app.routes.people import bp as people_bp
    from app.routes.items import bp as items_bp
    from app.routes.export import bp as export_bp
    from app.routes.categories import bp as categories_bp
    from app.routes.db import bp as db_bp
    from app.routes.phases import bp as phases_bp
    from app.routes.unavailability import bp as unavailability_bp
    from app.routes.baselines import bp as baselines_bp
    from app.routes.settings import bp as settings_bp
    from app.routes.templates import bp as templates_bp
    from app.routes.links import bp as links_bp

    app.register_blueprint(projects_bp)
    app.register_blueprint(tasks_bp)
    app.register_blueprint(dependencies_bp)
    app.register_blueprint(people_bp)
    app.register_blueprint(items_bp)
    app.register_blueprint(export_bp)
    app.register_blueprint(categories_bp)
    app.register_blueprint(db_bp)
    app.register_blueprint(phases_bp)
    app.register_blueprint(unavailability_bp)
    app.register_blueprint(baselines_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(templates_bp)
    app.register_blueprint(links_bp)

    # ------------------------------------------------------------------
    # Serve the SPA shell at the root
    # ------------------------------------------------------------------
    from flask import send_from_directory

    @app.route("/")
    def index():
        """Serve the single-page application shell."""
        return send_from_directory(_resource_path("static"), "index.html")

    # ------------------------------------------------------------------
    # Global error handlers
    # ------------------------------------------------------------------

    @app.errorhandler(400)
    def bad_request(e):
        return jsonify({"error": str(e.description)}), 400

    @app.errorhandler(404)
    def not_found(e):
        return jsonify({"error": "Resource not found"}), 404

    @app.errorhandler(500)
    def internal_error(e):
        logging.exception("Internal server error")
        return jsonify({"error": "Internal server error"}), 500

    return app
