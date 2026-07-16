# PhytoLens 🛰️🌾

PhytoLens is a state-of-the-art geospatial dashboard designed for crop health monitoring, land classification, and environmental analysis. By integrating a FastAPI backend with a React & Vite frontend, PhytoLens harnesses satellite imagery from Microsoft's Planetary Computer to provide real-time agricultural insights.

---

## 🌟 Key Features

### 1. Spectral Index Analysis (`Sentinel-2`, `Landsat 8/9`, `Sentinel-1`)
*   Compute standard remote sensing indices:
    *   **NDVI** (Normalized Difference Vegetation Index) for canopy greenness and crop vigor.
    *   **GNDVI** (Green NDVI) for chlorophyll sensitivity.
    *   **NDWI** (Normalized Difference Water Index) for open water and soil moisture.
    *   **NDMI** (Normalized Difference Moisture Index) for vegetation water stress.
    *   **LST** (Land Surface Temperature) derived from thermal bands.
*   **🛠️ Custom Band Math**: Write your own band algebra formulas dynamically on the fly.
*   Interactive color stretching, min/max visualization tuning, and statistics summary.

### 2. Time Series Profiling
*   Track crop development trends over historical date ranges.
*   Automated cloud filtering and even subsampling of scenes.
*   Visual statistical curves representing mean, min, max, and standard deviation over time.

### 3. Land Use / Land Cover (LULC) Classification
*   Map and evaluate land classification using:
    *   **ESA WorldCover** (10m global land cover).
*   Automatic area calculations (in square kilometers) for forests, cropland, grassland, water bodies, built-up areas, and bare land.

### 4. SAR Flood Detection
*   Detect open water and flood inundation using **Sentinel-1 GRD radar imagery** (VV/VH bands, IW mode).
*   Employs advanced despeckling (`Lee` filter) and difference-based thresholding (dB drop).
*   Supports uploading custom ROI geometries and generates comparative before/after grayscale maps alongside a flood mask overlay.

### 5. Advanced SEBAL Evapotranspiration (ETa)
*   Estimate actual evapotranspiration ($ET_a$) using the **SEBAL** energy balance model from Landsat thermal and optical inputs.
*   Downloads hourly meteorological reanalysis data from **ECMWF ERA5-Land** (via Copernicus CDS API) for automatic calibration of dry and wet anchor pixels.

### 6. Landslide Susceptibility (Disaster Management)
*   **District-wise analysis** — select any state/district to see the 5-class susceptibility composition (Very Low → Very High), analysed-area share and probability statistics, with class/probability raster overlays for all of India.
*   **National Highway-wise analysis** — select any of 1,000+ National Highways / expressways to analyse landslide exposure along its corridor:
    *   Computes the highway's **total length** and generates a **buffer corridor** (250 m / 500 m / 1 km each side).
    *   Overlays the corridor on the susceptibility model and reports the **length and percentage of the highway in each susceptibility class** (tabular + donut/stacked-bar charts), the corridor's area composition, and min/mean/max landslide probability.
    *   Draws the highway on the map **coloured stretch-by-stretch by susceptibility class** together with the buffer outline, so vulnerable stretches can be located for mitigation and maintenance planning.
    *   All analysis runs on the **full-resolution `INDIA_NATIONAL_HIGHWAY.geojson`** (repo root, ~100 MB, kept out of git) — never on simplified geometry, so winding mountain alignments keep their true length. The web map's orange overlay is generated from the same source for display (`backend/make_highway_overlay.py` → `highways_overlay.json`).
    *   Statistics for every highway are precomputed (`backend/precompute_highway_stats.py` → `frontend/public/highway_stats.json` + `highway_segments/`), so the deployed app needs no rasters; a live endpoint (`/api/highway-stats`) recomputes on demand when the full-resolution rasters are available.

---

## 🚀 Getting Started

### 📋 Prerequisites
*   **Python 3.8+**
*   **Node.js** (v16+) & **npm**
*   *Optional:* Copernicus CDS API token (configured in `~/.cdsapirc`) to use SEBAL evapotranspiration features.

### ⚡ Quick Start (One-Command Launcher)
We provide a unified launcher script that handles dependency checks, frees standard ports, and launches both frontend and backend development servers together.

Simply run:
```bash
python run.py
```

This command will:
1. Create a dedicated virtualenv at `backend/venv` on first run (takes a few minutes).
2. Check and install missing Python packages from `backend/requirements.txt` **into that venv**.
3. Check and run `npm install` inside the `frontend/` directory.
4. Automatically free up ports `7000` (Backend) and `6173` (Frontend) if they are currently locked.
5. Launch both servers in parallel and output hot-reloading logs in the terminal.

The backend always runs on `backend/venv`, never on the ambient/system Python — so
its geospatial stack (rasterio, and the PROJ/GDAL data bundled with it) is
self-contained and reproducible. You do not need to activate the venv yourself;
`run.py` invokes it by path. To run the backend directly without the launcher:

```bash
# Windows
backend\venv\Scripts\python -m uvicorn backend.app:app --port 7000
# macOS / Linux
backend/venv/bin/python -m uvicorn backend.app:app --port 7000
```

Run it from the **project root** (not from `backend/`) — `backend/app.py` imports
`backend.*`, and the package's `__init__` is what isolates PROJ (see below).

> **Note — PROJ / PostGIS conflict on Windows.** The PostgreSQL/PostGIS installer sets
> machine-wide `PROJ_LIB` and `GDAL_DATA` variables pointing at its own (older) PROJ
> data. Every process inherits them, and rasterio honours `PROJ_LIB` when set, so EPSG
> lookups fail with *"proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2 whereas a
> number >= 5 is expected"*. A venv does **not** fix this on its own — it does not
> scrub environment variables. `backend/_proj_env.py` drops those inherited vars at
> import time so rasterio falls back to its own bundled PROJ data. It runs from
> `backend/__init__.py`, before anything imports rasterio, because PROJ reads those
> vars once at C-library init.

Once started, navigate to:
*   **Frontend Web App**: `http://localhost:6173`
*   **FastAPI backend**: `http://127.0.0.1:7000`
*   **Interactive API Docs**: `http://127.0.0.1:7000/docs`

---

## 📁 Repository Structure

```
demo-dashboard/
├── backend/                # FastAPI Application
│   ├── __init__.py         # Package init — isolates PROJ before rasterio loads
│   ├── _proj_env.py        # Drops inherited PostGIS PROJ_LIB/GDAL_DATA vars
│   ├── app.py              # Main API routes (Spectral, LULC, Flood, ET)
│   ├── pc_handler.py       # Planetary Computer client wrappers (STAC search, band-alignment)
│   ├── sebal.py            # Evapotranspiration Energy Balance math
│   ├── requirements.txt    # Python packages
│   └── venv/               # Backend's own virtualenv (git-ignored, created by run.py)
├── frontend/               # React Dashboard (Vite)
│   ├── src/
│   │   ├── App.jsx         # Dashboard components & Leaflet map integration
│   │   └── index.css       # Premium custom Tailwind/Vanilla CSS design
│   ├── package.json        # Node dependencies & scripts
│   └── vite.config.js      # Dev server configs
├── run.py                  # Multi-process helper launcher
└── README.md               # Project documentation (this file)
```

---

## 🛠️ Tech Stack
*   **Backend**: FastAPI, Uvicorn, Planetary Computer STAC Client, Rasterio, NumPy, Pandas, Xarray, NetCDF4.
*   **Frontend**: React.js, Vite, Leaflet Maps, Chart.js / Recharts (dynamic graphing), CSS3.
