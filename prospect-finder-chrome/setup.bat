@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: ═══════════════════════════════════════════════════════════════════════════
::  ProspectFinder — One-Click Setup Script
::  Auto-installs all dependencies + deploys Cloudflare Worker + Backend Proxy
:: ═══════════════════════════════════════════════════════════════════════════

title ProspectFinder Setup Wizard
color 0B

:: Get script directory
set "SCRIPT_DIR=%~dp0"
set "EXT_DIR=%SCRIPT_DIR%prospect-finder-chrome"

:MENU
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                                                                      ║
echo  ║   ██████╗ ███████╗    ███████╗███████╗████████╗██╗   ██╗██████╗     ║
echo  ║   ██╔══██╗██╔════╝    ██╔════╝██╔════╝╚══██╔══╝██║   ██║██╔══██╗    ║
echo  ║   ██████╔╝█████╗      ███████╗█████╗     ██║   ██║   ██║██████╔╝    ║
echo  ║   ██╔═══╝ ██╔══╝      ╚════██║██╔══╝     ██║   ██║   ██║██╔═══╝     ║
echo  ║   ██║     ███████╗    ███████║███████╗   ██║   ╚██████╔╝██║         ║
echo  ║   ╚═╝     ╚══════╝    ╚══════╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝         ║
echo  ║                                                                      ║
echo  ║            ProspectFinder — Setup Wizard v2.0                        ║
echo  ║                                                                      ║
echo  ╠══════════════════════════════════════════════════════════════════════╣
echo  ║                                                                      ║
echo  ║   [1] Full Setup (Cloudflare Worker + Backend Proxy)                 ║
echo  ║                                                                      ║
echo  ║   [2] Deploy Cloudflare Worker Only (R2 Cache)                       ║
echo  ║                                                                      ║
echo  ║   [3] Deploy Backend Proxy Only (IP Rotation)                        ║
echo  ║                                                                      ║
echo  ║   [4] Install/Repair Dependencies Only                               ║
echo  ║                                                                      ║
echo  ║   [5] Test Existing Setup                                            ║
echo  ║                                                                      ║
echo  ║   [6] View Status                                                    ║
echo  ║                                                                      ║
echo  ║   [7] Exit                                                           ║
echo  ║                                                                      ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.
set /p choice=  Select option [1-7]: 

if "%choice%"=="1" goto FULL_SETUP
if "%choice%"=="2" goto CF_ONLY
if "%choice%"=="3" goto BACKEND_ONLY
if "%choice%"=="4" goto INSTALL_DEPS
if "%choice%"=="5" goto TEST_SETUP
if "%choice%"=="6" goto VIEW_STATUS
if "%choice%"=="7" goto EXIT
echo  Invalid option. Press any key...
pause >nul
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
::  DEPENDENCY INSTALLATION
:: ═══════════════════════════════════════════════════════════════════════════
:INSTALL_DEPS
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                   INSTALLING DEPENDENCIES                            ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.

:: ── Check/Install Node.js ──────────────────────────────────────────────────
echo  ──────────────────────────────────────────────────────────────────────
echo  [1/4] Checking Node.js...
echo  ──────────────────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js not found.
    echo.
    echo  Downloading Node.js installer...
    echo  Please install Node.js from https://nodejs.org
    echo.
    echo  Opening download page...
    start https://nodejs.org/en/download
    echo.
    echo  After installing Node.js, run this script again.
    pause
    goto MENU
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  ✅ Node.js %NODE_VER% found

:: ── Check/Install npm ──────────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [2/4] Checking npm...
echo  ──────────────────────────────────────────────────────────────────────
npm --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ npm not found. It should come with Node.js.
    echo  Try reinstalling Node.js from https://nodejs.org
    pause
    goto MENU
)
for /f "tokens=*" %%i in ('npm --version') do set NPM_VER=%%i
echo  ✅ npm %NPM_VER% found

:: ── Check/Install Wrangler ─────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [3/4] Checking Wrangler (Cloudflare CLI)...
echo  ──────────────────────────────────────────────────────────────────────
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  ⏳ Installing Wrangler...
    call npm install -g wrangler
    if errorlevel 1 (
        echo  ⚠️  Standard install failed, trying with --allow-scripts...
        call npm install -g --allow-scripts=esbuild,workerd wrangler
    )
    wrangler --version >nul 2>&1
    if errorlevel 1 (
        echo  ❌ Failed to install Wrangler
        echo  Try manually: npm install -g wrangler
        pause
        goto MENU
    )
)
for /f "tokens=*" %%i in ('wrangler --version 2^>nul') do set WRANGLER_VER=%%i
echo  ✅ Wrangler installed

:: ── Install npm dependencies for workers ───────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [4/4] Installing project dependencies...
echo  ──────────────────────────────────────────────────────────────────────

if exist "%EXT_DIR%\workers\profile-proxy\package.json" (
    echo  Installing CF Worker dependencies...
    cd /d "%EXT_DIR%\workers\profile-proxy"
    call npm install --silent 2>nul
    echo  ✅ CF Worker dependencies installed
)

if exist "%EXT_DIR%\workers\backend-proxy\package.json" (
    echo  Installing Backend Proxy dependencies...
    cd /d "%EXT_DIR%\workers\backend-proxy"
    call npm install --silent 2>nul
    echo  ✅ Backend Proxy dependencies installed
)

echo.
echo  ══════════════════════════════════════════════════════════════════════
echo  ✅ All dependencies installed!
echo  ══════════════════════════════════════════════════════════════════════
echo.
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:FULL_SETUP
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                    FULL SETUP — Step by Step                         ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.

:: ── Auto-install dependencies ──────────────────────────────────────────────
echo  ──────────────────────────────────────────────────────────────────────
echo  [1/9] Checking and installing dependencies...
echo  ──────────────────────────────────────────────────────────────────────

:: Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js required. Opening download page...
    start https://nodejs.org/en/download
    echo  Install Node.js and run this script again.
    pause
    goto MENU
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  ✅ Node.js %NODE_VER%

:: Wrangler
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  ⏳ Installing Wrangler...
    call npm install -g --allow-scripts=esbuild,workerd wrangler 2>nul
    if errorlevel 1 (
        call npm install -g wrangler 2>nul
    )
)
echo  ✅ Wrangler ready

:: Worker deps
if exist "%EXT_DIR%\workers\profile-proxy\package.json" (
    cd /d "%EXT_DIR%\workers\profile-proxy"
    if not exist "node_modules" (
        echo  ⏳ Installing CF Worker dependencies...
        call npm install --silent 2>nul
    )
)
if exist "%EXT_DIR%\workers\backend-proxy\package.json" (
    cd /d "%EXT_DIR%\workers\backend-proxy"
    if not exist "node_modules" (
        echo  ⏳ Installing Backend Proxy dependencies...
        call npm install --silent 2>nul
    )
)
echo  ✅ All dependencies ready

:: ── Cloudflare Login ───────────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [2/9] Login to Cloudflare...
echo  ──────────────────────────────────────────────────────────────────────
echo  A browser window will open. Click "Authorize".
echo.
pause
call wrangler login
if errorlevel 1 (
    echo  ❌ Login failed. Try again.
    pause
    goto MENU
)
echo  ✅ Logged in

:: ── Instagram Session ──────────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [3/9] Instagram Session Setup
echo  ──────────────────────────────────────────────────────────────────────
echo.
echo  To get your sessionid:
echo    1. Open instagram.com (make sure you're logged in)
echo    2. Press F12 → Application → Cookies → instagram.com
echo    3. Find "sessionid" → copy the Value
echo.
set /p IG_SESSION=  Paste your sessionid here: 
if "%IG_SESSION%"=="" (
    echo  ❌ Session ID is required
    pause
    goto MENU
)
echo  ✅ Session ID received

:: ── Create R2 bucket ───────────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [4/9] Creating R2 bucket...
echo  ──────────────────────────────────────────────────────────────────────
cd /d "%EXT_DIR%\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul
echo  ✅ R2 bucket ready

:: ── Store session secret ───────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [5/9] Storing session as encrypted secret...
echo  ──────────────────────────────────────────────────────────────────────
echo %IG_SESSION% | call wrangler secret put IG_SESSION_1 2>nul
echo  ✅ Session stored securely

:: ── Deploy Cloudflare Worker ───────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [6/9] Deploying Cloudflare Worker...
echo  ──────────────────────────────────────────────────────────────────────
call wrangler deploy
if errorlevel 1 (
    echo  ❌ Deploy failed
    pause
    goto MENU
)
echo.
echo  ✅ Worker deployed!
echo.
set /p CF_WORKER_URL=  Paste your Worker URL (https://pf-profile-proxy.xxx.workers.dev): 

:: ── Backend Proxy Setup ────────────────────────────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [7/9] Backend Proxy (IP Rotation)
echo  ──────────────────────────────────────────────────────────────────────
echo.
echo  Residential proxy rotates your IP when rate limits hit.
echo.
echo  Providers:
echo    [1] IPRoyal     — $5/mo  — https://iproyal.com
echo    [2] Smartproxy  — $12/mo — https://smartproxy.com
echo    [3] BrightData  — $15/mo — https://brightdata.com
echo    [4] Oxylabs     — $15/mo — https://oxylabs.io
echo    [5] Skip — I don't have a proxy yet
echo.
set /p PROXY_CHOICE=  Select [1-5]: 

set BACKEND_URL=
if "%PROXY_CHOICE%"=="5" (
    echo  ⏭️  Skipping backend proxy
    goto SKIP_BACKEND
)

echo.
set /p PROXY_URLS=  Paste your proxy URL(s) (comma-separated): 
if "%PROXY_URLS%"=="" (
    echo  ⏭️  No proxy URL provided, skipping
    goto SKIP_BACKEND
)

cd /d "%EXT_DIR%\workers\backend-proxy"

:: Create .env
(
    echo IG_SESSIONS=%IG_SESSION%
    echo PROXY_URLS=%PROXY_URLS%
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [8/9] Starting Backend Proxy...
echo  ──────────────────────────────────────────────────────────────────────
echo.
echo  The backend proxy will run in a separate window.
echo  Keep it open while scanning.
echo.

:: Start in a new window
start "ProspectFinder Backend Proxy" cmd /c "cd /d "%EXT_DIR%\workers\backend-proxy" && npm start"
timeout /t 3 >nul

set BACKEND_URL=http://localhost:3000
echo  ✅ Backend proxy running on http://localhost:3000

:SKIP_BACKEND

:: ── Summary ────────────────────────────────────────────────────────────────
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                                                                      ║
echo  ║                    ✅ SETUP COMPLETE!                                 ║
echo  ║                                                                      ║
echo  ╠══════════════════════════════════════════════════════════════════════╣
echo  ║                                                                      ║
echo  ║  Cloudflare Worker (R2 Cache):                                       ║
echo  ║    %CF_WORKER_URL%
echo  ║                                                                      ║
if not "%BACKEND_URL%"=="" (
echo  ║  Backend Proxy (IP Rotation):                                        ║
echo  ║    %BACKEND_URL%
echo  ║                                                                      ║
)
echo  ║  ─────────────────────────────────────────────────────────────────  ║
echo  ║                                                                      ║
echo  ║  NEXT STEPS:                                                         ║
echo  ║                                                                      ║
echo  ║  1. Open Chrome → chrome://extensions/                               ║
echo  ║  2. Enable "Developer mode" (top right)                              ║
echo  ║  3. Click "Load unpacked"                                            ║
echo  ║  4. Select the "prospect-finder-chrome" folder                       ║
echo  ║  5. Click extension icon → Open Dashboard                            ║
echo  ║  6. Go to Settings tab                                               ║
echo  ║  7. Scroll to "Enrichment proxy"                                     ║
echo  ║  8. Paste: %CF_WORKER_URL%
echo  ║  9. Click "Test connection"                                          ║
echo  ║ 10. Click "Save settings"                                            ║
echo  ║                                                                      ║
if not "%BACKEND_URL%"=="" (
echo  ║ 11. Paste Backend URL: %BACKEND_URL%
echo  ║ 12. Click "Save settings"                                            ║
)
echo  ║                                                                      ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:CF_ONLY
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║              CLOUDFLARE WORKER DEPLOYMENT                            ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.

:: Auto-install
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js required. Opening download page...
    start https://nodejs.org/en/download
    pause
    goto MENU
)

wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  ⏳ Installing Wrangler...
    call npm install -g --allow-scripts=esbuild,workerd wrangler 2>nul
)

if exist "%EXT_DIR%\workers\profile-proxy\package.json" (
    cd /d "%EXT_DIR%\workers\profile-proxy"
    if not exist "node_modules" (
        call npm install --silent 2>nul
    )
)

echo  [1/5] Login to Cloudflare...
call wrangler login

echo.
echo  [2/5] Instagram sessionid:
set /p IG_SESSION=  Paste here: 

echo.
echo  [3/5] Creating R2 bucket...
cd /d "%EXT_DIR%\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul

echo.
echo  [4/5] Storing session...
echo %IG_SESSION% | call wrangler secret put IG_SESSION_1 2>nul

echo.
echo  [5/5] Deploying...
call wrangler deploy

echo.
echo  ✅ Done! Copy the Worker URL and paste it in extension Settings.
echo.
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:BACKEND_ONLY
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║              BACKEND PROXY DEPLOYMENT (IP Rotation)                  ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.
echo  You need a residential proxy service:
echo    • IPRoyal     — $5/mo  — https://iproyal.com
echo    • Smartproxy  — $12/mo — https://smartproxy.com
echo    • BrightData  — $15/mo — https://brightdata.com
echo    • Oxylabs     — $15/mo — https://oxylabs.io
echo.

:: Auto-install node
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js required. Opening download page...
    start https://nodejs.org/en/download
    pause
    goto MENU
)

pause

echo.
set /p IG_SESSION=  Paste your Instagram sessionid: 
echo.
set /p PROXY_URLS=  Paste proxy URL(s) (comma-separated): 

cd /d "%EXT_DIR%\workers\backend-proxy"

:: Auto-install deps
if not exist "node_modules" (
    echo  ⏳ Installing dependencies...
    call npm install --silent 2>nul
)

:: Create .env
(
    echo IG_SESSIONS=%IG_SESSION%
    echo PROXY_URLS=%PROXY_URLS%
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  ══════════════════════════════════════════════════════════════════════
echo  ✅ Starting Backend Proxy...
echo  ══════════════════════════════════════════════════════════════════════
echo.
call npm start
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:TEST_SETUP
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                      TESTING EXISTING SETUP                          ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.

set /p CF_URL=  Cloudflare Worker URL (or Enter to skip): 
if not "%CF_URL%"=="" (
    echo.
    echo  Testing %CF_URL%/health ...
    echo.
    curl -s "%CF_URL%/health" 2>nul
    if errorlevel 1 (
        echo.
        echo  ❌ Connection failed. Check the URL.
    )
    echo.
)

set /p BACKEND_URL=  Backend Proxy URL (or Enter to skip): 
if not "%BACKEND_URL%"=="" (
    echo.
    echo  Testing %BACKEND_URL%/health ...
    echo.
    curl -s "%BACKEND_URL%/health" 2>nul
    if errorlevel 1 (
        echo.
        echo  ❌ Connection failed. Is the backend running?
    )
    echo.
)

echo.
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:VIEW_STATUS
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                         SYSTEM STATUS                                ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.

:: Node
node --version >nul 2>&1
if errorlevel 1 (echo  ❌ Node.js:    Not installed) else (
    for /f "tokens=*" %%i in ('node --version') do echo  ✅ Node.js:    %%i
)

:: npm
npm --version >nul 2>&1
if errorlevel 1 (echo  ❌ npm:        Not installed) else (
    for /f "tokens=*" %%i in ('npm --version') do echo  ✅ npm:        %%i
)

:: Wrangler
wrangler --version >nul 2>&1
if errorlevel 1 (echo  ❌ Wrangler:   Not installed) else (
    echo  ✅ Wrangler:   Installed
)

:: Git
git --version >nul 2>&1
if errorlevel 1 (echo  ❌ Git:        Not installed) else (
    echo  ✅ Git:        Installed
)

echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  Project Files:
echo  ──────────────────────────────────────────────────────────────────────

if exist "%EXT_DIR%\manifest.json" (
    echo  ✅ Extension:       Found
) else (
    echo  ❌ Extension:       Not found
)

if exist "%EXT_DIR%\workers\profile-proxy\src\index.js" (
    echo  ✅ CF Worker:       Found
) else (
    echo  ❌ CF Worker:       Not found
)

if exist "%EXT_DIR%\workers\backend-proxy\src\server.js" (
    echo  ✅ Backend Proxy:   Found
) else (
    echo  ❌ Backend Proxy:   Not found
)

if exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
    echo  ✅ CF Worker deps:  Installed
) else (
    echo  ⚠️  CF Worker deps:  Not installed (run option 4)
)

if exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
    echo  ✅ Backend deps:    Installed
) else (
    echo  ⚠️  Backend deps:    Not installed (run option 4)
)

echo.
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:EXIT
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                                                                      ║
echo  ║                    Goodbye! See you next time 👋                      ║
echo  ║                                                                      ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.
timeout /t 2 >nul
exit /b 0
