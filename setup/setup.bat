@echo off
setlocal EnableDelayedExpansion

REM ========================================
REM Microsoft Rewards Bot - Setup (Windows)
REM ========================================
REM This script performs first-time setup:
REM   1. Check prerequisites (Node.js, npm)
REM   2. Run setup wizard (accounts + config)
REM   3. Install dependencies
REM   4. Build TypeScript project
REM
REM After setup, run the bot with: npm start
REM ========================================

set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%..

echo.
echo ========================================
echo  Microsoft Rewards Bot - Setup
echo ========================================
echo.

REM Check if Node.js/npm are installed
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found!
  echo.
  echo Please install Node.js from: https://nodejs.org/
  echo Recommended version: v20 or newer
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%i in ('npm -v 2^>nul') do set NPM_VERSION=%%i
echo [OK] npm detected: v!NPM_VERSION!
echo.

REM Check if package.json exists
if not exist "%PROJECT_ROOT%\package.json" (
  echo [ERROR] package.json not found in project root.
  echo Current directory: %CD%
  echo Project root: %PROJECT_ROOT%
  echo.
  pause
  exit /b 1
)

REM Navigate to project root
cd /d "%PROJECT_ROOT%"

REM Run setup script
echo Running setup wizard...
echo.
call npm run setup
set EXITCODE=%ERRORLEVEL%

echo.
if %EXITCODE% EQU 0 (
  echo ========================================
  echo  Setup Complete!
  echo ========================================
  echo.
  echo To start the bot: npm start
  echo.
) else (
  echo ========================================
  echo  Setup Failed ^(Exit Code: %EXITCODE%^)
  echo ========================================
  echo.
)

pause
exit /b %EXITCODE%