@echo off
setlocal enabledelayedexpansion
title ProspectFinder Setup Wizard v2.1
color 0B
set "EXT_DIR=%~dp0prospect-finder-chrome"

:MENU
cls
echo.
echo  ========================================================
echo          PROSPECTFINDER - SETUP WIZARD v2.1
echo  ========================================================
echo.
echo   [1] Full Setup
echo   [2] Cloudflare Worker Only
echo   [3] Backend Proxy Only
echo   [4] Install Dependencies
echo   [5] Test Setup
echo   [6] View Status
echo   [7] Exit
echo.
echo  ========================================================
echo.
set /p "choice=  Select [1-7]: "

if "!choice!"=="1" goto FULL_SETUP
if "!choice!"=="2" goto CF_ONLY
if "!choice!"=="3" goto BACKEND_ONLY
if "!choice!"=="4" goto INSTALL_DEPS
if "!choice!"=="5" goto TEST_SETUP
if "!choice!"=="6" goto VIEW_STATUS
if "!choice!"=="7" goto DONE
echo  Invalid. Press any key...
pause >nul
goto MENU

:DONE
echo.
echo  Bye!
timeout /t 1 >nul
exit

:: =============================================
:: INSTALL DEPS
:: =============================================
:INSTALL_DEPS
cls
echo.
echo  ========================================================
echo         INSTALLING DEPENDENCIES
echo  ========================================================
echo.

echo  [1/3] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo  Node.js NOT found!
    echo  Opening https://nodejs.org ...
    start "" "https://nodejs.org/en/download"
    echo.
    echo  Install Node.js then run this script again.
    echo  Press any key...
    pause >nul
    goto MENU
)
for /f %%i in ('node -v') do echo  OK - %%i

echo.
echo  [2/3] Checking Wrangler...
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing Wrangler...
    echo  Please wait 30-60 seconds...
    call npm install -g wrangler
    wrangler --version >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  Wrangler install had issues.
        echo  Trying alternative method...
        call npm install -g --allow-scripts=esbuild,workerd wrangler
        wrangler --version >nul 2>&1
        if errorlevel 1 (
            echo.
            echo  Could not install Wrangler.
            echo  Open a NEW command prompt and run:
            echo    npm install -g wrangler
            echo.
            echo  Press any key...
            pause >nul
            goto MENU
        )
    )
)
echo  OK - Wrangler installed

echo.
echo  [3/3] Project dependencies...
if exist "%EXT_DIR%\workers\profile-proxy\package.json" (
    if not exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
        echo  Installing CF Worker deps...
        pushd "%EXT_DIR%\workers\profile-proxy"
        call npm install
        popd
    )
)
if exist "%EXT_DIR%\workers\backend-proxy\package.json" (
    if not exist "%EXT_DIR%\workers\backend-proxy\node_modules" (
        echo  Installing Backend deps...
        pushd "%EXT_DIR%\workers\backend-proxy"
        call npm install
        popd
    )
)
echo  OK - Project dependencies ready

echo.
echo  ========================================================
echo   DONE! All dependencies installed.
echo  ========================================================
echo.
echo  Press any key...
pause >nul
goto MENU

:: =============================================
:: FULL SETUP
:: =============================================
:FULL_SETUP
cls
echo.
echo  ========================================================
echo         FULL SETUP
echo  ========================================================
echo.

:: Deps
echo  [1/8] Dependencies...
node -v >nul 2>&1
if errorlevel 1 (
    echo  Node.js required.
    start "" "https://nodejs.org/en/download"
    echo  Press any key after installing...
    pause >nul
    goto MENU
)
echo  OK - Node.js

wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing Wrangler... please wait...
    call npm install -g wrangler
)
echo  OK - Wrangler

if not exist "%EXT_DIR%\workers\profile-proxy\node_modules" (
    pushd "%EXT_DIR%\workers\profile-proxy"
    call npm install
    popd
)
echo  OK - All dependencies

:: Login
echo.
echo  [2/8] Login to Cloudflare
echo  Press any key to open browser...
pause >nul
call wrangler login
echo  OK

:: Session
echo.
echo  [3/8] Instagram Session ID
echo  Get from: instagram.com / F12 / Application / Cookies / sessionid
echo.
set /p "IG_SESSION=  Paste here: "
if "!IG_SESSION!"=="" (
    echo  Required! Press any key...
    pause >nul
    goto MENU
)
echo  OK

:: R2
echo.
echo  [4/8] Creating R2 bucket...
cd /d "%EXT_DIR%\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul
echo  OK

:: Secret
echo.
echo  [5/8] Storing session...
echo !IG_SESSION!| call wrangler secret put IG_SESSION_1
echo  OK

:: Deploy
echo.
echo  [6/8] Deploying Worker...
call wrangler deploy
echo.
echo  DONE - Worker deployed!

:: URL
echo.
echo  [7/8] What is your Worker URL?
echo  Look above for: https://pf-profile-proxy.xxx.workers.dev
echo.
set /p "CF_URL=  Paste URL: "

:: Backend
echo.
echo  [8/8] Backend Proxy (optional)
echo.
echo   [1] IPRoyal     - $5/mo
echo   [2] Smartproxy  - $12/mo
echo   [3] BrightData  - $15/mo
echo   [4] Oxylabs     - $15/mo
echo   [5] Skip
echo.
set /p "PC=  Select [1-5]: "

if "!PC!"=="5" goto SHOW_RESULT

set /p "PX=  Paste proxy URL(s): "
if "!PX!"=="" goto SHOW_RESULT

cd /d "%EXT_DIR%\workers\backend-proxy"
(
    echo IG_SESSIONS=!IG_SESSION!
    echo PROXY_URLS=!PX!
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env
start "PF Backend" cmd /c "cd /d "%EXT_DIR%\workers\backend-proxy" && npm start && pause"
set "BE_URL=http://localhost:3000"

:SHOW_RESULT
cls
echo.
echo  ========================================================
echo         SETUP COMPLETE!
echo  ========================================================
echo.
echo   Worker URL: !CF_URL!
if defined BE_URL echo   Backend URL: !BE_URL!
echo.
echo  NEXT STEPS:
echo  1. chrome://extensions/
echo  2. Developer mode ON
echo  3. Load unpacked - select prospect-finder-chrome
echo  4. Open Dashboard - Settings
echo  5. Paste Worker URL: !CF_URL!
echo  6. Test connection - Save
echo.
if defined BE_URL (
    echo  7. Paste Backend URL: !BE_URL!
    echo  8. Save
)
echo  ========================================================
echo.
echo  Press any key...
pause >nul
goto MENU

:: =============================================
:: CF ONLY
:: =============================================
:CF_ONLY
cls
echo.
echo  ========================================================
echo         CLOUDFLARE WORKER
echo  ========================================================
echo.

echo  [1/6] Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo  Required!
    start "" "https://nodejs.org/en/download"
    echo  Press any key after install...
    pause >nul
    goto MENU
)
echo  OK

echo.
echo  [2/6] Wrangler...
wrangler --version >nul 2>&1
if errorlevel 1 (
    echo  Installing... please wait...
    call npm install -g wrangler
)
echo  OK

echo.
echo  [3/6] Login...
echo  Press any key to open browser...
pause >nul
call wrangler login
echo  OK

echo.
echo  [4/6] Session ID:
set /p "IG_SESSION=  Paste here: "
if "!IG_SESSION!"=="" (
    echo  Required! Press any key...
    pause >nul
    goto MENU
)

echo.
echo  [5/6] R2 bucket...
cd /d "%EXT_DIR%\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache 2>nul
echo !IG_SESSION!| call wrangler secret put IG_SESSION_1
echo  OK

echo.
echo  [6/6] Deploying...
call wrangler deploy

echo.
echo  Copy the Worker URL above.
echo  Paste in: Dashboard / Settings / Enrichment proxy
echo.
echo  Press any key...
pause >nul
goto MENU

:: =============================================
:: BACKEND ONLY
:: =============================================
:BACKEND_ONLY
cls
echo.
echo  ========================================================
echo         BACKEND PROXY (IP Rotation)
echo  ========================================================
echo.
echo  Need a residential proxy:
echo    IPRoyal    - $5/mo  - iproyal.com
echo    Smartproxy - $12/mo - smartproxy.com
echo    BrightData - $15/mo - brightdata.com
echo    Oxylabs    - $15/mo - oxylabs.io
echo.
echo  Press any key...
pause >nul

node -v >nul 2>&1
if errorlevel 1 (
    echo  Node.js required!
    start "" "https://nodejs.org/en/download"
    echo  Press any key...
    pause >nul
    goto MENU
)

set /p "IG_SESSION=  Session ID: "
if "!IG_SESSION!"=="" goto MENU

set /p "PX=  Proxy URL(s): "
if "!PX!"=="" goto MENU

cd /d "%EXT_DIR%\workers\backend-proxy"
if not exist "node_modules" call npm install

(
    echo IG_SESSIONS=!IG_SESSION!
    echo PROXY_URLS=!PX!
    echo RATE_LIMIT_PER_SESSION=20
    echo CACHE_TTL=86400
    echo PORT=3000
) > .env

echo.
echo  Starting...
call npm start

echo.
echo  Press any key...
pause >nul
goto MENU

:: =============================================
:: TEST
:: =============================================
:TEST_SETUP
cls
echo.
echo  ========================================================
echo         TEST SETUP
echo  ========================================================
echo.

set /p "CF_URL=  Worker URL (Enter to skip): "
if not "!CF_URL!"=="" (
    echo.
    powershell -Command "try { Invoke-RestMethod -Uri '!CF_URL!/health' -TimeoutSec 10 | ConvertTo-Json } catch { Write-Host 'ERROR:' $_.Exception.Message }"
    echo.
)

set /p "BE_URL=  Backend URL (Enter to skip): "
if not "!BE_URL!"=="" (
    echo.
    powershell -Command "try { Invoke-RestMethod -Uri '!BE_URL!/health' -TimeoutSec 10 | ConvertTo-Json } catch { Write-Host 'ERROR:' $_.Exception.Message }"
    echo.
)

echo  Press any key...
pause >nul
goto MENU

:: =============================================
:: STATUS
:: =============================================
:VIEW_STATUS
cls
echo.
echo  ========================================================
echo         SYSTEM STATUS
echo  ========================================================
echo.

node -v >nul 2>&1
if errorlevel 1 (echo  [X]  Node.js) else (for /f %%i in ('node -v') do echo  [OK] Node.js %%i)

wrangler --version >nul 2>&1
if errorlevel 1 (echo  [X]  Wrangler) else (echo  [OK] Wrangler)

git --version >nul 2>&1
if errorlevel 1 (echo  [X]  Git) else (echo  [OK] Git)

echo.
if exist "%EXT_DIR%\manifest.json" (echo  [OK] Extension) else (echo  [X] Extension)
if exist "%EXT_DIR%\workers\profile-proxy\src\index.js" (echo  [OK] CF Worker) else (echo  [X] CF Worker)
if exist "%EXT_DIR%\workers\backend-proxy\src\server.js" (echo  [OK] Backend) else (echo  [X] Backend)

echo.
echo  Press any key...
pause >nul
goto MENU
