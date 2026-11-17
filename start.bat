@echo off
rem Starts the Saltline server and opens the game. Other players on your network use the address it prints.
cd /d "%~dp0"
if not exist node_modules call npm install --no-audit --no-fund
start "" http://localhost:8080/
node server.mjs 8080
