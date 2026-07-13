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
1. Check and install missing Python packages from `backend/requirements.txt`.
2. Check and run `npm install` inside the `frontend/` directory.
3. Automatically free up ports `7000` (Backend) and `6173` (Frontend) if they are currently locked.
4. Launch both servers in parallel and output hot-reloading logs in the terminal.

Once started, navigate to:
*   **Frontend Web App**: `http://localhost:6173`
*   **FastAPI backend**: `http://127.0.0.1:7000`
*   **Interactive API Docs**: `http://127.0.0.1:7000/docs`

---

## 📁 Repository Structure

```
demo-dashboard/
├── backend/                # FastAPI Application
│   ├── app.py              # Main API routes (Spectral, LULC, Flood, ET)
│   ├── pc_handler.py       # Planetary Computer client wrappers (STAC search, band-alignment)
│   ├── sebal.py            # Evapotranspiration Energy Balance math
│   └── requirements.txt    # Python packages
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
