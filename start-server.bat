@echo off
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  call "%ProgramFiles%\nodejs\npm.cmd" start
) else (
  npm start
)
pause
