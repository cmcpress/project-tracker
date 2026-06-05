# -*- mode: python ; coding: utf-8 -*-
# ProjectTracker.spec -- PyInstaller build specification.
#
# Build with:
#     build.bat
#   or directly:
#     python -m PyInstaller ProjectTracker.spec --noconfirm --clean
#
# Output:  dist/ProjectTracker/ProjectTracker.exe  (one-directory bundle)
#
# The one-directory (onedir) layout is preferred over --onefile because
# pywebview loads Edge/WebView2 at runtime (no extraction delay) and startup
# is much faster. To ship the app, zip the dist/ProjectTracker/ folder.

from pathlib import Path

ROOT = Path(SPECPATH)   # project root -- same directory as this .spec file

# ---------------------------------------------------------------------------
# Data files to bundle alongside the executable
# ---------------------------------------------------------------------------

datas = [
    (str(ROOT / "static"),    "static"),
    (str(ROOT / "templates"), "templates"),
]

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

a = Analysis(
    [str(ROOT / "main.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        # Flask application modules
        "app",
        "app.__init__",
        "app.database",
        "app.models",
        "app.routes.projects",
        "app.routes.tasks",
        "app.routes.dependencies",
        "app.routes.people",
        "app.routes.items",
        "app.routes.export",
        "app.routes.categories",
        "app.routes.db",
        "app.routes.phases",
        "app.routes.unavailability",
        "app.routes.baselines",
        "app.routes.settings",
        "app.routes.templates",
        "app.routes.links",
        # Flask / Werkzeug internals sometimes missed by hooks
        "werkzeug.serving",
        "werkzeug.debug",
        "jinja2.ext",
        # reportlab (PDF export) -- pure Python, no DLL dependencies
        "reportlab",
        "reportlab.lib",
        "reportlab.lib.colors",
        "reportlab.lib.pagesizes",
        "reportlab.lib.styles",
        "reportlab.lib.units",
        "reportlab.platypus",
        "reportlab.platypus.tables",
        "reportlab.pdfgen",
        "reportlab.pdfbase",
        "reportlab.pdfbase.ttfonts",
        # openpyxl (Excel export)
        "openpyxl",
        "openpyxl.styles",
        "openpyxl.utils",
        # pywebview — bundle both backends so the app works on all machines.
        # _best_gui() in main.py picks at runtime:
        #   edgechromium  on machines with WebView2 (all Win 11, most Win 10)
        #   winforms      on Win 10 machines without WebView2 (needs .NET 4.8)
        "webview",
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        # Standard library
        "sqlite3",
        "_sqlite3",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "unittest",
        "pydoc",
        "doctest",
        # Do NOT exclude "distutils" -- PyInstaller has an internal hook that
        # aliases it to setuptools._vendor.distutils; excluding it causes a
        # ValueError conflict during analysis.
        "weasyprint",   # not used -- switched to reportlab
        "cairosvg",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # required for onedir mode
    name="ProjectTracker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,              # UPX disabled — corrupts python3xx.dll on Windows
    upx_exclude=[],
    console=False,          # no terminal window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,              # set to "assets/icon.ico" if you add one
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,              # UPX disabled — corrupts python3xx.dll on Windows
    upx_exclude=[],
    name="ProjectTracker",
)
