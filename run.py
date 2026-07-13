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
import signal
import shutil
import subprocess
import atexit

# --- Configuration -----------------------------------------------------------
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 7000          # must match API_BASE in frontend/src/App.jsx
FRONTEND_PORT = 6173         # Vite dev server

IS_WINDOWS = os.name == "nt"
procs = []                   # child processes to clean up


# --- Helpers -----------------------------------------------------------------
def fail(msg):
    print(f"\n[run.py] ERROR: {msg}\n", file=sys.stderr)
    sys.exit(1)


def ensure_backend_deps():
    """Verify and install python dependencies if any are missing."""
    print("[run.py] Verifying backend Python dependencies...")
    req_file = os.path.join(PROJECT_ROOT, "backend", "requirements.txt")
    if not os.path.isfile(req_file):
        print(f"[run.py] WARNING: {req_file} not found. Skipping dependency check.")
        return

    # Read requirements.txt
    with open(req_file, "r") as f:
        requirements = [line.strip() for line in f if line.strip() and not line.strip().startswith("#")]

    # Map package names to importable module names where they differ
    package_to_module = {
        "pystac-client": "pystac_client",
        "planetary-computer": "planetary_computer",
        "scikit-learn": "sklearn",
        "pillow": "PIL"
    }

    missing_packages = []
    for req in requirements:
        # Extract the base package name (e.g. pydantic>=2.0 -> pydantic)
        pkg_name = re.split(r'[<>=!]', req)[0].strip()
        module_name = package_to_module.get(pkg_name.lower(), pkg_name)
        try:
            __import__(module_name)
        except ImportError:
            missing_packages.append(req)

    if missing_packages:
        print(f"[run.py] Missing/unsatisfied Python dependencies: {', '.join(missing_packages)}")
        print("[run.py] Running pip install...")
        try:
            cmd = [sys.executable, "-m", "pip", "install", "-r", req_file]
            subprocess.run(cmd, check=True)
            print("[run.py] All Python dependencies successfully installed.")
        except Exception as e:
            fail(f"Failed to install python requirements: {e}")
    else:
        print("[run.py] All backend Python dependencies are satisfied.")


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


def start_backend():
    """uvicorn must run from the project root because app.py imports 'backend.*'."""
    # Scope --reload to backend/ only. Watching the whole project root makes the
    # reloader scan .venv and the 77 MB aef_index.parquet, which is slow and can
    # cause it to miss changes; the frontend has its own (Vite) hot reload.
    backend_dir = os.path.join(PROJECT_ROOT, "backend")
    cmd = [
        sys.executable, "-m", "uvicorn", "backend.app:app",
        "--host", BACKEND_HOST, "--port", str(BACKEND_PORT),
        "--reload", "--reload-dir", backend_dir,
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
    ensure_backend_deps()
    npm = npm_executable()
    ensure_frontend_deps(npm)

    # Make sure no leftover servers from a previous run are holding the ports.
    print("[run.py] Checking ports are free...")
    free_ports()

    atexit.register(terminate_all)

    procs.append(start_backend())
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
