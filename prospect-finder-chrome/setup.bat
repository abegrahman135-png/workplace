@echo off
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
echo   3 - Backend Proxy Only
echo   4 - Exit
echo.
echo  ========================================
echo.
choice /c 1234 /n /m "  Select [1-4]: "
if %errorlevel%==1 goto FULL
if %errorlevel%==2 goto CF
if %errorlevel%==3 goto BACKEND
if %errorlevel%==4 exit

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
    echo  Install Node.js then run this again.
    pause
    goto MENU
)
echo  OK
echo.

echo  STEP 2 - Wrangler...
echo  Please wait...
call npm install -g wrangler
call npm install -g --allow-scripts=esbuild,workerd wrangler
echo.
echo  OK
echo.

echo  STEP 3 - Login to Cloudflare
echo  Press any key to open browser...
pause
call wrangler login
echo.

echo  STEP 4 - Instagram Session
echo  Get from: instagram.com / F12 / Application / Cookies / sessionid
echo.
set /p "IG=  Paste sessionid: "
echo.

echo  STEP 5 - Finding extension folder...
echo.

:: Find the profile-proxy folder
set "PROXY_DIR="
if exist "%~dp0prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=%~dp0prospect-finder-chrome\workers\profile-proxy"
    echo  Found at: %~dp0prospect-finder-chrome\workers\profile-proxy
)
if exist "%CD%\prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=%CD%\prospect-finder-chrome\workers\profile-proxy"
    echo  Found at: %CD%\prospect-finder-chrome\workers\profile-proxy
)

if "!PROXY_DIR!"=="" (
    echo.
    echo  Cannot find prospect-finder-chrome\workers\profile-proxy\wrangler.toml
    echo.
    echo  Where did you extract the zip? Paste the full path:
    echo  Example: C:\Users\YourName\Downloads\workplace-main
    echo.
    set /p "BASE_DIR=  Path: "
    if exist "!BASE_DIR!\prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
        set "PROXY_DIR=!BASE_DIR!\prospect-finder-chrome\workers\profile-proxy"
        echo  Found!
    ) else (
        echo.
        echo  Still not found. Check the path and try again.
        echo  Press any key...
        pause
        goto MENU
    )
)

echo.
echo  STEP 6 - Creating R2 bucket...
cd /d "!PROXY_DIR!"
call wrangler r2 bucket create pf-profile-cache
echo  (If it says "already exists" that is OK)
echo.

echo  STEP 7 - Storing session...
echo %IG%| call wrangler secret put IG_SESSION_1
echo.

echo  STEP 8 - Deploying Worker...
call wrangler deploy
echo.

echo  ========================================
echo   DONE!
echo   Copy the Worker URL shown above.
echo   Paste it in extension Settings.
echo  ========================================
echo.
pause
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
echo  Please wait...
call npm install -g wrangler
call npm install -g --allow-scripts=esbuild,workerd wrangler
echo.
echo  OK
echo.

echo  STEP 3 - Login...
echo  Press any key...
pause
call wrangler login
echo.

echo  STEP 4 - Session ID:
set /p "IG=  Paste here: "
echo.

echo  STEP 5 - Finding extension folder...
echo.

set "PROXY_DIR="
if exist "%~dp0prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=%~dp0prospect-finder-chrome\workers\profile-proxy"
)
if exist "%CD%\prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=%CD%\prospect-finder-chrome\workers\profile-proxy"
)

if "!PROXY_DIR!"=="" (
    echo  Cannot find wrangler.toml
    echo  Paste the path where you extracted the zip:
    set /p "BASE_DIR=  Path: "
    if exist "!BASE_DIR!\prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
        set "PROXY_DIR=!BASE_DIR!\prospect-finder-chrome\workers\profile-proxy"
    ) else (
        echo  Not found! Press any key...
        pause
        goto MENU
    )
)

echo  Found: !PROXY_DIR!
echo.

echo  STEP 6 - R2 bucket...
cd /d "!PROXY_DIR!"
call wrangler r2 bucket create pf-profile-cache
echo  (OK if already exists)
echo.

echo  STEP 7 - Store session...
echo %IG%| call wrangler secret put IG_SESSION_1
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
echo   BACKEND PROXY
echo  ========================================
echo.
echo  Need residential proxy:
echo    IPRoyal    - $5/mo  - iproyal.com
echo    Smartproxy - $12/mo - smartproxy.com
echo    BrightData - $15/mo - brightdata.com
echo    Oxylabs    - $15/mo - oxylabs.io
echo.
pause

node -v
if errorlevel 1 (
    echo  Node.js required!
    start "" "https://nodejs.org/en/download"
    pause
    goto MENU
)

set /p "IG=  Session ID: "
set /p "PX=  Proxy URL: "

set "BACKEND_DIR="
if exist "%~dp0prospect-finder-chrome\workers\backend-proxy\package.json" (
    set "BACKEND_DIR=%~dp0prospect-finder-chrome\workers\backend-proxy"
)
if "!BACKEND_DIR!"=="" (
    echo  Paste path where you extracted zip:
    set /p "BASE_DIR=  Path: "
    set "BACKEND_DIR=!BASE_DIR!\prospect-finder-chrome\workers\backend-proxy"
)

cd /d "!BACKEND_DIR!"
call npm install
(
echo IG_SESSIONS=%IG%
echo PROXY_URLS=%PX%
echo RATE_LIMIT_PER_SESSION=20
echo PORT=3000
) > .env
call npm start

pause
goto MENU
