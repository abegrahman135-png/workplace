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
    echo.
    echo  Cannot find profile-proxy folder.
    echo  Paste the FULL path to the prospect-finder-chrome folder:
    echo  Example: C:\Users\YourName\Downloads\workplace-main\prospect-finder-chrome
    echo.
    set /p "EXT_DIR=  Path: "
    set "PROXY_DIR=!EXT_DIR!\workers\profile-proxy"
)

if not exist "!PROXY_DIR!\wrangler.toml" (
    echo.
    echo  Still not found: !PROXY_DIR!
    echo  Press any key...
    pause
    goto MENU
)

echo  Found: !PROXY_DIR!
echo.

echo  STEP 6 - R2 bucket...
cd /d "!PROXY_DIR!"
echo  Now in: !CD!
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
    echo.
    echo  Cannot find profile-proxy folder.
    echo  Paste the FULL path to the prospect-finder-chrome folder:
    echo.
    set /p "EXT_DIR=  Path: "
    set "PROXY_DIR=!EXT_DIR!\workers\profile-proxy"
)

if not exist "!PROXY_DIR!\wrangler.toml" (
    echo.
    echo  Still not found: !PROXY_DIR!
    echo  Press any key...
    pause
    goto MENU
)

echo  Found: !PROXY_DIR!
echo.

echo  STEP 6 - R2 bucket...
cd /d "!PROXY_DIR!"
echo  Now in: !CD!
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
echo   BACKEND PROXY
echo  ========================================
echo.
echo  Need residential proxy:
echo    IPRoyal    - $5/mo
echo    Smartproxy - $12/mo
echo    BrightData - $15/mo
echo    Oxylabs    - $15/mo
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

call :FIND_BACKEND
if "!BACKEND_DIR!"=="" (
    echo  Paste path to prospect-finder-chrome folder:
    set /p "EXT_DIR=  Path: "
    set "BACKEND_DIR=!EXT_DIR!\workers\backend-proxy"
)

cd /d "!BACKEND_DIR!"
call npm install
(
echo IG_SESSIONS=!IG!
echo PROXY_URLS=!PX!
echo RATE_LIMIT_PER_SESSION=20
echo PORT=3000
) > .env
call npm start

pause
goto MENU

:: =============================================
:: HELPER: Find profile-proxy folder
:: =============================================
:FIND_PROXY
set "PROXY_DIR="

:: Check where this script is
set "SCRIPT_DIR=%~dp0"

:: If script is in prospect-finder-chrome/
if exist "!SCRIPT_DIR!workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=!SCRIPT_DIR!workers\profile-proxy"
    exit /b
)

:: If script is next to prospect-finder-chrome/
if exist "!SCRIPT_DIR!prospect-finder-chrome\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=!SCRIPT_DIR!prospect-finder-chrome\workers\profile-proxy"
    exit /b
)

:: Check current directory
if exist "!CD!\workers\profile-proxy\wrangler.toml" (
    set "PROXY_DIR=!CD!\workers\profile-proxy"
    exit /b
)

:: Search up 3 levels
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

:: =============================================
:: HELPER: Find backend-proxy folder
:: =============================================
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
