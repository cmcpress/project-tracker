@echo off
REM build.bat - Build ProjectTracker and produce an installer
REM Usage: build.bat           (full build)
REM        build.bat /apponly  (PyInstaller only, skip installer)

setlocal
cd /d "%~dp0"

echo.
echo ============================================================
echo  Project Tracker Build Script
echo ============================================================
echo.

set APPONLY=0
if /i "%1"=="/apponly" set APPONLY=1

REM --------------------------------------------------------
REM Step 1 - Python dependencies
REM --------------------------------------------------------
echo [Step 1/3] Installing dependencies...
python.exe -m pip install -r requirements.txt --user --quiet
if %ERRORLEVEL% NEQ 0 (
    echo FAILED at Step 1: pip install error.
    pause
    exit /b 1
)
echo [Step 1/3] Done.
echo.

REM --------------------------------------------------------
REM Step 2 - PyInstaller
REM --------------------------------------------------------
echo [Step 2/3] Running PyInstaller (this takes a few minutes)...
python.exe -m PyInstaller ProjectTracker.spec --noconfirm --clean
if %ERRORLEVEL% NEQ 0 (
    echo FAILED at Step 2: PyInstaller error.
    pause
    exit /b 1
)
echo [Step 2/3] Done. App bundle: dist\ProjectTracker\ProjectTracker.exe
echo.

if "%APPONLY%"=="1" (
    echo /apponly flag set - skipping installer.
    echo BUILD SUCCESSFUL.
    pause
    goto :eof
)

REM --------------------------------------------------------
REM Step 3 - Inno Setup
REM --------------------------------------------------------
echo [Step 3/3] Building installer...
echo.

echo Checking for WebView2 bootstrapper...
if not exist "installer\MicrosoftEdgeWebview2Setup.exe" (
    echo FAILED: installer\MicrosoftEdgeWebview2Setup.exe not found.
    pause
    exit /b 1
)
echo Found: installer\MicrosoftEdgeWebview2Setup.exe

echo Locating Inno Setup compiler...
set ISCC=
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if "%ISCC%"=="" if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe
if "%ISCC%"=="" if exist "%LocalAppData%\Programs\Inno Setup 6\ISCC.exe" set ISCC=%LocalAppData%\Programs\Inno Setup 6\ISCC.exe
if "%ISCC%"=="" for /f "delims=" %%i in ('where ISCC.exe 2^>nul') do set ISCC=%%i

if "%ISCC%"=="" (
    echo FAILED: ISCC.exe not found. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php
    pause
    exit /b 1
)
echo Found: %ISCC%

echo Creating output folder...
if not exist "installer\output" mkdir installer\output

echo Running ISCC...
"%ISCC%" installer\ProjectTracker.iss > installer\iscc.log 2>&1
type installer\iscc.log

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo FAILED at Step 3: Inno Setup error. See installer\iscc.log
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  BUILD SUCCESSFUL
echo  App bundle : dist\ProjectTracker\ProjectTracker.exe
echo  Installer  : installer\output\ProjectTracker_Setup_alpha_0.33.exe
echo ============================================================
echo.
pause
