"""
run.py — One-command launcher for PhytoLens (backend + frontend).

Starts the FastAPI backend (uvicorn) and the React/Vite frontend together,
streams both logs to this terminal, and prints the URLs.

Usage:
    python run.py

Press Ctrl+C once to stop both servers cleanly.
"""

import os
import sys
import re
import json
import signal
import shutil
import subprocess
import atexit

# --- Configuration -----------------------------------------------------------
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
BACKEND_DIR = os.path.join(PROJECT_ROOT, "backend")
VENV_DIR = os.path.join(BACKEND_DIR, "venv")

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 7000          # must match API_BASE in frontend/src/App.jsx
FRONTEND_PORT = 6173         # Vite dev server

IS_WINDOWS = os.name == "nt"
procs = []                   # child processes to clean up

# Map package names to importable module names where they differ
PACKAGE_TO_MODULE = {
    "pystac-client": "pystac_client",
    "planetary-computer": "planetary_computer",
    "scikit-learn": "sklearn",
    "pillow": "PIL",
}

# Run inside the venv to report each module as ok / missing / broken. Importing
# them in *this* process would test the launcher's interpreter, not the venv's.
_CHECK_SRC = r"""
import importlib, json, sys
out = {}
for name in sys.argv[1:]:
    try:
        importlib.import_module(name)
        out[name] = "ok"
    except ImportError:
        out[name] = "missing"
    except Exception as e:
        # Installed but unimportable — typically a C extension built against a
        # different numpy ABI ("numpy.dtype size changed"), which raises
        # ValueError rather than ImportError.
        out[name] = "broken: %s" % e
print(json.dumps(out))
"""


# --- Helpers -----------------------------------------------------------------
def fail(msg):
    print(f"\n[run.py] ERROR: {msg}\n", file=sys.stderr)
    sys.exit(1)


def venv_python():
    """Path to the backend venv's interpreter."""
    if IS_WINDOWS:
        return os.path.join(VENV_DIR, "Scripts", "python.exe")
    return os.path.join(VENV_DIR, "bin", "python")


def venv_is_usable(py):
    """True if `py` exists and has a working pip.

    A venv whose creation died partway (e.g. Debian's missing ensurepip) still
    leaves bin/python behind, so the interpreter existing is not enough — we
    would sail past creation and fail later on every pip call.
    """
    if not os.path.isfile(py):
        return False
    return subprocess.run([py, "-m", "pip", "--version"],
                          stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0


def venv_missing_ensurepip_hint():
    """Install hint for distros that ship venv without ensurepip (Debian/Ubuntu)."""
    ver = f"{sys.version_info.major}.{sys.version_info.minor}"
    return (
        "Your Python has the 'venv' module but not 'ensurepip', so it cannot "
        "create a virtualenv with pip in it.\n"
        "This is normal on Debian/Ubuntu — the piece lives in a separate "
        "package. Install it and re-run:\n\n"
        f"    sudo apt install python{ver}-venv\n\n"
        f"    python run.py"
    )


def create_venv():
    """Build backend/venv, cleaning up after a failed attempt.

    Tries the stdlib `venv` first and falls back to the `virtualenv` tool, which
    vendors its own pip and therefore works even where ensurepip is absent.
    """
    result = subprocess.run([sys.executable, "-m", "venv", VENV_DIR],
                            capture_output=True, text=True)
    if result.returncode == 0 and venv_is_usable(venv_python()):
        return

    # Leave no half-built venv behind: it would fool the next run into skipping
    # creation entirely.
    shutil.rmtree(VENV_DIR, ignore_errors=True)

    no_ensurepip = "ensurepip is not available" in (result.stderr or "")
    if no_ensurepip and shutil.which("virtualenv"):
        print("[run.py] 'python -m venv' is unusable here (no ensurepip) — "
              "falling back to 'virtualenv'.")
        fallback = subprocess.run(["virtualenv", "-p", sys.executable, VENV_DIR],
                                  capture_output=True, text=True)
        if fallback.returncode == 0 and venv_is_usable(venv_python()):
            return
        shutil.rmtree(VENV_DIR, ignore_errors=True)

    if no_ensurepip:
        fail(venv_missing_ensurepip_hint())
    fail("Could not create the backend virtualenv at "
         f"{VENV_DIR}\n\n{(result.stderr or '').strip()}")


def ensure_venv():
    """Create backend/venv on first run and return its interpreter path.

    The backend runs on its own venv so its geospatial stack (rasterio and the
    PROJ/GDAL data bundled with it) is self-contained and cannot be shifted by
    whatever happens to be installed in the ambient/system Python.
    """
    py = venv_python()
    if venv_is_usable(py):
        return py

    if os.path.isfile(py):
        print(f"[run.py] Backend venv at {VENV_DIR} has no working pip — "
              "rebuilding it.")
        shutil.rmtree(VENV_DIR, ignore_errors=True)
    else:
        print(f"[run.py] No backend venv found — creating one at {VENV_DIR}")
    print("[run.py] (first run only; this takes a few minutes)")

    create_venv()

    py = venv_python()
    subprocess.run([py, "-m", "pip", "install", "--upgrade", "pip"],
                   stdout=subprocess.DEVNULL)
    return py


def parse_requirements(req_file):
    """Return [(requirement_spec, module_name)] from a requirements file."""
    with open(req_file, "r") as f:
        specs = [ln.strip() for ln in f
                 if ln.strip() and not ln.strip().startswith("#")]
    out = []
    for spec in specs:
        # Base package name, e.g. "pydantic>=2.0" -> "pydantic"
        pkg = re.split(r"[<>=!]", spec)[0].strip()
        out.append((spec, PACKAGE_TO_MODULE.get(pkg.lower(), pkg)))
    return out


def check_imports(py, modules):
    """Import `modules` inside `py`; return {module: 'ok'|'missing'|'broken: …'}."""
    result = subprocess.run([py, "-c", _CHECK_SRC, *modules],
                            capture_output=True, text=True)
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except Exception:
        fail("Could not verify backend dependencies — the venv interpreter "
             f"failed to run:\n{result.stderr.strip()}")


def ensure_backend_deps(py):
    """Verify and install the backend's dependencies inside the venv."""
    print("[run.py] Verifying backend Python dependencies...")
    req_file = os.path.join(BACKEND_DIR, "requirements.txt")
    if not os.path.isfile(req_file):
        print(f"[run.py] WARNING: {req_file} not found. Skipping dependency check.")
        return

    reqs = parse_requirements(req_file)
    status = check_imports(py, [mod for _, mod in reqs])

    missing = [spec for spec, mod in reqs if status.get(mod) == "missing"]
    broken = [spec for spec, mod in reqs
              if str(status.get(mod, "")).startswith("broken")]
    for spec, mod in reqs:
        if str(status.get(mod, "")).startswith("broken"):
            print(f"[run.py] '{spec}' is installed but failed to import: "
                  f"{status[mod][8:]}")

    if not missing and not broken:
        print("[run.py] All backend Python dependencies are satisfied.")
        return

    if missing:
        print(f"[run.py] Missing Python dependencies: {', '.join(missing)}")
    if broken:
        print(f"[run.py] Broken Python dependencies: {', '.join(broken)}")
    print("[run.py] Running pip install (into backend/venv)...")
    try:
        subprocess.run([py, "-m", "pip", "install", "-r", req_file], check=True)
        print("[run.py] All Python dependencies successfully installed.")
    except Exception as e:
        fail(f"Failed to install python requirements: {e}")

    if broken:
        recheck = check_imports(py, [PACKAGE_TO_MODULE.get(
            re.split(r"[<>=!]", s)[0].strip().lower(),
            re.split(r"[<>=!]", s)[0].strip()) for s in broken])
        still_bad = [m for m, v in recheck.items() if v != "ok"]
        if still_bad:
            fail("These packages are still unimportable after reinstalling:\n"
                 f"  {', '.join(still_bad)}\n\n"
                 "This usually means a binary/ABI mismatch with numpy. Try:\n"
                 f"  {py} -m pip install --force-reinstall --no-cache-dir "
                 f"{' '.join(broken)}")
        print("[run.py] Previously broken packages now import cleanly.")


def free_port(port):
    """Terminate any process already listening on `port`.

    A previous run that was closed without Ctrl+C (or crashed) can leave uvicorn /
    Vite holding these ports. Without freeing them, a fresh `python run.py` fails:
    uvicorn cannot bind 7000 and Vite (--strictPort) aborts on 6173.
    """
    pids = set()
    try:
        if IS_WINDOWS:
            out = subprocess.run(["netstat", "-ano", "-p", "tcp"],
                                 capture_output=True, text=True).stdout
            for line in out.splitlines():
                parts = line.split()
                # Proto  LocalAddr  ForeignAddr  State  PID
                if len(parts) >= 5 and parts[3].upper() == "LISTENING" \
                        and parts[1].rsplit(":", 1)[-1] == str(port):
                    pids.add(parts[4])
        else:
            out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                                 capture_output=True, text=True).stdout
            pids.update(out.split())
    except Exception as e:
        print(f"[run.py] WARNING: could not inspect port {port}: {e}")
        return

    for pid in pids:
        if not pid or pid == "0":
            continue
        try:
            if IS_WINDOWS:
                subprocess.run(["taskkill", "/F", "/T", "/PID", pid],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(["kill", "-9", pid],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"[run.py] Freed port {port} (stopped leftover process PID {pid}).")
        except Exception:
            pass


def free_ports():
    """Free both app ports so a fresh launch always starts cleanly."""
    for port in (BACKEND_PORT, FRONTEND_PORT):
        free_port(port)


def npm_executable():
    """Resolve npm (npm.cmd on Windows) from PATH."""
    npm = shutil.which("npm")
    if not npm:
        fail("'npm' was not found on PATH. Install Node.js (https://nodejs.org) "
             "and reopen the terminal.")
    return npm


def ensure_frontend_deps(npm):
    """Run `npm install` once if node_modules is missing."""
    if not os.path.isdir(os.path.join(FRONTEND_DIR, "node_modules")):
        print("[run.py] node_modules not found — running 'npm install' (first run)...")
        subprocess.run([npm, "install"], cwd=FRONTEND_DIR, check=True,
                       shell=IS_WINDOWS)


def start_backend(py):
    """uvicorn must run from the project root because app.py imports 'backend.*'."""
    # Scope --reload to backend/ only. Watching the whole project root makes the
    # reloader scan the 77 MB aef_index.parquet, which is slow and can cause it
    # to miss changes; the frontend has its own (Vite) hot reload. backend/venv
    # is excluded for the same reason — thousands of files, none of them ours.
    #
    # Pass the venv as a bare directory, NOT a "venv/*" glob: uvicorn's CLI is
    # click-based, and click expands glob patterns in argv itself on Windows, so
    # "venv/*" arrives pre-expanded into its matching paths and uvicorn aborts
    # with "Got unexpected extra arguments". uvicorn treats an exclude that is an
    # existing directory as "ignore everything under it", which is what we want.
    cmd = [
        py, "-m", "uvicorn", "backend.app:app",
        "--host", BACKEND_HOST, "--port", str(BACKEND_PORT),
        "--reload", "--reload-dir", BACKEND_DIR,
        "--reload-exclude", VENV_DIR,
    ]
    print(f"[run.py] Starting backend:  {' '.join(cmd)}")
    return subprocess.Popen(cmd, cwd=PROJECT_ROOT)


def start_frontend(npm):
    # --strictPort so the printed URL is always correct (fails loudly if busy).
    cmd = [npm, "run", "dev", "--", "--port", str(FRONTEND_PORT), "--strictPort"]
    print(f"[run.py] Starting frontend: {' '.join(cmd)}")
    return subprocess.Popen(cmd, cwd=FRONTEND_DIR, shell=IS_WINDOWS)


def terminate_all():
    for p in procs:
        if p.poll() is not None:
            continue
        try:
            if IS_WINDOWS:
                # Kill the whole process tree (npm spawns node/vite children).
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                p.terminate()
        except Exception:
            pass


# --- Main --------------------------------------------------------------------
def main():
    py = ensure_venv()
    print(f"[run.py] Backend interpreter: {py}")
    ensure_backend_deps(py)
    npm = npm_executable()
    ensure_frontend_deps(npm)

    # Make sure no leftover servers from a previous run are holding the ports.
    print("[run.py] Checking ports are free...")
    free_ports()

    atexit.register(terminate_all)

    procs.append(start_backend(py))
    procs.append(start_frontend(npm))

    print("\n" + "=" * 56)
    print("  PhytoLens is starting up")
    print("-" * 56)
    print(f"  FRONTEND (open this):  http://localhost:{FRONTEND_PORT}")
    print(f"  Backend API:           http://{BACKEND_HOST}:{BACKEND_PORT}")
    print(f"  API docs:              http://{BACKEND_HOST}:{BACKEND_PORT}/docs")
    print("-" * 56)
    print("  Press Ctrl+C to stop both servers.")
    print("=" * 56 + "\n")

    try:
        # Wait until either process exits; if one dies, shut the other down too.
        while True:
            for p in procs:
                code = p.poll()
                if code is not None:
                    print(f"\n[run.py] A server exited (code {code}). Shutting down...")
                    return
            try:
                procs[0].wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        print("\n[run.py] Ctrl+C received. Stopping servers...")
    finally:
        terminate_all()


if __name__ == "__main__":
    # Make Ctrl+C behave predictably on Windows.
    try:
        signal.signal(signal.SIGINT, signal.default_int_handler)
    except Exception:
        pass
    main()
