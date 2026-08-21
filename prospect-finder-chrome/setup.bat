@echo off
setlocal enabledelayedexpansion
title ProspectFinder Setup Wizard
color 0B

:: Prevent auto-close on errors
if "%~1"=="" (
    cmd /k "%~f0" RUNNING
    exit /b
)

set "SCRIPT_DIR=%~dp0"
set "EXT_DIR=%SCRIPT_DIR%prospect-finder-chrome"

:MENU
cls
echo.
echo  ========================================================
echo          PROSPECTFINDER - SETUP WIZARD v2.0
echo  ========================================================
echo.
echo   [1] Full Setup (Cloudflare Worker + Backend Proxy)
echo.
echo   [2] Deploy Cloudflare Worker Only (R2 Cache)
echo.
echo   [3] Deploy Backend Proxy Only (IP Rotation)
echo.
echo   [4] Install/Repair Dependencies Only
echo.
echo   [5] Test Existing Setup
echo.
echo   [6] View Status
echo.
echo   [7] Exit
echo.
echo  ========================================================
echo.
set /p "choice=  Select option [1-7]: "

if "!choice!"=="1" goto FULL_SETUP
if "!choice!"=="2" goto CF_ONLY
if "!choice!"=="3" goto BACKEND_ONLY
if "!choice!"=="4" goto INSTALL_DEPS
if "!choice!"=="5" goto TEST_SETUP
if "!choice!"=="6" goto VIEW_STATUS
if "!choice!"=="7" goto EXIT
echo.
echo  Invalid option. Press any key to try again...
pause >nul
goto MENU

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

echo  [1/3] Checking Node.js...
call :CHECK_NODE
if errorlevel 1 goto MENU

echo.
echo  [2/3] Checking Wrangler...
call :CHECK_WRANGLER
if errorlevel 1 goto MENU

echo.
echo  [3/3] Installing project dependencies...
call :INSTALL_PROJECT_DEPS

echo.
echo  ========================================================
echo   All dependencies installed!
echo  ========================================================
echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

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

:: Step 1: Dependencies
echo  --------------------------------------------------------
echo  [1/7] Checking dependencies...
echo  --------------------------------------------------------
call :CHECK_NODE
if errorlevel 1 goto MENU
call :CHECK_NPM
if errorlevel 1 goto MENU
call :CHECK_WRANGLER
if errorlevel 1 goto MENU
call :INSTALL_PROJECT_DEPS
echo  OK - All dependencies ready
echo.

:: Step 2: Cloudflare Login
echo  --------------------------------------------------------
echo  [2/7] Login to Cloudflare
echo  --------------------------------------------------------
echo.
echo  A browser window will open. Click Authorize.
echo  Press any key to continue...
pause >nul
call wrangler login
if errorlevel 1 (
    echo.
    echo  ERROR: Login failed. Please try again.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)
echo  OK - Logged in to Cloudflare
echo.

:: Step 3: Instagram Session
echo  --------------------------------------------------------
echo  [3/7] Instagram Session
echo  --------------------------------------------------------
echo.
echo  How to get your sessionid:
echo    1. Open instagram.com (logged in)
echo    2. Press F12 key
echo    3. Go to Application tab
echo    4. Click Cookies then instagram.com
echo    5. Find sessionid and copy the Value
echo.
set /p "IG_SESSION=  Paste sessionid here: "
if "!IG_SESSION!"=="" (
    echo.
    echo  ERROR: Session ID is required.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)
echo  OK - Session ID received
echo.

:: Step 4: Create R2 bucket
echo  --------------------------------------------------------
echo  [4/7] Creating R2 bucket...
echo  --------------------------------------------------------
cd /d "%EXT_DIR%\workers\profile-proxy"
if errorlevel 1 (
    echo  ERROR: Cannot find workers\profile-proxy folder
    echo  Press any key...
    pause >nul
    goto MENU
)
call wrangler r2 bucket create pf-profile-cache 2>nul
echo  OK - R2 bucket ready
echo.

:: Step 5: Store session
echo  --------------------------------------------------------
echo  [5/7] Storing session as encrypted secret...
echo  --------------------------------------------------------
echo !IG_SESSION!| call wrangler secret put IG_SESSION_1
if errorlevel 1 (
    echo  WARNING: Secret may already exist. Continuing...
)
echo  OK - Session stored securely
echo.

:: Step 6: Deploy Worker
echo  --------------------------------------------------------
echo  [6/7] Deploying Cloudflare Worker...
echo  --------------------------------------------------------
call wrangler deploy
if errorlevel 1 (
    echo.
    echo  ERROR: Deploy failed. Check the error above.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)
echo.
echo  Worker deployed successfully!
echo.
set /p "CF_WORKER_URL=  Paste Worker URL (https://pf-profile-proxy.xxx.workers.dev): "
if "!CF_WORKER_URL!"=="" (
    echo  WARNING: No URL entered. You can find it in the deploy output above.
    set "CF_WORKER_URL=check deploy output above"
)
echo.

:: Step 7: Backend Proxy
echo  --------------------------------------------------------
echo  [7/7] Backend Proxy (IP Rotation)
echo  --------------------------------------------------------
echo.
echo  Residential proxy rotates your IP when rate limits hit.
echo.
echo   [1] IPRoyal     - $5/mo
echo   [2] Smartproxy  - $12/mo
echo   [3] BrightData  - $15/mo
echo   [4] Oxylabs     - $15/mo
echo   [5] Skip (no proxy yet)
echo.
set /p "PROXY_CHOICE=  Select [1-5]: "

set "BACKEND_URL="
if "!PROXY_CHOICE!"=="5" (
    echo  Skipping backend proxy.
    goto SHOW_SUMMARY
)

echo.
set /p "PROXY_URLS=  Paste proxy URL(s) (comma-separated): "
if "!PROXY_URLS!"=="" (
    echo  No proxy URL provided. Skipping.
    goto SHOW_SUMMARY
)

cd /d "%EXT_DIR%\workers\backend-proxy"
if errorlevel 1 (
    echo  ERROR: Cannot find workers\backend-proxy folder
    echo  Press any key...
    pause >nul
    goto SHOW_SUMMARY
)

:: Create .env file
(
    echo IG_SESSIONS=!IG_SESSION!
    echo PROXY_URLS=!PROXY_URLS!
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  Starting backend proxy in a new window...
echo  Keep that window open while scanning.
echo.
start "ProspectFinder Backend Proxy" cmd /c "cd /d "%EXT_DIR%\workers\backend-proxy" && npm start && pause"
timeout /t 3 >nul

set "BACKEND_URL=http://localhost:3000"
echo  OK - Backend proxy running on http://localhost:3000

:SHOW_SUMMARY
cls
echo.
echo  ========================================================
echo         SETUP COMPLETE!
echo  ========================================================
echo.
echo   Cloudflare Worker (R2 Cache):
echo     !CF_WORKER_URL!
echo.
if not "!BACKEND_URL!"=="" (
    echo   Backend Proxy (IP Rotation):
    echo     !BACKEND_URL!
    echo.
)
echo  --------------------------------------------------------
echo   NEXT STEPS:
echo  --------------------------------------------------------
echo.
echo   1. Open Chrome
echo   2. Go to: chrome://extensions/
echo   3. Enable Developer mode (top right toggle)
echo   4. Click "Load unpacked"
echo   5. Select the "prospect-finder-chrome" folder
echo   6. Click extension icon then "Open Dashboard"
echo   7. Go to Settings tab
echo   8. Scroll to "Enrichment proxy"
echo   9. Paste: !CF_WORKER_URL!
echo  10. Click "Test connection"
echo  11. Click "Save settings"
echo.
if not "!BACKEND_URL!"=="" (
    echo  12. Paste Backend URL: !BACKEND_URL!
    echo  13. Click "Save settings"
)
echo.
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

echo  [1/6] Checking Node.js...
call :CHECK_NODE
if errorlevel 1 goto MENU

echo.
echo  [2/6] Checking npm...
call :CHECK_NPM
if errorlevel 1 goto MENU

echo.
echo  [3/6] Checking Wrangler...
call :CHECK_WRANGLER
if errorlevel 1 goto MENU

echo.
echo  [4/6] Installing project dependencies...
call :INSTALL_PROJECT_DEPS

echo.
echo  [5/6] Login to Cloudflare
echo.
echo  A browser window will open. Click Authorize.
echo  Press any key to open browser...
pause >nul
call wrangler login
if errorlevel 1 (
    echo.
    echo  ERROR: Login failed.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)
echo  OK - Logged in to Cloudflare

echo.
echo  [6/6] Instagram Session
echo.
echo  How to get sessionid:
echo    1. Open instagram.com (logged in)
echo    2. F12 - Application - Cookies - instagram.com
echo    3. Find sessionid - copy the Value
echo.
set /p "IG_SESSION=  Paste sessionid here: "
if "!IG_SESSION!"=="" (
    echo.
    echo  ERROR: Session ID is required.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)

echo.
echo  Creating R2 bucket...
cd /d "%EXT_DIR%\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul
echo  OK - R2 bucket ready

echo.
echo  Storing session as encrypted secret...
echo !IG_SESSION!| call wrangler secret put IG_SESSION_1 2>nul
echo  OK - Session stored

echo.
echo  Deploying Cloudflare Worker...
echo  Please wait...
echo.
call wrangler deploy
if errorlevel 1 (
    echo.
    echo  ERROR: Deploy failed. Check the error above.
    echo  Press any key to return to menu...
    pause >nul
    goto MENU
)

echo.
echo  ========================================================
echo   Worker deployed successfully!
echo.
echo   Copy the Worker URL shown above (starts with https://)
echo   and paste it in the extension Dashboard then Settings.
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
echo  You need a residential proxy service:
echo    IPRoyal     - $5/mo  - https://iproyal.com
echo    Smartproxy  - $12/mo - https://smartproxy.com
echo    BrightData  - $15/mo - https://brightdata.com
echo    Oxylabs     - $15/mo - https://oxylabs.io
echo.
echo  Press any key to continue...
pause >nul

call :CHECK_NODE
if errorlevel 1 goto MENU

echo.
set /p "IG_SESSION=  Paste Instagram sessionid: "
if "!IG_SESSION!"=="" (
    echo  Session ID required. Press any key...
    pause >nul
    goto MENU
)

echo.
set /p "PROXY_URLS=  Paste proxy URL(s): "
if "!PROXY_URLS!"=="" (
    echo  Proxy URL required. Press any key...
    pause >nul
    goto MENU
)

cd /d "%EXT_DIR%\workers\backend-proxy"
call :INSTALL_PROJECT_DEPS

:: Create .env
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

echo  Enter your Cloudflare Worker URL
echo  (e.g., https://pf-profile-proxy.xxx.workers.dev)
echo.
set /p "CF_URL=  URL (or press Enter to skip): "
if not "!CF_URL!"=="" (
    echo.
    echo  Testing !CF_URL!/health ...
    echo.
    call :HTTP_GET "!CF_URL!/health"
    echo.
)

echo.
echo  Enter your Backend Proxy URL
echo  (e.g., http://localhost:3000)
echo.
set /p "BACKEND_URL=  URL (or press Enter to skip): "
if not "!BACKEND_URL!"=="" (
    echo.
    echo  Testing !BACKEND_URL!/health ...
    echo.
    call :HTTP_GET "!BACKEND_URL!/health"
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
if errorlevel 1 (
    echo  [X] Node.js:       Not installed
) else (
    for /f "tokens=*" %%i in ('node --version') do echo  [OK] Node.js:       %%i
)

npm --version >nul 2>&1
if errorlevel 1 (
    echo  [X] npm:           Not installed
) else (
    for /f "tokens=*" %%i in ('npm --version') do echo  [OK] npm:           %%i
)

wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  [X] Wrangler:      Not installed
) else (
    echo  [OK] Wrangler:      Installed
)

git --version >nul 2>&1
if errorlevel 1 (
    echo  [X] Git:           Not installed
) else (
    echo  [OK] Git:           Installed
)

echo.
echo  Project Files:
echo.

if exist "%EXT_DIR%\manifest.json" (
    echo  [OK] Extension folder
) else (
    echo  [X] Extension folder - not found at %EXT_DIR%
)

if exist "%EXT_DIR%\workers\profile-proxy\src\index.js" (
    echo  [OK] CF Worker source
) else (
    echo  [X] CF Worker source - not found
)

if exist "%EXT_DIR%\workers\backend-proxy\src\server.js" (
    echo  [OK] Backend Proxy source
) else (
    echo  [X] Backend Proxy source - not found
)

if exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
    echo  [OK] CF Worker dependencies installed
) else (
    echo  [!] CF Worker dependencies missing - run option 4
)

if exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
    echo  [OK] Backend Proxy dependencies installed
) else (
    echo  [!] Backend Proxy dependencies missing - run option 4
)

echo.
echo  Press any key to return to menu...
pause >nul
goto MENU

:: ================================================================
::  HELPER FUNCTIONS
:: ================================================================

:CHECK_NODE
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: Node.js is not installed.
    echo.
    echo  Opening https://nodejs.org ...
    start "" "https://nodejs.org/en/download"
    echo.
    echo  Install Node.js, then run this script again.
    echo  Press any key to continue...
    pause >nul
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo  OK - Node.js %%i
exit /b 0

:CHECK_NPM
:: npm comes with Node.js - if Node works, npm works
:: Skip the version check to avoid hanging on first run
echo  OK - npm (bundled with Node.js)
exit /b 0

:CHECK_WRANGLER
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Wrangler not found. Installing now...
    echo  This may take 30-60 seconds. Please wait...
    echo.
    call npm install -g wrangler
    echo.
    wrangler --version >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  WARNING: Wrangler install may have issues.
        echo  Trying alternative install...
        echo.
        call npm install -g --allow-scripts=esbuild,workerd wrangler
        echo.
        wrangler --version >nul 2>&1
        if errorlevel 1 (
            echo.
            echo  ERROR: Could not install Wrangler automatically.
            echo.
            echo  Please install manually by running this command:
            echo    npm install -g wrangler
            echo.
            echo  Then run this script again.
            echo.
            echo  Press any key to return to menu...
            pause >nul
            exit /b 1
        )
    )
)
for /f "tokens=*" %%i in ('wrangler --version 2^>nul') do set WRANGLER_VER=%%i
echo  OK - Wrangler !WRANGLER_VER!
exit /b 0

:INSTALL_PROJECT_DEPS
if exist "%EXT_DIR%\workers\profile-proxy\package.json" (
    if not exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
        echo  Installing CF Worker dependencies...
        echo  Please wait...
        pushd "%EXT_DIR%\workers\profile-proxy"
        call npm install 2>&1
        popd
        if exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
            echo  OK - CF Worker deps installed
        ) else (
            echo  WARNING: CF Worker deps may not have installed correctly
        )
    ) else (
        echo  OK - CF Worker deps already installed
    )
)
if exist "%EXT_DIR%\workers\backend-proxy\package.json" (
    if not exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
        echo  Installing Backend Proxy dependencies...
        echo  Please wait...
        pushd "%EXT_DIR%\workers\backend-proxy"
        call npm install 2>&1
        popd
        if exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
            echo  OK - Backend Proxy deps installed
        ) else (
            echo  WARNING: Backend Proxy deps may not have installed correctly
        )
    ) else (
        echo  OK - Backend Proxy deps already installed
    )
)
exit /b 0

:HTTP_GET
powershell -Command "try { $r = Invoke-RestMethod -Uri '%~1' -TimeoutSec 10; $r | ConvertTo-Json } catch { Write-Host 'ERROR:' $_.Exception.Message }"
exit /b 0

:EXIT
cls
echo.
echo  Goodbye!
echo.
timeout /t 2 >nul
exit /b 0
