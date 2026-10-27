@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title OdysseyDoc - .vsix build

rem ---------------------------------------------------------------
rem  Builds OdysseyDoc-v4.0.vsix next to this script.
rem  KEEP_NODE_MODULES=1 keeps node_modules (faster next builds).
rem  INSTALL=1 installs the extension into VS Code right away.
rem ---------------------------------------------------------------
if "%KEEP_NODE_MODULES%"=="" set KEEP_NODE_MODULES=0
if "%INSTALL%"=="" set INSTALL=1
set VSIX=OdysseyDoc-v4.0.vsix

where node >nul 2>nul || (echo [ERROR] Node.js not found: install it from https://nodejs.org ^(LTS^) & pause & exit /b 1)
where npm  >nul 2>nul || (echo [ERROR] npm not found. & pause & exit /b 1)

echo [1/4] Installing build tools (npm)...
call npm install --no-audit --no-fund --loglevel=error || goto :fail

echo [2/4] Type check + bundle...
call npm run -s compile || goto :fail

echo [3/4] Packaging...
call npx --no-install vsce package --no-dependencies -o "%VSIX%" || goto :fail

echo [4/4] Cleaning up...
if exist dist rmdir /s /q dist
if exist out rmdir /s /q out
if exist out-test rmdir /s /q out-test
if "%KEEP_NODE_MODULES%"=="0" if exist node_modules rmdir /s /q node_modules

echo.
echo  OK: %~dp0%VSIX%
if "%INSTALL%"=="1" (
  where code >nul 2>nul && (
    echo  Installing into VS Code...
    call code --install-extension "%~dp0%VSIX%" --force
  ) || echo  ^("code" command not found: install the .vsix via Extensions ^> ... ^> Install from VSIX^)
)
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] The build failed (see above).
pause
exit /b 1
