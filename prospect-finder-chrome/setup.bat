@echo off
setlocal enabledelayedexpansion
title ProspectFinder Setup
color 0B

:MENU
cls
echo.
echo  ========================================
echo   PROSPECTFINDER SETUP
echo  ========================================
echo.
echo   1 - Full Setup
echo   2 - Cloudflare Worker Only
echo   3 - Backend Proxy Only (IP Rotation)
echo   4 - Start Backend Proxy (if already configured)
echo   5 - Test Setup
echo   6 - Exit
echo.
echo  ========================================
echo.
choice /c 123456 /n /m "  Select [1-6]: "
if %errorlevel%==1 goto FULL
if %errorlevel%==2 goto CF
if %errorlevel%==3 goto BACKEND
if %errorlevel%==4 goto START_BACKEND
if %errorlevel%==5 goto TEST
if %errorlevel%==6 exit

:FULL
cls
echo.
echo  ========================================
echo   FULL SETUP
echo  ========================================
echo.

echo  STEP 1 - Node.js...
node -v
if errorlevel 1 (
    echo  Node.js not found!
    start "" "https://nodejs.org/en/download"
    pause
    goto MENU
)
echo  OK
echo.

echo  STEP 2 - Wrangler...
call npm install -g wrangler
call npm install -g --allow-scripts=esbuild,workerd wrangler
echo  OK
echo.

echo  STEP 3 - Login to Cloudflare
pause
call wrangler login
echo.

echo  STEP 4 - Instagram Session
echo  Get from: instagram.com / F12 / Application / Cookies / sessionid
echo.
set /p "IG=  Paste sessionid: "
echo.

echo  STEP 5 - Finding profile-proxy folder...
call :FIND_PROXY
if "!PROXY_DIR!"=="" (
    echo  Paste path to prospect-finder-chrome folder:
    set /p "EXT_DIR=  Path: "
    set "PROXY_DIR=!EXT_DIR!\workers\profile-proxy"
)
if not exist "!PROXY_DIR!\wrangler.toml" (
    echo  Not found: !PROXY_DIR!
    pause
    goto MENU
)
echo  Found: !PROXY_DIR!
echo.

echo  STEP 6 - R2 bucket...
cd /d "!PROXY_DIR!"
call wrangler r2 bucket create pf-profile-cache
echo  (OK if already exists)
echo.

echo  STEP 7 - Store session...
echo !IG!| call wrangler secret put IG_SESSION_1
echo.

echo  STEP 8 - Deploy Worker...
call wrangler deploy
echo.

echo  ========================================
echo   WORKER DEPLOYED!
echo  ========================================
echo.
echo  Your Worker URL is shown above.
echo  Copy it and paste in extension Settings.
echo.

echo  Do you want to also setup Backend Proxy (IP Rotation)?
echo.
echo   1 - Yes
echo   2 - No, finish
echo.
choice /c 12 /n /m "  Select [1-2]: "
if %errorlevel%==1 goto BACKEND
goto MENU

:CF
cls
echo.
echo  ========================================
echo   CLOUDFLARE WORKER
echo  ========================================
echo.

echo  STEP 1 - Node.js...
node -v
if errorlevel 1 (
    echo  Not found!
    start "" "https://nodejs.org/en/download"
    pause
    goto MENU
)
echo  OK
echo.

echo  STEP 2 - Wrangler...
call npm install -g wrangler
call npm install -g --allow-scripts=esbuild,workerd wrangler
echo  OK
echo.

echo  STEP 3 - Login...
pause
call wrangler login
echo.

echo  STEP 4 - Session ID:
set /p "IG=  Paste here: "
echo.

echo  STEP 5 - Finding profile-proxy folder...
call :FIND_PROXY
if "!PROXY_DIR!"=="" (
    echo  Paste path to prospect-finder-chrome folder:
    set /p "EXT_DIR=  Path: "
    set "PROXY_DIR=!EXT_DIR!\workers\profile-proxy"
)
if not exist "!PROXY_DIR!\wrangler.toml" (
    echo  Not found: !PROXY_DIR!
    pause
    goto MENU
)
echo  Found: !PROXY_DIR!
echo.

echo  STEP 6 - R2 bucket...
cd /d "!PROXY_DIR!"
call wrangler r2 bucket create pf-profile-cache
echo  (OK if already exists)
echo.

echo  STEP 7 - Store session...
echo !IG!| call wrangler secret put IG_SESSION_1
echo.

echo  STEP 8 - Deploy...
call wrangler deploy
echo.

echo  ========================================
echo   DONE! Copy the Worker URL above.
echo   Paste in: Dashboard / Settings / Enrichment proxy
echo  ========================================
echo.
pause
goto MENU

:BACKEND
cls
echo.
echo  ========================================
echo   BACKEND PROXY SETUP (IP Rotation)
echo  ========================================
echo.
echo  This routes requests through residential proxy IPs
echo  when Instagram rate limits you.
echo.
echo  You need a residential proxy service:
echo.
echo   1 - IPRoyal     ($5/mo)   https://iproyal.com
echo   2 - Smartproxy  ($12/mo)  https://smartproxy.com
echo   3 - BrightData  ($15/mo)  https://brightdata.com
echo   4 - Oxylabs     ($15/mo)  https://oxylabs.io
echo   5 - I already have one
echo.
choice /c 12345 /n /m "  Select [1-5]: "

if %errorlevel%==1 start "" "https://iproyal.com"
if %errorlevel%==2 start "" "https://smartproxy.com"
if %errorlevel%==3 start "" "https://brightdata.com"
if %errorlevel%==4 start "" "https://oxylabs.io"

echo.
echo  Sign up and get your proxy URL.
echo  It looks like: http://user:pass@host:port
echo.
echo  Press any key when you have your proxy URL...
pause
echo.

node -v
if errorlevel 1 (
    echo  Node.js required!
    start "" "https://nodejs.org/en/download"
    pause
    goto MENU
)

echo  Your Instagram session ID:
echo  (Same one you used for the Worker)
echo.
set /p "IG=  Paste sessionid: "
echo.

echo  Your proxy URL(s):
echo  (Comma-separated if multiple)
echo  Example: http://user:pass@gate.iproyal.com:7777
echo.
set /p "PX=  Paste proxy URL: "
echo.

echo  Finding backend-proxy folder...
call :FIND_BACKEND
if "!BACKEND_DIR!"=="" (
    echo  Paste path to prospect-finder-chrome folder:
    set /p "EXT_DIR=  Path: "
    set "BACKEND_DIR=!EXT_DIR!\workers\backend-proxy"
)
if not exist "!BACKEND_DIR!\package.json" (
    echo  Not found: !BACKEND_DIR!
    pause
    goto MENU
)
echo  Found: !BACKEND_DIR!
echo.

echo  Installing dependencies...
cd /d "!BACKEND_DIR!"
call npm install
echo.

echo  Creating .env file...
(
echo IG_SESSIONS=!IG!
echo PROXY_URLS=!PX!
echo RATE_LIMIT_PER_SESSION=20
echo CACHE_TTL=86400
echo PORT=3000
) > .env

echo  OK - .env created
echo.
echo  ========================================
echo   Backend Proxy configured!
echo  ========================================
echo.
echo  To start it, run this script and select option 4.
echo  Or run: cd !BACKEND_DIR! ^&^& npm start
echo.
echo  Backend URL: http://localhost:3000
echo  Paste this in: Dashboard / Settings / Backend Proxy URL
echo.
pause
goto MENU

:START_BACKEND
cls
echo.
echo  ========================================
echo   STARTING BACKEND PROXY
echo  ========================================
echo.

call :FIND_BACKEND
if "!BACKEND_DIR!"=="" (
    echo  Paste path to prospect-finder-chrome folder:
    set /p "EXT_DIR=  Path: "
    set "BACKEND_DIR=!EXT_DIR!\workers\backend-proxy"
)

if not exist "!BACKEND_DIR!\.env" (
    echo  .env file not found!
    echo  Run option 3 first to configure it.
    pause
    goto MENU
)

if not exist "!BACKEND_DIR!\node_modules" (
    echo  Installing dependencies...
    cd /d "!BACKEND_DIR!"
    call npm install
)

cd /d "!BACKEND_DIR!"
echo  Starting backend proxy on http://localhost:3000
echo  Press Ctrl+C to stop.
echo.
call npm start

pause
goto MENU

:TEST
cls
echo.
echo  ========================================
echo   TEST SETUP
echo  ========================================
echo.

echo  Test Cloudflare Worker:
echo  Paste your Worker URL:
echo  Example: https://pf-profile-proxy.xxx.workers.dev
echo.
set /p "CF_URL=  URL (Enter to skip): "
if not "!CF_URL!"=="" (
    echo.
    echo  Testing !CF_URL!/health ...
    powershell -Command "try { Invoke-RestMethod -Uri '!CF_URL!/health' -TimeoutSec 10 | ConvertTo-Json } catch { Write-Host 'ERROR:' $_.Exception.Message }"
    echo.
)

echo  Test Backend Proxy:
echo  Paste your Backend URL (default: http://localhost:3000):
echo.
set /p "BE_URL=  URL (Enter to skip): "
if "!BE_URL!"=="" set "BE_URL=http://localhost:3000"
if not "!BE_URL!"=="" (
    echo.
    echo  Testing !BE_URL!/health ...
    powershell -Command "try { Invoke-RestMethod -Uri '!BE_URL!/health' -TimeoutSec 10 | ConvertTo-Json } catch { Write-Host 'ERROR:' $_.Exception.Message }"
    echo.
)

pause
goto MENU

:: =============================================
:: HELPERS
:: =============================================
:FIND_PROXY
set "PROXY_DIR="
set "SCRIPT_DIR=%~dp0"

if exist "!SCRIPT_DIR!workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=!SCRIPT_DIR!workers\profile-proxy"
    exit /b
)
if exist "!SCRIPT_DIR!prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=!SCRIPT_DIR!prospect-finder-chrome\workers\profile-proxy"
    exit /b
)
if exist "!CD!\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=!CD!\workers\profile-proxy"
    exit /b
)
for %%A in ("!SCRIPT_DIR!." "!SCRIPT_DIR!..\" "!SCRIPT_DIR!..\..\") do (
    if exist "%%~A\prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
        set "PROXY_DIR=%%~A\prospect-finder-chrome\workers\profile-proxy"
        exit /b
    )
    if exist "%%~A\workers\profile-proxy\wrangler.toml" (
        set "PROXY_DIR=%%~A\workers\profile-proxy"
        exit /b
    )
)
exit /b

:FIND_BACKEND
set "BACKEND_DIR="
set "SCRIPT_DIR=%~dp0"

if exist "!SCRIPT_DIR!workers\backend-proxy\package.json" (
    set "BACKEND_DIR=!SCRIPT_DIR!workers\backend-proxy"
    exit /b
)
if exist "!SCRIPT_DIR!prospect-finder-chrome\workers\backend-proxy\package.json" (
    set "BACKEND_DIR=!SCRIPT_DIR!prospect-finder-chrome\workers\backend-proxy"
    exit /b
)
if exist "!CD!\workers\backend-proxy\package.json" (
    set "BACKEND_DIR=!CD!\workers\backend-proxy"
    exit /b
)
for %%A in ("!SCRIPT_DIR!." "!SCRIPT_DIR!..\" "!SCRIPT_DIR!..\..\") do (
    if exist "%%~A\prospect-finder-chrome\workers\backend-proxy\package.json" (
        set "BACKEND_DIR=%%~A\prospect-finder-chrome\workers\backend-proxy"
        exit /b
    )
)
exit /b
