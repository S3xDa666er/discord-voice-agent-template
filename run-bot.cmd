@echo off
REM Keep the voice-agent bridge alive; restart it if it ever exits.
REM Portable: runs from whatever folder this file sits in. Needs Node on PATH.
cd /d "%~dp0"
:loop
node agent.mjs >> "%LOCALAPPDATA%\Temp\discord-voice-bot.log" 2>&1
timeout /t 5 /nobreak >nul
goto loop
