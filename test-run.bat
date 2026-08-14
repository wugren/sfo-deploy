@echo off
setlocal

cd /d "%~dp0"

where uv >nul 2>nul
if errorlevel 1 (
  echo uv is required to run tests from this shortcut.
  echo Install uv from: https://docs.astral.sh/uv/getting-started/installation/
  exit /b 1
)

set "UV_PROJECT_ENVIRONMENT=.venv"
set "UV_CACHE_DIR=%CD%\.harness\uv-cache"
set "UV_PYTHON_INSTALL_DIR=%CD%\.harness\uv-python"
set "PYTHONDONTWRITEBYTECODE=1"
if not exist "%UV_CACHE_DIR%" mkdir "%UV_CACHE_DIR%"
if not exist "%UV_PYTHON_INSTALL_DIR%" mkdir "%UV_PYTHON_INSTALL_DIR%"
set "VENV_PYTHON=.venv\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
  echo Creating local Python virtual environment in .venv
  uv venv --python 3.12 .venv
  if errorlevel 1 exit /b %errorlevel%
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 exit /b %errorlevel%

if exist "pyproject.toml" (
  echo Syncing Python environment with uv
  uv sync
  if errorlevel 1 exit /b %errorlevel%
) else (
  if exist "requirements.txt" (
    echo Installing requirements into .venv with uv
    uv pip install --python "%VENV_PYTHON%" -r requirements.txt
    if errorlevel 1 exit /b %errorlevel%
  )
)

if "%~1"=="" (
  uv run --active python "harness\scripts\test-run.py" all all
) else (
  uv run --active python "harness\scripts\test-run.py" %*
)

exit /b %errorlevel%
