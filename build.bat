@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "MODE=%~1"
if not defined MODE set "MODE=build"
if /i not "%MODE%"=="build" if /i not "%MODE%"=="clean" if /i not "%MODE%"=="verify" (
  echo Usage: build.bat [build^|clean^|verify]
  exit /b 2
)

if not exist "logs" mkdir "logs"
set "LOG_DIR=%CD%\logs"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"
if not defined STAMP (
  echo PowerShell is required to track and log the build.
  exit /b 1
)
set "LOG=%LOG_DIR%\build_%STAMP%.log"
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
for /f "delims=" %%i in ('where pnpm.cmd 2^>nul') do if not defined PNPM_CMD set "PNPM_CMD=%%i"
for /f "delims=" %%i in ('where cargo.exe 2^>nul') do if not defined CARGO_EXE set "CARGO_EXE=%%i"
if defined NODE_EXE for %%i in ("%NODE_EXE%") do set "PATH=%%~dpi;%PATH%"
if defined CARGO_EXE for %%i in ("%CARGO_EXE%") do set "PATH=%%~dpi;%PATH%"
if defined PNPM_CMD for %%i in ("%PNPM_CMD%") do set "PATH=%%~dpi;%PATH%"
set "START=%TIME%"
set "STEP=0"
set "TOTAL=6"
if /i "%MODE%"=="clean" set "TOTAL=7"
if /i "%MODE%"=="verify" set "TOTAL=1"

echo ==================================================
echo       Tideline Windows Build
echo ==================================================
echo Mode: %MODE%
echo Log : logs\build_%STAMP%.log
echo.
call :log ==================================================
call :log Tideline Windows Build - %MODE%
call :log ==================================================

if /i "%MODE%"=="verify" goto verify

call :begin "Checking Node.js"
if not defined NODE_EXE (
  call :fail "Node.js not found. Install Node.js LTS and reopen this window."
  goto failed
)
"%NODE_EXE%" --version
if errorlevel 1 (
  set "RESULT=!ERRORLEVEL!"
  goto failed
)
call :ok

call :begin "Checking pnpm"
if not defined PNPM_CMD (
  call :fail "pnpm not found. Install it with: npm install -g pnpm"
  goto failed
)
call :run "%PNPM_CMD%" --version
if errorlevel 1 (
  set "RESULT=!ERRORLEVEL!"
  goto failed
)
call :ok

call :begin "Checking Rust toolchain"
if not defined CARGO_EXE (
  call :fail "Cargo not found. Install Rust via rustup and reopen this window."
  goto failed
)
"%CARGO_EXE%" --version
if errorlevel 1 (
  set "RESULT=!ERRORLEVEL!"
  goto failed
)
call :ok

if /i "%MODE%"=="clean" (
  call :begin "Cleaning build output"
  if exist "dist" rmdir /s /q "dist"
  if exist "src-tauri\target\release\bundle\nsis" rmdir /s /q "src-tauri\target\release\bundle\nsis"
  if exist "node_modules\.vite" rmdir /s /q "node_modules\.vite"
  if exist "tsconfig.tsbuildinfo" del /q "tsconfig.tsbuildinfo"
  call :ok
)

call :begin "Installing locked dependencies"
call :run "%PNPM_CMD%" install --frozen-lockfile
if errorlevel 1 (
  set "RESULT=!ERRORLEVEL!"
  goto failed
)
call :ok

call :begin "Building NSIS Setup installer"
call :run "%PNPM_CMD%" tauri build --bundles nsis
if errorlevel 1 (
  set "RESULT=!ERRORLEVEL!"
  goto failed
)
call :ok

call :begin "Verifying Setup installer"
call :check_installer
if errorlevel 1 goto failed
call :ok
goto success

:verify
call :begin "Verifying Setup installer"
call :check_installer
if errorlevel 1 goto failed
call :ok
goto success

:check_installer
set "VERSION="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(ConvertFrom-Json ([System.IO.File]::ReadAllText('package.json', [System.Text.Encoding]::UTF8))).version"') do set "VERSION=%%i"
if not defined VERSION (
  call :fail "Could not read version from package.json"
  exit /b 1
)
set "INSTALLER=src-tauri\target\release\bundle\nsis\tideline_!VERSION!_x64-setup.exe"
if not exist "!INSTALLER!" (
  call :fail "Expected Setup installer not found: !INSTALLER!"
  exit /b 1
)
echo     Setup: !INSTALLER!
call :log     Setup: !INSTALLER!
exit /b 0

:run
set "CMD=%*"
powershell -NoProfile -Command "& { & cmd.exe /d /c '%CMD% 2>&1' | Tee-Object -FilePath '%LOG%' -Append; exit $LASTEXITCODE }"
exit /b %ERRORLEVEL%

:begin
set /a STEP+=1
echo [!STEP!/%TOTAL%] %~1
call :log [!STEP!/%TOTAL%] %~1
exit /b 0

:ok
echo     Status: OK
call :log     Status: OK
exit /b 0

:fail
echo     ERROR: %~1
call :log     ERROR: %~1
exit /b 1

:log
>>"%LOG%" echo %*
exit /b 0

:success
for /f %%i in ('powershell -NoProfile -Command "$s=[timespan]::Parse('%START%'); $e=[timespan]::Parse('%TIME%'); if($e -lt $s){$e=$e.Add([timespan]::FromDays(1))}; ($e-$s).ToString('hh\:mm\:ss')"') do set "ELAPSED=%%i"
echo.
echo ==================================================
echo  BUILD SUCCESS
echo  Duration: %ELAPSED%
echo  Log: logs\build_%STAMP%.log
echo ==================================================
call :log BUILD SUCCESS - Duration: %ELAPSED%
echo.
pause
exit /b 0

:failed
if not defined RESULT set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" set "RESULT=1"
for /f %%i in ('powershell -NoProfile -Command "$s=[timespan]::Parse('%START%'); $e=[timespan]::Parse('%TIME%'); if($e -lt $s){$e=$e.Add([timespan]::FromDays(1))}; ($e-$s).ToString('hh\:mm\:ss')"') do set "ELAPSED=%%i"
echo.
echo ==================================================
echo  BUILD FAILED (exit code %RESULT%)
echo  Duration: %ELAPSED%
echo  Log: logs\build_%STAMP%.log
echo ==================================================
call :log BUILD FAILED - exit code %RESULT% - Duration: %ELAPSED%
echo.
pause
exit /b %RESULT%
