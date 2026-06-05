; ProjectTracker.iss — Inno Setup installer script
;
; Produces:  installer\output\ProjectTracker_Setup_alpha_0.32.exe
;
; Requirements:
;   1. Run build.bat first so dist\ProjectTracker\ exists.
;   2. Place MicrosoftEdgeWebView2RuntimeInstallerX64.exe in the installer\
;      folder (download from https://go.microsoft.com/fwlink/p/?LinkId=2124703).
;   3. Compile with Inno Setup 6: right-click this file → Compile,
;      or run: iscc ProjectTracker.iss
;
; What the installer does:
;   - Installs to %ProgramFiles%\ProjectTracker\
;   - Creates a Start Menu group with a launch shortcut and uninstaller
;   - Creates a Desktop shortcut
;   - Checks for WebView2 Runtime; installs it silently if absent
;   - Registers an uninstaller (Add/Remove Programs)
;   - Handles upgrades: detects a previous installation and replaces it cleanly
;   - User data (%APPDATA%\ProjectTracker\) is never touched by install or uninstall

; ---------------------------------------------------------------------------
; Version constants — update these with each build
; ---------------------------------------------------------------------------
#define AppName       "Project Tracker"
#define AppVersion    "alpha 0.33"
#define AppPublisher  "Jeremy Biggs"
#define AppExeName    "ProjectTracker.exe"

; ---------------------------------------------------------------------------
; Setup section
; ---------------------------------------------------------------------------
[Setup]
AppId={{A3F1C2D4-7B8E-4F9A-B2C3-D4E5F6A7B8C9}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion=0.33.0.0
VersionInfoDescription=Project Tracker Installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion=0.33.0.0

; Install location
DefaultDirName={autopf}\ProjectTracker
DefaultGroupName={#AppName}
DisableProgramGroupPage=no

; Output
OutputDir=output
OutputBaseFilename=ProjectTracker_Setup_alpha_0.33

; Visuals
SetupIconFile=ProjectTracker.ico
WizardStyle=modern
WizardSizePercent=100
WizardImageFile=..\splash.png
WizardSmallImageFile=..\splash.png

; Compression
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes

; Privileges — install to Program Files requires admin
PrivilegesRequired=admin

; Upgrade handling — close running app before install
CloseApplications=yes
CloseApplicationsFilter=*ProjectTracker.exe*
RestartApplications=no

; Uninstall
Uninstallable=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}
CreateUninstallRegKey=yes

; ---------------------------------------------------------------------------
; Languages
; ---------------------------------------------------------------------------
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; ---------------------------------------------------------------------------
; Tasks (optional actions the user can tick/untick)
; ---------------------------------------------------------------------------
[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"

; ---------------------------------------------------------------------------
; Files
; ---------------------------------------------------------------------------
[Files]
; Main application — everything in the PyInstaller onedir output
Source: "..\dist\ProjectTracker\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; WebView2 bootstrapper — extracted to temp, deleted after install
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; \
    Flags: deleteafterinstall

; ---------------------------------------------------------------------------
; Shortcuts
; ---------------------------------------------------------------------------
[Icons]
; Start Menu
Name: "{group}\{#AppName}"; \
    Filename: "{app}\{#AppExeName}"; \
    IconFilename: "{app}\{#AppExeName}"; \
    WorkingDir: "{app}"; \
    Comment: "Open Project Tracker"

Name: "{group}\Uninstall {#AppName}"; \
    Filename: "{uninstallexe}"

; Desktop (only if task ticked)
Name: "{commondesktop}\{#AppName}"; \
    Filename: "{app}\{#AppExeName}"; \
    IconFilename: "{app}\{#AppExeName}"; \
    WorkingDir: "{app}"; \
    Comment: "Open Project Tracker"; \
    Tasks: desktopicon

; ---------------------------------------------------------------------------
; Run after install
; ---------------------------------------------------------------------------
[Run]
; Install WebView2 silently if not already present
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; \
    Parameters: "/silent /install"; \
    StatusMsg: "Installing Microsoft WebView2 Runtime..."; \
    Check: not IsWebView2Installed

; Offer to launch the app at the end of the wizard
Filename: "{app}\{#AppExeName}"; \
    Description: "Launch {#AppName}"; \
    Flags: nowait postinstall skipifsilent

; ---------------------------------------------------------------------------
; Pascal script — helper functions
; ---------------------------------------------------------------------------
[Code]

{ Check all known registry locations for a WebView2 installation }
function IsWebView2Installed: Boolean;
var
  Dummy: String;
begin
  Result :=
    RegQueryStringValue(HKLM,
      'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'pv', Dummy) or
    RegQueryStringValue(HKCU,
      'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'pv', Dummy) or
    RegQueryStringValue(HKLM,
      'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'pv', Dummy) or
    RegKeyExists(HKLM,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView') or
    RegKeyExists(HKLM,
      'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView');
end;

{ Before install: if a previous version is installed, uninstall it cleanly }
function InitializeSetup: Boolean;
var
  PrevUninstaller: String;
  ResultCode: Integer;
begin
  Result := True;
  if RegQueryStringValue(HKLM,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{A3F1C2D4-7B8E-4F9A-B2C3-D4E5F6A7B8C9}_is1',
      'UninstallString', PrevUninstaller) then
  begin
    if MsgBox('A previous version of {#AppName} is installed. It will be ' +
              'removed before the new version is installed. Continue?',
              mbConfirmation, MB_YESNO) = IDYES then
    begin
      Exec(RemoveQuotes(PrevUninstaller), '/SILENT', '', SW_HIDE,
           ewWaitUntilTerminated, ResultCode);
    end
    else
      Result := False;
  end;
end;
