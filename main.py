"""
main.py — Application entry point.

Startup sequence:
    1. Find a free TCP port dynamically
    2. Resolve the data directory:
       - PyInstaller bundle: directory of the .exe
       - Script mode: project root
    3. Set the database path and run migrations
    4. Start Flask in a background daemon thread
    5. Open the pywebview desktop window
    6. On window close: signal Flask to shut down and join the thread

Data storage:
    When running as a .exe, the database is stored in:
        %APPDATA%\\ProjectTracker\\projects.db
    (so it survives .exe updates without data loss)

    When running as a script during development, it is stored in:
        <project root>/data/projects.db
"""

from __future__ import annotations

import sys
import os
import json
import socket
import threading
import logging
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging — file + console, set up before any imports that might log
# ---------------------------------------------------------------------------

def _resolve_log_dir() -> Path:
    """Return the directory used for both the log file and config.json."""
    if getattr(sys, "frozen", False):
        return Path(os.environ.get("APPDATA", Path.home())) / "ProjectTracker"
    return Path(__file__).parent


def _read_enable_logging() -> bool:
    """
    Read the enable_logging preference from the SQLite settings table before
    the logging system is initialised.

    Strategy:
      1. Resolve the data directory (same logic as resolve_data_dir).
      2. Read config.json to find last_db (the active database path).
      3. Query the settings table in that database.

    Returns True (logging on) if anything fails or the key is absent —
    i.e. on by default.
    """
    try:
        import sqlite3

        # Resolve data dir (mirrors resolve_data_dir, which isn't defined yet)
        if getattr(sys, "frozen", False):
            data_dir = Path(os.environ.get("APPDATA", Path.home())) / "ProjectTracker"
        else:
            data_dir = Path(__file__).parent / "data"

        # Find the active DB path from config.json
        cfg_path = _resolve_log_dir() / "config.json"
        db_path = None
        if cfg_path.exists():
            try:
                cfg = json.loads(cfg_path.read_text("utf-8"))
                candidate = cfg.get("last_db")
                if candidate and Path(candidate).exists():
                    db_path = Path(candidate)
            except Exception:
                pass

        if db_path is None:
            db_path = data_dir / "projects.db"

        if not db_path.exists():
            return True  # No DB yet → default on

        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = 'enable_logging'"
            ).fetchone()
            if row and row[0] == "false":
                return False
        finally:
            conn.close()

    except Exception:
        pass

    return True


def _setup_logging() -> Path:
    """
    Configure logging to write to both the console and a rotating log file.

    Log file location:
        Bundled .exe  →  %APPDATA%\\ProjectTracker\\startup.log
        Script mode   →  <project root>/startup.log

    File logging is skipped when the user has set enable_logging = false in
    Settings (preference is read from config.json before handlers are attached).

    Returns the path of the log file for display purposes.
    """
    log_dir = _resolve_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "startup.log"

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    file_logging_enabled = _read_enable_logging()

    # Rotating file handler — keeps last 2 MB, 3 backups
    fh = None
    if file_logging_enabled:
        try:
            from logging.handlers import RotatingFileHandler
            fh = RotatingFileHandler(log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
            fh.setLevel(logging.DEBUG)
            fh.setFormatter(fmt)
        except Exception:
            fh = None

    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    root.addHandler(ch)
    if fh:
        root.addHandler(fh)

    return log_file


_log_file = _setup_logging()
logger = logging.getLogger(__name__)


def _log_system_info() -> None:
    """Write a diagnostic header to the log on every startup."""
    import platform

    logger.info("=" * 60)
    logger.info("Project Tracker  startup")
    logger.info("=" * 60)
    logger.info("Log file        : %s", _log_file)
    logger.info("Python          : %s", sys.version.replace("\n", " "))
    logger.info("Platform        : %s", platform.platform())
    logger.info("Machine         : %s  %s", platform.machine(), platform.processor())
    logger.info("Executable      : %s", sys.executable)
    logger.info("Frozen bundle   : %s", getattr(sys, "frozen", False))

    # .NET Framework presence (Windows only)
    try:
        import winreg
        for ver in ("v4.0.30319", "v3.5", "v3.0", "v2.0.50727"):
            key_path = rf"SOFTWARE\Microsoft\NET Framework Setup\NDP\{ver}"
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as k:
                    release, _ = winreg.QueryValueEx(k, "Release")
                    logger.info(".NET Framework  : %s  (release %s)", ver, release)
            except OSError:
                pass
    except ImportError:
        pass

    # WebView2 Runtime presence
    _log_webview2_status()

    logger.info("=" * 60)


def _log_webview2_status() -> None:
    """Check and log whether WebView2 Runtime is installed."""
    try:
        import winreg
        _WV2_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
        found = False
        checked = []
        for hive_name, hive in (
            ("HKLM", winreg.HKEY_LOCAL_MACHINE),
            ("HKCU", winreg.HKEY_CURRENT_USER),
        ):
            for subpath in (
                rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_WV2_GUID}",
                rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{_WV2_GUID}",
                # Win11 ships WebView2 as part of the OS under a different path
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView",
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView",
            ):
                full = hive_name + "\\" + subpath
                checked.append(full)
                try:
                    with winreg.OpenKey(hive, subpath) as k:
                        try:
                            ver, _ = winreg.QueryValueEx(k, "pv")
                        except OSError:
                            try:
                                ver, _ = winreg.QueryValueEx(k, "DisplayVersion")
                            except OSError:
                                ver = "(version unknown)"
                        logger.info("WebView2 Runtime: FOUND at %s  version=%s", full, ver)
                        found = True
                except OSError:
                    pass

        if not found:
            logger.warning("WebView2 Runtime: NOT FOUND in registry")
            logger.warning("Checked paths   : %s", checked)
            logger.warning("This will cause the winforms/.NET backend to be used instead.")
            logger.warning("Fix: install Microsoft Edge WebView2 Runtime from https://go.microsoft.com/fwlink/p/?LinkId=2124703")
    except ImportError:
        logger.info("WebView2 check  : skipped (not Windows)")

# ---------------------------------------------------------------------------
# Config persistence
# ---------------------------------------------------------------------------

# Set in main() once the data directory is known
_config_dir: Path | None = None


def _read_config() -> dict:
    """Load config.json from the data directory. Returns {} on any error."""
    if _config_dir is None:
        return {}
    cfg_path = _config_dir / "config.json"
    if not cfg_path.exists():
        return {}
    try:
        return json.loads(cfg_path.read_text("utf-8"))
    except Exception:
        return {}


def _write_config(data: dict) -> None:
    """Persist config.json to the data directory."""
    if _config_dir is None:
        return
    cfg_path = _config_dir / "config.json"
    try:
        cfg_path.write_text(json.dumps(data, indent=2), "utf-8")
    except Exception as exc:
        logger.warning("Failed to write config: %s", exc)


def _push_recent_db(path_str: str) -> None:
    """Add a database path to the front of the recent_dbs list in config (max 8, deduplicated)."""
    cfg = _read_config()
    recents = cfg.get("recent_dbs", [])
    # Remove any existing entry for the same path (case-insensitive on Windows)
    recents = [r for r in recents if r.lower() != path_str.lower()]
    recents.insert(0, path_str)
    cfg["recent_dbs"] = recents[:8]
    _write_config(cfg)


def _window_title(db_path: Path) -> str:
    """Format the OS window title to show the active database path."""
    return f"Project Tracker v1.0 — {db_path}"


def _set_window_title(db_path: Path) -> None:
    """Update the pywebview window title, if a window is open."""
    try:
        import webview as _wv
        if _wv.windows:
            _wv.windows[0].title = _window_title(db_path)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Port discovery
# ---------------------------------------------------------------------------

def find_free_port() -> int:
    """Bind to port 0, let the OS assign an ephemeral port, return it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Data directory resolution
# ---------------------------------------------------------------------------

def resolve_data_dir() -> Path:
    """
    Return the directory where projects.db will be stored.

    - In a PyInstaller bundle: use %APPDATA%\\ProjectTracker\\
    - In script mode: use <project root>/data/
    """
    if getattr(sys, "frozen", False):
        # Running as a PyInstaller bundle
        appdata = os.environ.get("APPDATA", str(Path.home()))
        data_dir = Path(appdata) / "ProjectTracker"
    else:
        # Running as a plain Python script
        data_dir = Path(__file__).parent / "data"

    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


# ---------------------------------------------------------------------------
# Flask startup in background thread
# ---------------------------------------------------------------------------

def start_flask(port: int, stop_event: threading.Event) -> None:
    """
    Start the Flask development server on the given port.
    Runs until stop_event is set.
    """
    from app import create_app
    flask_app = create_app()

    # Use Werkzeug's underlying server so we can control shutdown
    from werkzeug.serving import make_server
    server = make_server("127.0.0.1", port, flask_app)
    server.timeout = 1  # Allow the loop below to check stop_event

    logger.info(f"Flask listening on http://127.0.0.1:{port}")

    while not stop_event.is_set():
        server.handle_request()

    logger.info("Flask server shutting down.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# JS API — Python methods callable from JavaScript via window.pywebview.api
# ---------------------------------------------------------------------------

class JsApi:
    """
    Methods exposed to the browser via pywebview's js_api mechanism.
    Called from JS as: await window.pywebview.api.methodName(args)
    """

    # ------------------------------------------------------------------
    # Database path query
    # ------------------------------------------------------------------

    def get_log_path(self) -> dict:
        """Return the path of the startup log file."""
        return {"path": str(_log_file)}

    def open_log_folder(self) -> dict:
        """Open the folder containing the log file in Windows Explorer."""
        import subprocess
        try:
            folder = str(_log_file.parent)
            subprocess.Popen(["explorer", folder])
            return {"ok": True}
        except Exception as exc:
            logger.error("open_log_folder error: %s", exc)
            return {"ok": False, "error": str(exc)}

    def get_db_path(self) -> dict:
        """Return the path of the currently active database."""
        from app.database import _db_path
        return {"path": str(_db_path) if _db_path else ""}

    # ------------------------------------------------------------------
    # New database
    # ------------------------------------------------------------------

    def new_db(self) -> dict:
        """
        Show a native Save dialog and create a brand-new empty database at
        the chosen path. The app switches to use this new database.

        Returns:
            {"ok": true, "path": "..."} on success
            {"ok": false, "error": "..."} on failure or cancellation
        """
        from app.database import set_db_path, init_db, is_local_mode
        if not is_local_mode():
            return {"ok": False, "error": "Not available in cloud mode."}
        import webview as _wv

        try:
            windows = _wv.windows
            if not windows:
                return {"ok": False, "error": "No active window"}

            result = windows[0].create_file_dialog(
                _wv.SAVE_DIALOG,
                directory="",
                save_filename="projects.db",
                file_types=("SQLite database (*.db)",),
            )
            if not result:
                return {"ok": False, "error": "cancelled"}

            new_path_str = result[0] if isinstance(result, (list, tuple)) else result
            if not new_path_str.lower().endswith(".db"):
                new_path_str += ".db"

            new_path = Path(new_path_str)

            # Switch to new path and initialise a fresh schema
            set_db_path(new_path)
            init_db()

            # Persist so the next launch reopens this database
            cfg = _read_config()
            cfg["last_db"] = str(new_path)
            _write_config(cfg)
            _push_recent_db(str(new_path))

            # Reflect new path in the window title bar
            _set_window_title(new_path)

            return {"ok": True, "path": str(new_path)}

        except Exception as exc:
            logger.error("new_db error: %s", exc)
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------
    # Export (backup) current database
    # ------------------------------------------------------------------

    def export_db(self) -> dict:
        """
        Show a native Save dialog and write a safe copy of the current
        database to the chosen path using SQLite's online backup API.

        Returns:
            {"ok": true, "path": "..."} on success
            {"ok": false, "error": "..."} on failure or cancellation
        """
        from app.database import _db_path, is_local_mode
        if not is_local_mode():
            return {"ok": False, "error": "Not available in cloud mode. Use Download Backup instead."}
        import sqlite3 as _sq
        import webview as _wv

        try:
            windows = _wv.windows
            if not windows:
                return {"ok": False, "error": "No active window"}

            result = windows[0].create_file_dialog(
                _wv.SAVE_DIALOG,
                directory="",
                save_filename="projects-backup.db",
                file_types=("SQLite database (*.db)",),
            )
            if not result:
                return {"ok": False, "error": "cancelled"}

            save_path = result[0] if isinstance(result, (list, tuple)) else result
            if not save_path.lower().endswith(".db"):
                save_path += ".db"

            # SQLite backup API — safe even with active connections
            src = _sq.connect(str(_db_path))
            dst = _sq.connect(save_path)
            src.backup(dst)
            dst.close()
            src.close()

            return {"ok": True, "path": save_path}

        except Exception as exc:
            logger.error("export_db error: %s", exc)
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------
    # Open (switch to) an existing database
    # ------------------------------------------------------------------

    def load_db(self) -> dict:
        """
        Show a native Open dialog and switch the app to use the chosen
        SQLite database file. Any outstanding migrations are applied.

        Returns:
            {"ok": true} on success
            {"ok": false, "error": "..."} on failure or cancellation
        """
        from app.database import set_db_path, init_db, is_local_mode
        if not is_local_mode():
            return {"ok": False, "error": "Not available in cloud mode."}
        import sqlite3 as _sq
        import webview as _wv

        try:
            windows = _wv.windows
            if not windows:
                return {"ok": False, "error": "No active window"}

            result = windows[0].create_file_dialog(
                _wv.OPEN_DIALOG,
                directory="",
                allow_multiple=False,
                file_types=("SQLite database (*.db)",),
            )
            if not result:
                return {"ok": False, "error": "cancelled"}

            load_path = result[0] if isinstance(result, (list, tuple)) else result

            # Validate it's a real SQLite file
            try:
                test = _sq.connect(load_path)
                test.execute("SELECT name FROM sqlite_master LIMIT 1")
                test.close()
            except _sq.DatabaseError:
                return {"ok": False, "error": "The selected file is not a valid SQLite database."}

            # Switch to the chosen file (no copy — the file itself becomes the active db)
            p = Path(load_path)
            set_db_path(p)

            # Apply any outstanding migrations (e.g. loading an older backup)
            init_db()

            # Persist so the next launch reopens this database
            cfg = _read_config()
            cfg["last_db"] = load_path
            _write_config(cfg)
            _push_recent_db(load_path)

            # Reflect new path in the window title bar
            _set_window_title(p)

            return {"ok": True}

        except Exception as exc:
            logger.error("load_db error: %s", exc)
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------
    # Recent databases
    # ------------------------------------------------------------------

    def get_recent_dbs(self) -> dict:
        """
        Return the list of recently opened databases, filtered to paths that
        still exist on disk.

        Returns:
            {"recents": [{"path": "...", "name": "filename.db"}, ...]}
        """
        cfg = _read_config()
        raw = cfg.get("recent_dbs", [])
        recents = []
        for p in raw:
            if Path(p).exists():
                recents.append({"path": p, "name": Path(p).name})
        return {"recents": recents}

    def open_recent_db(self, path: str) -> dict:
        """
        Switch the app to a specific database path without showing a file dialog.
        Used by the Recent submenu.

        Returns:
            {"ok": true} on success
            {"ok": false, "error": "..."} on failure
        """
        import sqlite3 as _sq
        from app.database import set_db_path, init_db

        try:
            p = Path(path)
            if not p.exists():
                return {"ok": False, "error": "File not found: " + path}

            # Validate it's a real SQLite file
            try:
                test = _sq.connect(str(p))
                test.execute("SELECT name FROM sqlite_master LIMIT 1")
                test.close()
            except _sq.DatabaseError:
                return {"ok": False, "error": "Not a valid SQLite database."}

            set_db_path(p)
            init_db()

            cfg = _read_config()
            cfg["last_db"] = path
            _write_config(cfg)
            _push_recent_db(path)

            _set_window_title(p)
            return {"ok": True}

        except Exception as exc:
            logger.error("open_recent_db error: %s", exc)
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------
    # Generic file save (used by export routes for JSON / Excel / PDF)
    # ------------------------------------------------------------------

    def save_file(self, base64_data: str, filename: str) -> dict:
        """
        Show a native Save File dialog and write the decoded bytes to the
        chosen path.

        Parameters (sent from JS):
            base64_data  – file bytes encoded as a base64 string
            filename     – suggested filename shown in the dialog

        Returns:
            {"ok": true, "path": "..."} on success
            {"ok": false, "error": "..."} on failure or cancellation
        """
        import base64 as _b64
        import webview as _wv

        try:
            # Determine the file-type filter from the extension
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            filter_map = {
                "pdf":  "PDF files (*.pdf)",
                "xlsx": "Excel files (*.xlsx)",
                "json": "JSON files (*.json)",
            }
            file_filter = filter_map.get(ext, "All files (*.*)")

            windows = _wv.windows
            if not windows:
                return {"ok": False, "error": "No active window"}

            result = windows[0].create_file_dialog(
                _wv.SAVE_DIALOG,
                directory="",
                save_filename=filename,
                file_types=(file_filter,),
            )

            if not result:
                return {"ok": False, "error": "cancelled"}

            save_path = result[0] if isinstance(result, (list, tuple)) else result

            # Ensure correct extension is appended if the user omitted it
            if ext and not save_path.lower().endswith("." + ext):
                save_path += "." + ext

            data = _b64.b64decode(base64_data)
            with open(save_path, "wb") as fh:
                fh.write(data)

            return {"ok": True, "path": save_path}

        except Exception as exc:
            logger.error("save_file error: %s", exc)
            return {"ok": False, "error": str(exc)}



def _best_gui() -> str:
    """
    Return the best available pywebview GUI backend for this machine.

    Preference order:
      1. edgechromium  — uses Edge WebView2; no .NET dependency; available on
                         all Windows 11 machines and Windows 10 with Edge.
      2. winforms      — uses .NET Framework + pythonnet; last resort.

    Strategy: try to actually import the edgechromium backend module first.
    If that works, use it. If it fails (e.g. WebView2 not installed),
    fall back to winforms.  Registry detection alone can miss some
    WebView2 installs (OS-bundled on Win11, non-standard paths, etc.).
    """
    # Attempt 1: try importing the edgechromium backend directly.
    # This is the most reliable test — if the import works, the backend works.
    try:
        import webview.platforms.edgechromium  # noqa: F401
        logger.info("edgechromium backend importable — using it.")
        return "edgechromium"
    except Exception as exc:
        logger.warning("edgechromium backend import failed: %s", exc)

    # Attempt 2: registry scan (broader than before — covers OS-bundled Win11 WebView2)
    try:
        import winreg
        _WV2_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for subpath in (
                rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_WV2_GUID}",
                rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{_WV2_GUID}",
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView",
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView",
            ):
                try:
                    winreg.OpenKey(hive, subpath)
                    logger.info("WebView2 found in registry — using edgechromium backend.")
                    return "edgechromium"
                except OSError:
                    pass
    except Exception:
        pass

    logger.warning(
        "WebView2 not found — falling back to winforms backend. "
        "This requires .NET Framework 4.8 + pythonnet. "
        "If you see a pythonnet error, install WebView2 Runtime from "
        "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    )
    return "winforms"


def main() -> None:
    global _config_dir

    _log_system_info()

    port = find_free_port()
    logger.info(f"Using port {port}")

    data_dir = resolve_data_dir()
    _config_dir = data_dir

    # Check config for last-used database path
    cfg = _read_config()

    # Check for saved PostgreSQL connection (cloud mode)
    pg_conn = cfg.get("pg_connection")
    if pg_conn:
        logger.info("PostgreSQL connection config found — starting in cloud mode")
        try:
            from app.database import set_postgres_config, init_db
            set_postgres_config(
                host=pg_conn["host"],
                port=int(pg_conn.get("port", 5432)),
                dbname=pg_conn["dbname"],
                user=pg_conn["user"],
                password=pg_conn["password"],
                ssl=pg_conn.get("ssl", True),
            )
            init_db()
            db_path = None
        except Exception as exc:
            logger.error("Failed to connect to PostgreSQL: %s — falling back to SQLite", exc)
            pg_conn = None

    if not pg_conn:
        last_db = cfg.get("last_db")
        if last_db and Path(last_db).exists():
            db_path = Path(last_db)
            logger.info(f"Resuming last database: {db_path}")
        else:
            db_path = data_dir / "projects.db"
            logger.info(f"Using default database: {db_path}")

        # Initialise the database (apply any outstanding migrations)
        from app.database import set_db_path, init_db
        set_db_path(db_path)
        init_db()

    # Start Flask in a background thread
    stop_event = threading.Event()
    flask_thread = threading.Thread(
        target=start_flask,
        args=(port, stop_event),
        daemon=True,
        name="flask-server",
    )
    flask_thread.start()

    # Give Flask a moment to bind before opening the window
    time.sleep(0.5)

    # Open the pywebview desktop window
    try:
        import webview

        def on_closed():
            """Called by pywebview when the window is closed."""
            logger.info("Window closed — stopping Flask.")
            stop_event.set()

        window = webview.create_window(
            title=_window_title(db_path),
            url=f"http://127.0.0.1:{port}/",
            js_api=JsApi(),
            width=1280,
            height=800,
            min_size=(900, 600),
        )
        window.events.closed += on_closed

        def on_shown():
            """Maximise the window as soon as it becomes visible."""
            try:
                window.maximize()
            except Exception as exc:
                logger.warning("Could not maximise window: %s", exc)

        window.events.shown += on_shown

        # Start the pywebview event loop (blocks until window is closed).
        # Select the backend based on whether WebView2 Runtime is installed:
        #   edgechromium – preferred; zero .NET dependency; always present on
        #                  Windows 11 and on any Windows 10 with Edge installed.
        #   winforms     – fallback for Windows 10 without WebView2; requires
        #                  .NET Framework 4.8 + pythonnet.
        webview.start(debug=False, gui=_best_gui())

    except ImportError:
        # Fallback for development without pywebview installed
        logger.warning(
            "pywebview not installed — open http://127.0.0.1:%d/ in your browser.", port
        )
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            stop_event.set()

    # Wait for Flask to finish
    flask_thread.join(timeout=5)
    logger.info("Application exited cleanly.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        logger.critical("UNHANDLED EXCEPTION — app crashed", exc_info=True)
        logger.critical("Log file is at: %s", _log_file)
        try:
            import ctypes
            msg = (
                f"Project Tracker crashed on startup.\n\n"
                f"Error: {exc}\n\n"
                f"Full details in the log file:\n{_log_file}\n\n"
                f"Please send this file when reporting the issue."
            )
            ctypes.windll.user32.MessageBoxW(0, msg, "Project Tracker — Startup Error", 0x10)
        except Exception:
            pass
        sys.exit(1)
