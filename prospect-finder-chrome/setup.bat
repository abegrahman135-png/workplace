@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: ═══════════════════════════════════════════════════════════════════════════
::  ProspectFinder — One-Click Setup Script
::  Deploys Cloudflare Worker (R2 cache) + Backend Proxy (IP rotation)
:: ═══════════════════════════════════════════════════════════════════════════

title ProspectFinder Setup Wizard
color 0B

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
echo  ║   [1] Full Setup (Both Cloudflare Worker + Backend Proxy)            ║
echo  ║                                                                      ║
echo  ║   [2] Deploy Cloudflare Worker Only (R2 Cache)                       ║
echo  ║                                                                      ║
echo  ║   [3] Deploy Backend Proxy Only (IP Rotation)                        ║
echo  ║                                                                      ║
echo  ║   [4] Test Existing Setup                                            ║
echo  ║                                                                      ║
echo  ║   [5] View Status                                                    ║
echo  ║                                                                      ║
echo  ║   [6] Exit                                                           ║
echo  ║                                                                      ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.
set /p choice=  Select option [1-6]: 

if "%choice%"=="1" goto FULL_SETUP
if "%choice%"=="2" goto CF_ONLY
if "%choice%"=="3" goto BACKEND_ONLY
if "%choice%"=="4" goto TEST_SETUP
if "%choice%"=="5" goto VIEW_STATUS
if "%choice%"=="6" goto EXIT
echo Invalid option. Press any key to try again...
pause >nul
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:FULL_SETUP
cls
echo.
echo  ╔══════════════════════════════════════════════════════════════════════╗
echo  ║                    FULL SETUP — Step by Step                         ║
echo  ╚══════════════════════════════════════════════════════════════════════╝
echo.
echo  This will set up:
echo    • Cloudflare Worker (R2 cache — free, zero egress)
echo    • Backend Proxy (IP rotation — residential proxies)
echo.
echo  Prerequisites:
echo    • Node.js installed (https://nodejs.org)
echo    • Cloudflare account (https://dash.cloudflare.com)
echo    • Instagram sessionid cookie
echo.
pause

:: Step 1: Check Node.js
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [1/8] Checking Node.js...
echo  ──────────────────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js not found! Install from https://nodejs.org
    pause
    goto MENU
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  ✅ Node.js %NODE_VER% found

:: Step 2: Install Wrangler
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [2/8] Installing Wrangler (Cloudflare CLI)...
echo  ──────────────────────────────────────────────────────────────────────
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing wrangler...
    call npm install -g wrangler
    if errorlevel 1 (
        echo  ❌ Failed to install wrangler
        pause
        goto MENU
    )
)
for /f "tokens=*" %%i in ('wrangler --version 2^>nul') do set WRANGLER_VER=%%i
echo  ✅ Wrangler installed: %WRANGLER_VER%

:: Step 3: Login to Cloudflare
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [3/8] Login to Cloudflare...
echo  ──────────────────────────────────────────────────────────────────────
echo  A browser window will open. Click "Authorize".
echo.
pause
call wrangler login
if errorlevel 1 (
    echo  ❌ Login failed
    pause
    goto MENU
)
echo  ✅ Logged in to Cloudflare

:: Step 4: Get Instagram session
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [4/8] Instagram Session Setup
echo  ──────────────────────────────────────────────────────────────────────
echo.
echo  To get your sessionid:
echo    1. Open instagram.com in Chrome (make sure you're logged in)
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

:: Step 5: Create R2 bucket
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [5/8] Creating R2 bucket for profile cache...
echo  ──────────────────────────────────────────────────────────────────────
cd /d "%~dp0prospect-finder-chrome\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul
echo  ✅ R2 bucket ready

:: Step 6: Add session secret
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [6/8] Storing Instagram session as encrypted secret...
echo  ──────────────────────────────────────────────────────────────────────
echo %IG_SESSION% | call wrangler secret put IG_SESSION_1
if errorlevel 1 (
    echo  ⚠️  Secret may already exist, continuing...
)
echo  ✅ Session stored securely

:: Step 7: Deploy Cloudflare Worker
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [7/8] Deploying Cloudflare Worker...
echo  ──────────────────────────────────────────────────────────────────────
call wrangler deploy
if errorlevel 1 (
    echo  ❌ Deploy failed
    pause
    goto MENU
)

:: Extract worker URL
echo.
echo  ✅ Cloudflare Worker deployed!
echo.
set /p CF_WORKER_URL=  Paste your Worker URL (e.g., https://pf-profile-proxy.xxx.workers.dev): 

:: Step 8: Setup Backend Proxy
echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  [8/8] Backend Proxy Setup (IP Rotation)
echo  ──────────────────────────────────────────────────────────────────────
echo.
echo  The backend proxy routes requests through residential proxy IPs
echo  when Instagram rate limits you.
echo.
echo  Do you have a residential proxy service? (BrightData/Oxylabs/Smartproxy/IPRoyal)
echo.
echo  [1] Yes — I have proxy credentials
echo  [2] No  — Skip backend proxy for now
echo.
set /p PROXY_CHOICE=  Select [1-2]: 

set BACKEND_URL=
if "%PROXY_CHOICE%"=="1" (
    echo.
    set /p PROXY_URLS=  Enter proxy URL(s) (comma-separated, format: http://user:pass@host:port): 
    if not "!PROXY_URLS!"=="" (
        cd /d "%~dp0prospect-finder-chrome\workers\backend-proxy"
        
        :: Create .env file
        (
            echo IG_SESSIONS=%IG_SESSION%
            echo PROXY_URLS=!PROXY_URLS!
            echo RATE_LIMIT_PER_SESSION=20
            echo CACHE_TTL=86400
            echo PORT=3000
        ) > .env
        
        echo.
        echo  Installing backend dependencies...
        call npm install
        
        echo.
        echo  Starting backend proxy...
        echo  Press Ctrl+C to stop, or leave it running in this window.
        echo.
        start /b cmd /c "cd /d "%~dp0prospect-finder-chrome\workers\backend-proxy" && npm start"
        timeout /t 3 >nul
        
        set BACKEND_URL=http://localhost:3000
        echo  ✅ Backend proxy running on http://localhost:3000
    )
)

:: Summary
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
echo  ║  ─────────────────────────────────────────────────────────────────── ║
echo  ║                                                                      ║
echo  ║  NEXT STEPS:                                                         ║
echo  ║                                                                      ║
echo  ║  1. Open Chrome → chrome://extensions/                               ║
echo  ║  2. Load unpacked → select prospect-finder-chrome folder             ║
echo  ║  3. Open Dashboard → Settings                                        ║
echo  ║  4. Paste R2 Cache URL: %CF_WORKER_URL%
echo  ║  5. Click "Test connection" → should show ✅                          ║
echo  ║  6. Click "Save settings"                                            ║
echo  ║                                                                      ║
if not "%BACKEND_URL%"=="" (
echo  ║  7. Paste Backend URL: %BACKEND_URL%
echo  ║  8. Click "Save settings"                                            ║
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

:: Check wrangler
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing wrangler...
    call npm install -g wrangler
)

:: Login
echo  [1/5] Login to Cloudflare...
call wrangler login

:: Get session
echo.
echo  [2/5] Instagram sessionid:
set /p IG_SESSION=  Paste here: 

:: Create R2
echo.
echo  [3/5] Creating R2 bucket...
cd /d "%~dp0prospect-finder-chrome\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul

:: Add secret
echo.
echo  [4/5] Storing session...
echo %IG_SESSION% | call wrangler secret put IG_SESSION_1

:: Deploy
echo.
echo  [5/5] Deploying...
call wrangler deploy

echo.
echo  ✅ Done! Copy the Worker URL and paste it in the extension settings.
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
echo    • IPRoyal ($5/mo)     — https://iproyal.com
echo    • Smartproxy ($12/mo) — https://smartproxy.com
echo    • BrightData ($15/mo) — https://brightdata.com
echo    • Oxylabs ($15/mo)    — https://oxylabs.io
echo.
pause

echo.
set /p IG_SESSION=  Paste your Instagram sessionid: 
echo.
set /p PROXY_URLS=  Paste proxy URL(s) (comma-separated): 

cd /d "%~dp0prospect-finder-chrome\workers\backend-proxy"

:: Create .env
(
    echo IG_SESSIONS=%IG_SESSION%
    echo PROXY_URLS=%PROXY_URLS%
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  Installing dependencies...
call npm install

echo.
echo  ══════════════════════════════════════════════════════════════════════
echo  ✅ Backend proxy configured!
echo  ══════════════════════════════════════════════════════════════════════
echo.
echo  Starting server...
echo  Press Ctrl+C to stop.
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

set /p CF_URL=  Cloudflare Worker URL (or press Enter to skip): 
if not "%CF_URL%"=="" (
    echo.
    echo  Testing %CF_URL%/health ...
    echo.
    curl -s "%CF_URL%/health" 2>nul || echo  ❌ Connection failed
    echo.
)

set /p BACKEND_URL=  Backend Proxy URL (or press Enter to skip): 
if not "%BACKEND_URL%"=="" (
    echo.
    echo  Testing %BACKEND_URL%/health ...
    echo.
    curl -s "%BACKEND_URL%/health" 2>nul || echo  ❌ Connection failed
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

:: Check Node
node --version >nul 2>&1
if errorlevel 1 (echo  ❌ Node.js: Not installed) else (
    for /f "tokens=*" %%i in ('node --version') do echo  ✅ Node.js: %%i
)

:: Check Wrangler
wrangler --version >nul 2>&1
if errorlevel 1 (echo  ❌ Wrangler: Not installed) else (
    for /f "tokens=*" %%i in ('wrangler --version 2^>nul') do echo  ✅ Wrangler: %%i
)

:: Check npm
npm --version >nul 2>&1
if errorlevel 1 (echo  ❌ npm: Not installed) else (
    for /f "tokens=*" %%i in ('npm --version') do echo  ✅ npm: %%i
)

:: Check git
git --version >nul 2>&1
if errorlevel 1 (echo  ❌ Git: Not installed) else (
    for /f "tokens=*" %%i in ('git --version') do echo  ✅ Git: %%i
)

echo.
echo  ──────────────────────────────────────────────────────────────────────
echo  Extension files:
echo  ──────────────────────────────────────────────────────────────────────

if exist "%~dp0prospect-finder-chrome\manifest.json" (
    echo  ✅ Extension: Found
) else (
    echo  ❌ Extension: Not found (expected at prospect-finder-chrome/)
)

if exist "%~dp0prospect-finder-chrome\workers\profile-proxy\src\index.js" (
    echo  ✅ CF Worker: Found
) else (
    echo  ❌ CF Worker: Not found
)

if exist "%~dp0prospect-finder-chrome\workers\backend-proxy\src\server.js" (
    echo  ✅ Backend:   Found
) else (
    echo  ❌ Backend:   Not found
)

echo.
pause
goto MENU

:: ═══════════════════════════════════════════════════════════════════════════
:EXIT
echo.
echo  Goodbye! 👋
echo.
exit /b 0
