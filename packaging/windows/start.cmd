@echo off
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%connections.json" (
  echo Missing connections.json. Copy connections.example.json, configure the connection, and set the password environment variable.
  exit /b 2
)

set "ABAP_MCP_CONFIG=%ROOT%connections.json"
if not defined ABAP_MCP_PORT set "ABAP_MCP_PORT=4847"
set "ABAP_MCP_EXPORT_ROOT=%ROOT%exports"

echo ORVANTA: http://127.0.0.1:%ABAP_MCP_PORT%/mcp
"%ROOT%runtime\node.exe" "%ROOT%app\dist\src\index.js"
exit /b %ERRORLEVEL%
