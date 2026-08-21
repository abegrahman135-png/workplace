@echo off
setlocal enabledelayedexpansion
title ProspectFinder Setup Wizard v2.1
color 0B

:: Keep window open no matter what
if not "%~1"=="KEEP_OPEN" (
    cmd /k "%~f0" KEEP_OPEN
    exit /b
)

set "SCRIPT_DIR=%~dp0"
set "EXT_DIR=%SCRIPT_DIR%prospect-finder-chrome"
set "LOG_FILE=%SCRIPT_DIR%setup.log"

:: Start logging
echo ======================================== > "%LOG_FILE%"
echo ProspectFinder Setup Log >> "%LOG_FILE%"
echo %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

:MENU
cls
echo.
echo  ========================================================
echo          PROSPECTFINDER - SETUP WIZARD v2.1
echo  ========================================================
echo.
echo   [1] Full Setup (Cloudflare Worker + Backend Proxy)
echo.
echo   [2] Cloudflare Worker Only (R2 Cache - Free)
echo.
echo   [3] Backend Proxy Only (IP Rotation)
echo.
echo   [4] Install/Repair Dependencies Only
echo.
echo   [5] Test Existing Setup
echo.
echo   [6] View System Status
echo.
echo   [7] Open Chrome Extensions Page
echo.
echo   [8] Exit
echo.
echo  ========================================================
echo.
set /p "choice=  Select option [1-8]: "

if "!choice!"=="1" goto FULL_SETUP
if "!choice!"=="2" goto CF_ONLY
if "!choice!"=="3" goto BACKEND_ONLY
if "!choice!"=="4" goto INSTALL_DEPS
if "!choice!"=="5" goto TEST_SETUP
if "!choice!"=="6" goto VIEW_STATUS
if "!choice!"=="7" (
    start "" "chrome://extensions/"
    goto MENU
)
if "!choice!"=="8" goto EXIT
echo.
echo  Invalid option.
timeout /t 2 >nul
goto MENU

:: ================================================================
::  HELPER: Safe command runner with timeout
:: ================================================================
:RUN_CMD
:: Usage: call :RUN_CMD "description" "command"
echo  %~1
%~2
if errorlevel 1 (
    echo  WARNING: Command may have failed, continuing...
    echo  [%date% %time%] WARNING: %~1 failed >> "%LOG_FILE%"
)
exit /b 0

:: ================================================================
::  HELPER: Check if file exists, show result
:: ================================================================
:CHECK_FILE
:: Usage: call :CHECK_FILE "label" "path"
if exist "%~2" (
    echo  [OK] %~1
    exit /b 0
) else (
    echo  [X]  %~1 - Not found
    exit /b 1
)

:: ================================================================
::  INSTALL DEPENDENCIES
:: ================================================================
:INSTALL_DEPS
cls
echo.
echo  ========================================================
echo         INSTALLING DEPENDENCIES
echo  ========================================================
echo.

:: Check Node.js
echo  [Step 1/3] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Node.js is NOT installed.
    echo.
    echo  Node.js is required. Download from: https://nodejs.org
    echo.
    echo  [1] Open download page in browser
    echo  [2] I already installed it, check again
    echo  [3] Back to menu
    echo.
    set /p "node_choice=  Select [1-3]: "
    if "!node_choice!"=="1" (
        start "" "https://nodejs.org/en/download"
        echo.
        echo  Download and install Node.js, then come back.
        echo  Press any key when done...
        pause >nul
        goto INSTALL_DEPS
    )
    if "!node_choice!"=="2" goto INSTALL_DEPS
    goto MENU
)
for /f "tokens=*" %%i in ('node --version') do echo  OK - Node.js %%i
echo  [%date% %time%] Node.js OK >> "%LOG_FILE%"

:: Check/Install Wrangler
echo.
echo  [Step 2/3] Checking Wrangler (Cloudflare CLI)...
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Wrangler not found. Installing...
    echo  This takes 30-60 seconds. Please wait...
    echo.

    :: Try install with progress
    call npm install -g wrangler 2>&1

    :: Verify
    wrangler --version >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  First install attempt failed. Trying with --allow-scripts...
        echo.
        call npm install -g --allow-scripts=esbuild,workerd wrangler 2>&1

        wrangler --version >nul 2>&1
        if errorlevel 1 (
            echo.
            echo  ========================================================
            echo  ERROR: Could not install Wrangler automatically.
            echo  ========================================================
            echo.
            echo  Please open a NEW Command Prompt and run:
            echo.
            echo    npm install -g wrangler
            echo.
            echo  Then come back to this script.
            echo.
            echo  Press any key to return to menu...
            pause >nul
            echo  [%date% %time%] Wrangler install FAILED >> "%LOG_FILE%"
            goto MENU
        )
    )
    echo  [%date% %time%] Wrangler installed >> "%LOG_FILE%"
)
for /f "tokens=*" %%i in ('wrangler --version 2^>nul') do echo  OK - Wrangler %%i

:: Install project dependencies
echo.
echo  [Step 3/3] Installing project dependencies...
call :INSTALL_PROJECT_DEPS

echo.
echo  ========================================================
echo   All dependencies installed successfully!
echo  ========================================================
echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:INSTALL_PROJECT_DEPS
:: CF Worker
if exist "%EXT_DIR%\workers\profile-proxy\package.json" (
    if not exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
        echo  Installing CF Worker dependencies...
        pushd "%EXT_DIR%\workers\profile-proxy"
        call npm install 2>&1
        popd
        if exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
            echo  OK - CF Worker deps installed
        ) else (
            echo  WARNING - CF Worker deps may have issues
            echo  [%date% %time%] CF Worker deps warning >> "%LOG_FILE%"
        )
    ) else (
        echo  OK - CF Worker deps already installed
    )
) else (
    echo  SKIP - CF Worker package.json not found
)

:: Backend Proxy
if exist "%EXT_DIR%\workers\backend-proxy\package.json" (
    if not exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
        echo  Installing Backend Proxy dependencies...
        pushd "%EXT_DIR%\workers\backend-proxy"
        call npm install 2>&1
        popd
        if exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
            echo  OK - Backend Proxy deps installed
        ) else (
            echo  WARNING - Backend Proxy deps may have issues
            echo  [%date% %time%] Backend Proxy deps warning >> "%LOG_FILE%"
        )
    ) else (
        echo  OK - Backend Proxy deps already installed
    )
) else (
    echo  SKIP - Backend Proxy package.json not found
)
exit /b 0

:: ================================================================
::  FULL SETUP
:: ================================================================
:FULL_SETUP
cls
echo.
echo  ========================================================
echo         FULL SETUP - Step by Step
echo  ========================================================
echo.
echo  [%date% %time%] Full setup started >> "%LOG_FILE%"
echo.

:: ── Step 1: Dependencies ──────────────────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 1/8] Checking dependencies...
echo  ──────────────────────────────────────────────────────

node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Node.js required. Opening download page...
    start "" "https://nodejs.org/en/download"
    echo.
    echo  Install Node.js, then run this script again.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)
echo  OK - Node.js found

wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing Wrangler... please wait...
    call npm install -g wrangler 2>&1
    wrangler --version >nul 2>&1
    if errorlevel 1 (
        call npm install -g --allow-scripts=esbuild,workerd wrangler 2>&1
    )
)
echo  OK - Wrangler ready

call :INSTALL_PROJECT_DEPS
echo  OK - All dependencies ready
echo.

:: ── Step 2: Cloudflare Login ─────────────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 2/8] Login to Cloudflare
echo  ──────────────────────────────────────────────────────
echo.
echo  A browser window will open.
echo  Click "Authorize" to allow Wrangler access.
echo.
echo  Press any key to open browser...
pause >nul

call wrangler login 2>&1
if errorlevel 1 (
    echo.
    echo  Login failed or was cancelled.
    echo.
    echo  [1] Try login again
    echo  [2] Back to menu
    echo.
    set /p "login_retry=  Select [1-2]: "
    if "!login_retry!"=="1" goto FULL_SETUP
    goto MENU
)
echo  OK - Logged in to Cloudflare
echo  [%date% %time%] Cloudflare login OK >> "%LOG_FILE%"
echo.

:: ── Step 3: Instagram Session ────────────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 3/8] Instagram Session ID
echo  ──────────────────────────────────────────────────────
echo.
echo  How to get your sessionid:
echo    1. Open instagram.com in Chrome (logged in)
echo    2. Press F12 key
echo    3. Click "Application" tab
echo    4. Click "Cookies" then "instagram.com"
echo    5. Find "sessionid" in the list
echo    6. Copy the Value (long text)
echo.
set /p "IG_SESSION=  Paste sessionid here: "
if "!IG_SESSION!"=="" (
    echo.
    echo  ERROR: Session ID is required.
    echo.
    echo  [1] Try again
    echo  [2] Back to menu
    echo.
    set /p "session_retry=  Select [1-2]: "
    if "!session_retry!"=="1" goto FULL_SETUP
    goto MENU
)
echo  OK - Session ID received
echo  [%date% %time%] Session ID received >> "%LOG_FILE%"
echo.

:: ── Step 4: Verify extension folder ─────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 4/8] Verifying extension files...
echo  ──────────────────────────────────────────────────────

set "ALL_OK=1"
if not exist "%EXT_DIR%\manifest.json" (
    echo  [X] Extension folder not found
    set "ALL_OK=0"
)
if not exist "%EXT_DIR%\workers\profile-proxy\src\index.js" (
    echo  [X] CF Worker source not found
    set "ALL_OK=0"
)
if not exist "%EXT_DIR%\workers\profile-proxy\wrangler.toml" (
    echo  [X] wrangler.toml not found
    set "ALL_OK=0"
)
if "!ALL_OK!"=="0" (
    echo.
    echo  ERROR: Missing files. Make sure you extracted the full zip.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)
echo  OK - All files present
echo.

:: ── Step 5: Create R2 bucket ────────────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 5/8] Creating R2 bucket...
echo  ──────────────────────────────────────────────────────

cd /d "%EXT_DIR%\workers\profile-proxy"
if errorlevel 1 (
    echo  ERROR: Cannot access workers\profile-proxy
    echo  Press any key...
    pause >nul
    goto MENU
)

call wrangler r2 bucket create pf-profile-cache 2>&1
echo  OK - R2 bucket ready
echo  [%date% %time%] R2 bucket created >> "%LOG_FILE%"
echo.

:: ── Step 6: Store session ───────────────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 6/8] Storing session as encrypted secret...
echo  ──────────────────────────────────────────────────────

echo !IG_SESSION!| call wrangler secret put IG_SESSION_1 2>&1
echo  OK - Session stored securely
echo  [%date% %time%] Session secret stored >> "%LOG_FILE%"
echo.

:: ── Step 7: Deploy Worker ───────────────────────────────
echo  ──────────────────────────────────────────────────────
echo  [Step 7/8] Deploying Cloudflare Worker...
echo  ──────────────────────────────────────────────────────
echo.
echo  This takes 10-30 seconds...
echo.

call wrangler deploy 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Deploy failed.
    echo.
    echo  Common fixes:
    echo    - Make sure you logged in to Cloudflare
    echo    - Check your internet connection
    echo    - Try running: wrangler login
    echo.
    echo  [1] Try deploy again
    echo  [2] Back to menu
    echo.
    set /p "deploy_retry=  Select [1-2]: "
    if "!deploy_retry!"=="1" (
        call wrangler deploy 2>&1
    )
)
echo.
echo  Worker deployed!
echo  [%date% %time%] Worker deployed >> "%LOG_FILE%"
echo.

:: Get worker URL
echo  ──────────────────────────────────────────────────────
echo  What is your Worker URL?
echo  (Look for https://pf-profile-proxy.xxx.workers.dev above)
echo  ──────────────────────────────────────────────────────
echo.
set /p "CF_WORKER_URL=  Paste URL here: "
if "!CF_WORKER_URL!"=="" set "CF_WORKER_URL=https://your-worker.workers.dev"

:: ── Step 8: Backend Proxy ───────────────────────────────
echo.
echo  ──────────────────────────────────────────────────────
echo  [Step 8/8] Backend Proxy (IP Rotation - Optional)
echo  ──────────────────────────────────────────────────────
echo.
echo  Residential proxy rotates your IP when rate limits hit.
echo  Skip if you don't have one yet.
echo.
echo   [1] IPRoyal     - $5/mo  (cheapest)
echo   [2] Smartproxy  - $12/mo (good balance)
echo   [3] BrightData  - $15/mo (best quality)
echo   [4] Oxylabs     - $15/mo (large pool)
echo   [5] Skip for now
echo.
set /p "PROXY_CHOICE=  Select [1-5]: "

set "BACKEND_URL="
if "!PROXY_CHOICE!"=="5" goto SKIP_BACKEND

echo.
set /p "PROXY_URLS=  Paste proxy URL(s): "
if "!PROXY_URLS!"=="" goto SKIP_BACKEND

cd /d "%EXT_DIR%\workers\backend-proxy"
if errorlevel 1 (
    echo  ERROR: Cannot access backend-proxy folder
    goto SKIP_BACKEND
)

:: Create .env
(
    echo IG_SESSIONS=!IG_SESSION!
    echo PROXY_URLS=!PROXY_URLS!
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  Starting backend proxy in new window...
start "PF Backend" cmd /c "cd /d "%EXT_DIR%\workers\backend-proxy" && echo Starting... && npm start && echo. && echo Press any key to close... && pause"
timeout /t 3 >nul
set "BACKEND_URL=http://localhost:3000"
echo  OK - Backend proxy running
echo  [%date% %time%] Backend proxy started >> "%LOG_FILE%"

:SKIP_BACKEND

:: ── Summary ─────────────────────────────────────────────
cls
echo.
echo  ========================================================
echo         SETUP COMPLETE!
echo  ========================================================
echo.
echo   Cloudflare Worker:
echo     !CF_WORKER_URL!
echo.
if not "!BACKEND_URL!"=="" (
    echo   Backend Proxy:
    echo     !BACKEND_URL!
    echo.
)
echo  ──────────────────────────────────────────────────────
echo   NEXT STEPS:
echo  ──────────────────────────────────────────────────────
echo.
echo   1. Open Chrome
echo   2. Go to: chrome://extensions/
echo   3. Enable "Developer mode" (top right)
echo   4. Click "Load unpacked"
echo   5. Select: prospect-finder-chrome
echo   6. Click extension icon
echo   7. Click "Open Dashboard"
echo   8. Go to "Settings" tab
echo   9. Scroll to "Enrichment proxy"
echo  10. Paste: !CF_WORKER_URL!
echo  11. Click "Test connection"
echo  12. Click "Save settings"
echo.
if not "!BACKEND_URL!"=="" (
    echo  13. Paste Backend: !BACKEND_URL!
    echo  14. Click "Save settings"
)
echo  ========================================================
echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:: ================================================================
::  CF WORKER ONLY
:: ================================================================
:CF_ONLY
cls
echo.
echo  ========================================================
echo         CLOUDFLARE WORKER DEPLOYMENT
echo  ========================================================
echo.

:: Dependencies
echo  [1/6] Checking dependencies...
node --version >nul 2>&1
if errorlevel 1 (
    echo  Node.js required.
    start "" "https://nodejs.org/en/download"
    echo  Press any key after installing Node.js...
    pause >nul
    goto CF_ONLY
)
echo  OK - Node.js found

wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing Wrangler... please wait...
    call npm install -g wrangler 2>&1
    wrangler --version >nul 2>&1
    if errorlevel 1 (
        call npm install -g --allow-scripts=esbuild,workerd wrangler 2>&1
    )
)
echo  OK - Wrangler ready

call :INSTALL_PROJECT_DEPS

:: Login
echo.
echo  [2/6] Login to Cloudflare
echo.
echo  Press any key to open browser...
pause >nul
call wrangler login 2>&1
if errorlevel 1 (
    echo  Login failed. Press any key to retry...
    pause >nul
    call wrangler login 2>&1
)
echo  OK - Logged in

:: Session
echo.
echo  [3/6] Instagram Session ID
echo.
echo  Get from: instagram.com / F12 / Application / Cookies / sessionid
echo.
set /p "IG_SESSION=  Paste sessionid: "
if "!IG_SESSION!"=="" (
    echo  Session ID required. Press any key...
    pause >nul
    goto CF_ONLY
)
echo  OK

:: R2
echo.
echo  [4/6] Creating R2 bucket...
cd /d "%EXT_DIR%\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>&1
echo  OK

:: Secret
echo.
echo  [5/6] Storing session...
echo !IG_SESSION!| call wrangler secret put IG_SESSION_1 2>&1
echo  OK

:: Deploy
echo.
echo  [6/6] Deploying... please wait...
echo.
call wrangler deploy 2>&1
if errorlevel 1 (
    echo.
    echo  Deploy failed. Press any key to retry...
    pause >nul
    call wrangler deploy 2>&1
)

echo.
echo  ========================================================
echo   Done! Copy the Worker URL above.
echo   Paste it in: Dashboard / Settings / Enrichment proxy
echo  ========================================================
echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:: ================================================================
::  BACKEND PROXY ONLY
:: ================================================================
:BACKEND_ONLY
cls
echo.
echo  ========================================================
echo         BACKEND PROXY (IP Rotation)
echo  ========================================================
echo.
echo  Residential proxy rotates your IP on rate limits.
echo.
echo  Providers:
echo    IPRoyal     - $5/mo  - https://iproyal.com
echo    Smartproxy  - $12/mo - https://smartproxy.com
echo    BrightData  - $15/mo - https://brightdata.com
echo    Oxylabs     - $15/mo - https://oxylabs.io
echo.
echo  Press any key to continue...
pause >nul

node --version >nul 2>&1
if errorlevel 1 (
    echo  Node.js required.
    start "" "https://nodejs.org/en/download"
    echo  Press any key after installing...
    pause >nul
    goto BACKEND_ONLY
)

echo.
set /p "IG_SESSION=  Instagram sessionid: "
if "!IG_SESSION!"=="" (
    echo  Required. Press any key...
    pause >nul
    goto BACKEND_ONLY
)

echo.
set /p "PROXY_URLS=  Proxy URL(s): "
if "!PROXY_URLS!"=="" (
    echo  Required. Press any key...
    pause >nul
    goto BACKEND_ONLY
)

cd /d "%EXT_DIR%\workers\backend-proxy"
call :INSTALL_PROJECT_DEPS

(
    echo IG_SESSIONS=!IG_SESSION!
    echo PROXY_URLS=!PROXY_URLS!
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  ========================================================
echo   Starting Backend Proxy...
echo   Press Ctrl+C to stop.
echo  ========================================================
echo.
call npm start
echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:: ================================================================
::  TEST SETUP
:: ================================================================
:TEST_SETUP
cls
echo.
echo  ========================================================
echo         TEST EXISTING SETUP
echo  ========================================================
echo.

set /p "CF_URL=  Cloudflare Worker URL (Enter to skip): "
if not "!CF_URL!"=="" (
    echo.
    echo  Testing health endpoint...
    echo.
    powershell -Command "try { $r = Invoke-RestMethod -Uri '!CF_URL!/health' -TimeoutSec 10; Write-Host '  RESULT:'; $r | ConvertTo-Json } catch { Write-Host '  ERROR:' $_.Exception.Message }"
    echo.
)

set /p "BE_URL=  Backend Proxy URL (Enter to skip): "
if not "!BE_URL!"=="" (
    echo.
    echo  Testing health endpoint...
    echo.
    powershell -Command "try { $r = Invoke-RestMethod -Uri '!BE_URL!/health' -TimeoutSec 10; Write-Host '  RESULT:'; $r | ConvertTo-Json } catch { Write-Host '  ERROR:' $_.Exception.Message }"
    echo.
)

echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:: ================================================================
::  VIEW STATUS
:: ================================================================
:VIEW_STATUS
cls
echo.
echo  ========================================================
echo         SYSTEM STATUS
echo  ========================================================
echo.

node --version >nul 2>&1
if errorlevel 1 (echo  [X]  Node.js: Not installed) else (
    for /f "tokens=*" %%i in ('node --version') do echo  [OK] Node.js: %%i
)

wrangler --version >nul 2>&1
if errorlevel 1 (echo  [X]  Wrangler: Not installed) else (
    echo  [OK] Wrangler: Installed
)

git --version >nul 2>&1
if errorlevel 1 (echo  [X]  Git: Not installed) else (
    echo  [OK] Git: Installed
)

echo.
echo  Project Files:
echo.

if exist "%EXT_DIR%\manifest.json" (echo  [OK] Extension) else (echo  [X] Extension)
if exist "%EXT_DIR%\workers\profile-proxy\src\index.js" (echo  [OK] CF Worker) else (echo  [X] CF Worker)
if exist "%EXT_DIR%\workers\backend-proxy\src\server.js" (echo  [OK] Backend) else (echo  [X] Backend)
if exist "%EXT_DIR%\workers\profile-proxy\node_modules" (echo  [OK] CF Worker deps) else (echo  [!] CF deps missing)
if exist "%EXT_DIR%\workers\backend-proxy\node_modules" (echo  [OK] Backend deps) else (echo  [!] Backend deps missing)

echo.
echo  Log file: %LOG_FILE%
echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:: ================================================================
::  EXIT
:: ================================================================
:EXIT
cls
echo.
echo  Goodbye!
echo.
echo  [%date% %time%] Script exited >> "%LOG_FILE%"
timeout /t 2 >nul
exit /b 0
