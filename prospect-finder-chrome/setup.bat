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
echo  STEP 1 - Checking Node.js...
node -v
if errorlevel 1 (
    echo.
    echo  Node.js not found!
    echo  Opening download page...
    start "" "https://nodejs.org/en/download"
    echo.
    echo  Install Node.js, then run this script again.
    echo.
    pause
    goto MENU
)
echo  OK
echo.

echo  STEP 2 - Installing Wrangler...
echo  Please wait...
call npm install -g wrangler
echo.
echo  Fixing install scripts...
call npm install -g --allow-scripts=esbuild,workerd wrangler
echo.
echo  Done installing Wrangler.
echo.

echo  STEP 3 - Login to Cloudflare
echo  A browser will open. Click Authorize.
echo.
pause
call wrangler login
echo.

echo  STEP 4 - Instagram Session
echo  Get from: instagram.com / F12 / Application / Cookies / sessionid
echo.
set /p "IG=  Paste sessionid: "
echo.

echo  STEP 5 - Creating R2 bucket...
cd /d "%~dp0prospect-finder-chrome\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache
echo.

echo  STEP 6 - Storing session...
echo %IG%| call wrangler secret put IG_SESSION_1
echo.

echo  STEP 7 - Deploying Worker...
call wrangler deploy
echo.

echo  ========================================
echo   DONE!
echo   Copy the Worker URL shown above.
echo   Paste it in the extension Settings.
echo  ========================================
echo.
pause
goto MENU

:CF
cls
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

echo  STEP 3 - Login...
pause
call wrangler login
echo.

echo  STEP 4 - Session ID:
set /p "IG=  Paste here: "
echo.

echo  STEP 5 - R2 bucket + Deploy...
cd /d "%~dp0prospect-finder-chrome\workers\profile-proxy"
call wrangler r2 bucket create pf-profile-cache
echo %IG%| call wrangler secret put IG_SESSION_1
call wrangler deploy
echo.

echo  Copy the URL above. Paste in extension Settings.
echo.
pause
goto MENU

:BACKEND
cls
echo.
echo  BACKEND PROXY
echo.
echo  You need a residential proxy:
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

cd /d "%~dp0prospect-finder-chrome\workers\backend-proxy"
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
