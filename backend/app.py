import os
import re
import uuid
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

from backend.pc_handler import (
    search_stac,
    get_catalog,
    read_aligned_bands,
    calculate_index,
    calculate_roi_stats,
    get_color_palette,
    save_visual_png,
    save_geotiff,
    sample_geotiff_value,
    extract_geojson_geometries,
    fetch_lulc_raster,
    get_lulc_legend,
    colorize_lulc_png,
    compute_lulc_stats,
    compute_flood_grid,
    load_grd_vv_db,
    save_mask_png,
    despeckle_db,
    remove_small_blobs,
    GDAL_OPTS,
    read_window_bands_parallel,
)
from backend import sebal

app = FastAPI(title="PhytoLens API", description="Geospatial Tools for Crop Health")

# CORS middleware to allow React app requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static directory for serving generated images and exports
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
os.makedirs(STATIC_DIR, exist_ok=True)

class SearchRequest(BaseModel):
    platform: str
    bbox: List[float]  # [min_lon, min_lat, max_lon, max_lat]
    start_date: str
    end_date: str
    cloud_cover: Optional[float] = 10.0
    orbit: Optional[str] = "BOTH"

class CalculateRequest(BaseModel):
    platform: str
    item_id: str
    bbox: List[float]
    index: str
    formula: Optional[str] = None
    palette: str
    vis_min: Optional[float] = None
    vis_max: Optional[float] = None
    geometry: Optional[Dict[str, Any]] = None

class TimeSeriesRequest(BaseModel):
    platform: str
    bbox: List[float]
    start_date: str
    end_date: str
    index: str
    formula: Optional[str] = None
    cloud_cover: Optional[float] = 10.0
    geometry: Optional[Dict[str, Any]] = None
    max_scenes: Optional[int] = 15

class LulcRequest(BaseModel):
    bbox: List[float]  # [min_lon, min_lat, max_lon, max_lat]
    dataset: str       # "esa-worldcover" or "io-lulc"
    year: int
    geometry: Optional[Dict[str, Any]] = None

class FloodRequest(BaseModel):
    bbox: List[float]            # [min_lon, min_lat, max_lon, max_lat]
    pre_start: str              # pre-event search window start  (YYYY-MM-DD)
    pre_end: str               # pre-event search window end
    post_start: str            # post-event search window start
    post_end: str              # post-event search window end
    event_date: Optional[str] = None   # flood reference date; defaults to post_start
    orbit: Optional[str] = "descending"  # Sentinel-1 orbit pass to match the event
    threshold_db: Optional[float] = 3.0  # backscatter drop (dB) flagged as new water
    geometry: Optional[Dict[str, Any]] = None

class AefClusterRequest(BaseModel):
    bbox: List[float]
    year: int
    num_clusters: int
    geometry: Optional[Dict[str, Any]] = None

class AefSimilarityRequest(BaseModel):
    bbox: List[float]
    year: int
    query_geometry: Dict[str, Any]
    threshold: Optional[float] = None  # default chosen per mode below
    geometry: Optional[Dict[str, Any]] = None
    palette: Optional[str] = "Viridis (Sequential)"
    # "centered" = mean-centered cosine (default; resolves distinct features such
    # as water in homogeneous ROIs). "dotproduct" = raw dot product (Google's
    # literal method; best for diverse scenes / distinct rare targets).
    mode: Optional[str] = "centered"

class EtRequest(BaseModel):
    """Single-date SEBAL evapotranspiration for one Landsat-9 scene."""
    item_id: str
    bbox: List[float]                # [min_lon, min_lat, max_lon, max_lat]
    palette: Optional[str] = "ET (Dry-Wet)"
    vis_min: Optional[float] = None
    vis_max: Optional[float] = None
    geometry: Optional[Dict[str, Any]] = None

class EtTimeSeriesRequest(BaseModel):
    """SEBAL ETa trend over multiple Landsat-9 scenes in a date range.

    No cloud filter — all Landsat-9 scenes in the window are eligible and each
    point carries its scene cloud-cover %. Scenes are subsampled to max_scenes
    (hard-capped) because every date triggers a separate, slow ERA5-Land (CDS)
    retrieval.
    """
    bbox: List[float]
    start_date: str
    end_date: str
    geometry: Optional[Dict[str, Any]] = None
    max_scenes: Optional[int] = 6

def clean_old_static_files(max_age_seconds=1800):
    """Remove generated static files older than max_age_seconds (default 30 min).

    Age-based rather than count-based: a count-based purge (delete the N oldest)
    can race with an in-flight client download and delete a PNG/TIFF that was
    just written for the current request, yielding a 404. Only files that have
    aged past the threshold are removed.
    """
    try:
        import time
        now = time.time()
        for name in os.listdir(STATIC_DIR):
            f = os.path.join(STATIC_DIR, name)
            try:
                if os.path.isfile(f) and (now - os.path.getmtime(f)) > max_age_seconds:
                    os.remove(f)
            except OSError:
                pass
    except Exception:
        pass


def validate_bbox(bbox):
    """Validate an incoming [min_lon, min_lat, max_lon, max_lat] bbox.

    Raises HTTPException(400) for degenerate or antimeridian-crossing boxes,
    which would otherwise silently produce an empty/garbage raster grid.
    """
    if not bbox or len(bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox must be [min_lon, min_lat, max_lon, max_lat].")
    min_lon, min_lat, max_lon, max_lat = bbox
    if max_lon <= min_lon:
        raise HTTPException(
            status_code=400,
            detail="Invalid bbox: max_lon must be greater than min_lon. "
                   "Boxes crossing the antimeridian (180°) are not supported."
        )
    if max_lat <= min_lat:
        raise HTTPException(status_code=400, detail="Invalid bbox: max_lat must be greater than min_lat.")

def get_band_mapping_and_collection(platform: str, index: str, formula: Optional[str] = None):
    """
    Helper to resolve band mapping, STAC collection name, and target resolution.
    """
    band_mapping = {}
    collection = ""
    target_res = 10
    
    if platform == "Sentinel-2 (Optical)":
        collection = "sentinel-2-l2a"
        if index == "NDVI":
            band_mapping = {"B4": "B04", "B8": "B08"}
        elif index == "GNDVI":
            band_mapping = {"B3": "B03", "B8": "B08"}
        elif index == "NDWI (Water)":
            band_mapping = {"B3": "B03", "B8": "B08"}
        elif index == "NDMI":
            band_mapping = {"B8": "B08", "B11": "B11"}
        elif index == "🛠️ Custom (Band Math)":
            # Extract all Bxx from custom formula
            bands_in_formula = list(set(re.findall(r'\bB[0-9]+[A-Z]?\b', formula or "")))

            def _s2_asset(b):
                # Sentinel-2 MPC assets are zero-padded ("B04", "B08") with the
                # exception of alpha-suffixed bands like "B8A", which map to
                # themselves. Guard against int("8A") which would raise ValueError.
                suffix = b[1:]
                if not suffix.isdigit():        # e.g. B8A
                    return b
                if len(b) > 2 and b[1] == '0':  # already padded, e.g. B08
                    return b
                return f"B{int(suffix):02d}"

            band_mapping = {b: _s2_asset(b) for b in bands_in_formula}
        else:
            raise HTTPException(status_code=400, detail="Invalid index selection for Sentinel-2.")
            
    elif "Landsat" in platform:
        collection = "landsat-c2-l2"
        target_res = 30
        if index == "NDVI":
            band_mapping = {"B4": "red", "B5": "nir08"}
        elif index == "GNDVI":
            band_mapping = {"B3": "green", "B5": "nir08"}
        elif index == "NDWI (Water)":
            band_mapping = {"B3": "green", "B5": "nir08"}
        elif index == "NDMI":
            band_mapping = {"B5": "nir08", "B6": "swir16"}
        elif index == "LST (Thermal)":
            band_mapping = {"ST_B10": "lwir11"}
        elif index == "🛠️ Custom (Band Math)":
            # Map B1..B7 to Landsat band names
            landsat_map = {
                "B1": "coastal", "B2": "blue", "B3": "green", "B4": "red",
                "B5": "nir08", "B6": "swir16", "B7": "swir22"
            }
            bands_in_formula = list(set(re.findall(r'\bB[1-7]\b', formula or "")))
            band_mapping = {b: landsat_map[b] for b in bands_in_formula if b in landsat_map}
        else:
            raise HTTPException(status_code=400, detail="Invalid index selection for Landsat.")
            
    elif platform == "Sentinel-1 (Radar)":
        collection = "sentinel-1-grd"
        if index == "VV":
            band_mapping = {"VV": "vv"}
        elif index == "VH":
            band_mapping = {"VH": "vh"}
        elif index == "VH/VV Ratio":
            band_mapping = {"VV": "vv", "VH": "vh"}
        elif index == "🛠️ Custom (Band Math)":
            band_mapping = {"VV": "vv", "VH": "vh"}
        else:
            raise HTTPException(status_code=400, detail="Invalid polarization selection for Sentinel-1.")
            
    else:
        raise HTTPException(status_code=400, detail="Invalid platform selection.")
        
    return band_mapping, collection, target_res

@app.get("/api/health")
def health():
    return {"status": "online", "engine": "Planetary Computer"}

@app.post("/api/search")
def search_scenes(req: SearchRequest):
    collection = ""
    if "Sentinel-2" in req.platform:
        collection = "sentinel-2-l2a"
    elif "Landsat" in req.platform:
        collection = "landsat-c2-l2"
    elif "Sentinel-1" in req.platform:
        collection = "sentinel-1-grd"
    else:
        raise HTTPException(status_code=400, detail="Invalid satellite platform selection.")
        
    date_range = f"{req.start_date}/{req.end_date}"
    
    try:
        results, items = search_stac(
            collection=collection,
            bbox=req.bbox,
            date_range=date_range,
            cloud_cover=req.cloud_cover,
            orbit=req.orbit
        )
        
        # Filter Landsat 8/9 items specifically by platform identifier if needed
        if "Landsat 9" in req.platform:
            results = [r for r in results if "landsat-9" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-9"]
        elif "Landsat 8" in req.platform:
            results = [r for r in results if "landsat-8" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-8"]
            
        return {
            "count": len(results),
            "scenes": results[:50]  # Return top 50 scenes
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STAC search error: {str(e)}")

@app.post("/api/spectral/calculate")
def calculate_spectral_index(req: CalculateRequest):
    clean_old_static_files()
    validate_bbox(req.bbox)

    try:
        band_mapping, collection, target_res = get_band_mapping_and_collection(
            req.platform, req.index, req.formula
        )
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        # 2. Get item
        catalog = get_catalog()
        item = catalog.get_collection(collection).get_item(req.item_id)
        if not item:
            raise HTTPException(status_code=404, detail=f"Scene {req.item_id} not found in collection {collection}.")
            
        # 3. Fetch & Align Bands
        bands_data, transform, crs = read_aligned_bands(
            item=item,
            bbox_wgs84=req.bbox,
            band_mapping=band_mapping,
            target_resolution=target_res
        )
        
        # Check if we successfully read data
        if not bands_data:
            raise HTTPException(status_code=500, detail="Could not retrieve any raster bands from STAC. The area or scene selection might be invalid.")

        # Fail clearly (400) if a required band asset was missing from the scene,
        # instead of letting a None array crash later with an opaque 500.
        missing = [b for b in band_mapping if b not in bands_data]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Scene {req.item_id} is missing required band(s): {', '.join(missing)}."
            )

        # 4. Compute index
        index_array = calculate_index(bands_data, req.platform, req.index, req.formula)
        if index_array is None:
            raise HTTPException(
                status_code=400,
                detail="Could not compute the index — required bands are unavailable for this scene/platform."
            )
        
        # Apply geometry mask if geometry is provided
        if req.geometry:
            from rasterio.features import geometry_mask
            geoms = extract_geojson_geometries(req.geometry)
            if geoms:
                mask = geometry_mask(geoms, out_shape=index_array.shape, transform=transform, invert=False)
                index_array[mask] = np.nan
        
        # 5. Stats & Visual stretch
        stats = calculate_roi_stats(index_array)
        
        vmin = req.vis_min if req.vis_min is not None else stats["p2"]
        vmax = req.vis_max if req.vis_max is not None else stats["p98"]
        
        # Calculate index-specific density bins for visual HUD donut charts
        density_bins = None
        valid = index_array[~np.isnan(index_array) & ~np.isinf(index_array)]
        if len(valid) > 0:
            total = len(valid)
            if req.index in ["NDVI", "GNDVI"]:
                high_count = np.sum(valid >= 0.6)
                mod_count = np.sum((valid >= 0.2) & (valid < 0.6))
                low_count = np.sum((valid >= 0.0) & (valid < 0.2))
                bare_count = np.sum(valid < 0.0)
                density_bins = {
                    "high": int(round((high_count / total) * 100)),
                    "moderate": int(round((mod_count / total) * 100)),
                    "low": int(round((low_count / total) * 100)),
                    "bare": int(round((bare_count / total) * 100))
                }
            elif "NDWI" in req.index:
                water_count = np.sum(valid >= 0.2)
                land_count = np.sum(valid < 0.2)
                density_bins = {
                    "water": int(round((water_count / total) * 100)),
                    "land": int(round((land_count / total) * 100))
                }
            elif "LST" in req.index:
                hot_count = np.sum(valid >= 35)
                warm_count = np.sum((valid >= 25) & (valid < 35))
                mild_count = np.sum((valid >= 15) & (valid < 25))
                cool_count = np.sum(valid < 15)
                density_bins = {
                    "hot": int(round((hot_count / total) * 100)),
                    "warm": int(round((warm_count / total) * 100)),
                    "mild": int(round((mild_count / total) * 100)),
                    "cool": int(round((cool_count / total) * 100))
                }
            else:
                # Default: split index range into 4 equal bins
                min_val = np.min(valid)
                max_val = np.max(valid)
                r = max_val - min_val if max_val > min_val else 1.0
                bin1 = np.sum(valid < min_val + 0.25*r)
                bin2 = np.sum((valid >= min_val + 0.25*r) & (valid < min_val + 0.5*r))
                bin3 = np.sum((valid >= min_val + 0.5*r) & (valid < min_val + 0.75*r))
                bin4 = np.sum(valid >= min_val + 0.75*r)
                density_bins = {
                    "bin1": int(round((bin1 / total) * 100)),
                    "bin2": int(round((bin2 / total) * 100)),
                    "bin3": int(round((bin3 / total) * 100)),
                    "bin4": int(round((bin4 / total) * 100))
                }
        
        # 6. Save visual PNG and raw GeoTIFF
        req_id = str(uuid.uuid4())
        png_filename = f"{req_id}_visual.png"
        tiff_filename = f"{req_id}_raw.tif"
        
        png_path = os.path.join(STATIC_DIR, png_filename)
        tiff_path = os.path.join(STATIC_DIR, tiff_filename)
        
        palette_colors = get_color_palette(req.palette)
        save_visual_png(index_array, vmin, vmax, palette_colors, png_path)
        save_geotiff(index_array, transform, crs, tiff_path)

        return {
            "req_id": req_id,
            "image_url": f"/api/static/{png_filename}",
            "geotiff_url": f"/api/static/{tiff_filename}",
            "stats": stats,
            "vis_min": vmin,
            "vis_max": vmax,
            "density_bins": density_bins
        }

    except HTTPException:
        raise
    except ValueError as ve:
        # e.g. an invalid custom formula — a client error, not a 500.
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calculation error: {str(e)}")

@app.post("/api/spectral/time-series")
def calculate_time_series(req: TimeSeriesRequest):
    """
    Calculate statistics for a remote sensing index over multiple scenes in a seasonal date range.
    """
    validate_bbox(req.bbox)
    try:
        band_mapping, collection, target_res = get_band_mapping_and_collection(
            req.platform, req.index, req.formula
        )
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    date_range = f"{req.start_date}/{req.end_date}"
    
    try:
        results, items = search_stac(
            collection=collection,
            bbox=req.bbox,
            date_range=date_range,
            cloud_cover=req.cloud_cover,
            orbit="BOTH",
            limit=100
        )
        
        # Filter Landsat 8/9 items specifically by platform identifier if needed
        if "Landsat 9" in req.platform:
            results = [r for r in results if "landsat-9" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-9"]
            items = [item for item in items if "landsat-9" in item.id.lower() or item.properties.get("platform", "").lower() == "landsat-9"]
        elif "Landsat 8" in req.platform:
            results = [r for r in results if "landsat-8" in r["id"].lower() or r["properties"].get("platform", "").lower() == "landsat-8"]
            items = [item for item in items if "landsat-8" in item.id.lower() or item.properties.get("platform", "").lower() == "landsat-8"]
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STAC search error: {str(e)}")

    if not results:
        return {
            "timeseries": [],
            "index": req.index,
            "platform": req.platform
        }

    # Sort results chronologically (ascending date)
    results.sort(key=lambda x: x["date"])
    
    # Map item ID to Item object to keep them aligned
    item_map = {item.id: item for item in items}
    
    # Limit to max_scenes, subsampling evenly if count exceeds max_scenes
    max_s = req.max_scenes or 15
    if len(results) > max_s:
        indices = np.linspace(0, len(results) - 1, max_s, dtype=int)
        results = [results[i] for i in indices]
        
    timeseries_data = []
    catalog = get_catalog()
    
    for scene in results:
        scene_id = scene["id"]
        date_str = scene["date"]
        cc = scene["cloud_cover"]
        
        item = item_map.get(scene_id)
        if not item:
            try:
                item = catalog.get_collection(collection).get_item(scene_id)
            except Exception:
                continue
                
        if not item:
            continue
            
        try:
            # Fetch & Align Bands
            bands_data, transform, crs = read_aligned_bands(
                item=item,
                bbox_wgs84=req.bbox,
                band_mapping=band_mapping,
                target_resolution=target_res
            )
            
            if not bands_data:
                continue

            # Compute index
            index_array = calculate_index(bands_data, req.platform, req.index, req.formula)
            
            # Apply geometry mask if geometry is provided
            if req.geometry:
                from rasterio.features import geometry_mask
                geoms = extract_geojson_geometries(req.geometry)
                if geoms:
                    mask = geometry_mask(geoms, out_shape=index_array.shape, transform=transform, invert=False)
                    index_array[mask] = np.nan
            
            # Compute stats
            stats = calculate_roi_stats(index_array)
            
            if np.isnan(stats["mean"]):
                continue
                
            timeseries_data.append({
                "date": date_str,
                "scene_id": scene_id,
                "mean": float(stats["mean"]),
                "min": float(stats["min"]),
                "max": float(stats["max"]),
                "std": float(stats["std"]),
                "cloud_cover": float(cc) if cc is not None else 0.0
            })
        except Exception as e:
            # Resiliently skip corrupt/partial scenes
            print(f"Skipping scene {scene_id} due to calculation error: {e}")
            continue
            
    return {
        "timeseries": timeseries_data,
        "index": req.index,
        "platform": req.platform
    }


@app.post("/api/lulc/calculate")
def calculate_lulc(req: LulcRequest):
    """
    Fetch and classify a Land Use / Land Cover raster from Planetary Computer.
    Supports ESA WorldCover (2020-2021) and IO LULC Annual v02 (2017-2023).
    """
    clean_old_static_files()
    validate_bbox(req.bbox)

    try:
        # 1. Fetch & reproject the LULC raster
        class_array, transform, crs = fetch_lulc_raster(
            bbox_wgs84=req.bbox,
            dataset=req.dataset,
            year=req.year
        )

        # 2. Apply geometry mask if provided
        if req.geometry:
            from rasterio.features import geometry_mask
            geoms = extract_geojson_geometries(req.geometry)
            if geoms:
                mask = geometry_mask(geoms, out_shape=class_array.shape, transform=transform, invert=False)
                class_array[mask] = 0  # Set masked pixels to nodata

        # 3. Get legend and compute stats
        legend = get_lulc_legend(req.dataset)

        # Approximate pixel area in m² based on bbox and grid dimensions
        h, w = class_array.shape
        lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
        # Approximate meters per degree at this latitude
        m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
        m_per_deg_lat = 110540
        pixel_w_m = ((req.bbox[2] - req.bbox[0]) / w) * m_per_deg_lon
        pixel_h_m = ((req.bbox[3] - req.bbox[1]) / h) * m_per_deg_lat
        pixel_area_m2 = pixel_w_m * pixel_h_m

        stats = compute_lulc_stats(class_array, legend, pixel_area_m2)

        # 4. Colorize and save PNG (+ GeoTIFF so the class value can be point-queried)
        req_id = str(uuid.uuid4())
        png_filename = f"{req_id}_lulc.png"
        png_path = os.path.join(STATIC_DIR, png_filename)
        colorize_lulc_png(class_array, legend, png_path)

        tiff_filename = f"{req_id}_lulc.tif"
        tiff_path = os.path.join(STATIC_DIR, tiff_filename)
        save_geotiff(class_array.astype(np.float32), transform, crs, tiff_path)

        # Build legend info for frontend
        legend_info = {}
        for class_val, info in legend.items():
            legend_info[str(class_val)] = {
                "name": info["name"],
                "color": info["color"]
            }

        return {
            "req_id": req_id,
            "image_url": f"/api/static/{png_filename}",
            "geotiff_url": f"/api/static/{tiff_filename}",
            "stats": stats,
            "legend": legend_info,
            "bbox": req.bbox,
            "year": req.year,
            "dataset": req.dataset
        }

    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LULC calculation error: {str(e)}")


@app.post("/api/flood/detect")
def detect_flood(req: FloodRequest):
    """
    Sentinel-1 SAR flood detection (same methodology as flood.py).

    flood.py composited every scene in fixed pre/post windows. The change here: the
    caller supplies a pre-event and a post-event date range, and for each range we
    pick the single scene CLOSEST TO THE EVENT (the latest pre-event scene and the
    earliest post-event scene — the two straddling the flood) instead of compositing.

    Flood = the drop in VV backscatter (dB) from the pre scene to the post scene.
    To make a single-scene difference reliable we (a) median-filter each scene to
    suppress SAR speckle, (b) subtract the global median difference so the threshold
    measures genuine local darkening rather than a scene-to-scene calibration offset,
    and (c) drop tiny isolated blobs. Pixels darkening by more than `threshold_db`
    are flagged as candidate new water.
    """
    clean_old_static_files()
    validate_bbox(req.bbox)

    from datetime import date as _date

    def _parse_day(s):
        y, m, d = (int(x) for x in s.split("T")[0].split("-")[:3])
        return _date(y, m, d)

    pre_start, pre_end = req.pre_start, req.pre_end
    post_start, post_end = req.post_start, req.post_end
    orbit = (req.orbit or "descending").lower()
    threshold = req.threshold_db if req.threshold_db is not None else 3.0

    # 1. Search Sentinel-1 GRD scenes spanning the whole pre..post period.
    try:
        results, items = search_stac(
            collection="sentinel-1-grd",
            bbox=req.bbox,
            date_range=f"{pre_start}/{post_end}",
            orbit=orbit,
            limit=100,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sentinel-1 STAC search error: {str(e)}")

    # Keep IW-mode scenes that carry a VV asset (the flood.py recipe).
    item_map = {it.id: it for it in items}
    candidates = []  # (date_str, item)
    for r in results:
        it = item_map.get(r["id"])
        if it is None:
            continue
        if it.properties.get("sar:instrument_mode", "IW") != "IW":
            continue
        if "vv" not in it.assets:
            continue
        candidates.append((r["date"], it))

    pre = [(d, it) for (d, it) in candidates if pre_start <= d <= pre_end]
    post = [(d, it) for (d, it) in candidates if post_start <= d <= post_end]

    if not pre:
        raise HTTPException(
            status_code=404,
            detail=f"No Sentinel-1 ({orbit}) VV/IW scenes in the pre-event window "
                   f"{pre_start} … {pre_end}. Widen the range or change the orbit pass."
        )
    if not post:
        raise HTTPException(
            status_code=404,
            detail=f"No Sentinel-1 ({orbit}) VV/IW scenes in the post-event window "
                   f"{post_start} … {post_end}. Widen the range or change the orbit pass."
        )

    # 2. Pick the scene closest to the event in each window: the event sits between
    #    the two windows, so that is the LATEST pre-event scene and the EARLIEST
    #    post-event scene (an explicit event_date, if supplied, overrides this).
    if req.event_date:
        ev = _parse_day(req.event_date)
        pre_date, pre_item = min(pre, key=lambda t: abs((_parse_day(t[0]) - ev).days))
        post_date, post_item = min(post, key=lambda t: abs((_parse_day(t[0]) - ev).days))
    else:
        pre_date, pre_item = max(pre, key=lambda t: t[0])    # latest pre-event scene
        post_date, post_item = min(post, key=lambda t: t[0])  # earliest post-event scene

    # 3. Warp both VV scenes onto the fixed bbox grid (dB), despeckle, and difference.
    transform, shape = compute_flood_grid(req.bbox)
    H, W = shape
    try:
        before = despeckle_db(load_grd_vv_db(pre_item, req.bbox, shape))
        after = despeckle_db(load_grd_vv_db(post_item, req.bbox, shape))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read Sentinel-1 backscatter: {str(e)}")

    flood = before - after                       # positive = darker/wetter = candidate water
    valid = np.isfinite(before) & np.isfinite(after)

    # Restrict to an uploaded/drawn ROI polygon if provided.
    if req.geometry:
        from rasterio.features import geometry_mask
        geoms = extract_geojson_geometries(req.geometry)
        if geoms:
            gmask = geometry_mask(geoms, out_shape=shape, transform=transform, invert=False)
            valid &= ~gmask

    # Normalize the global radiometric offset: most of the ROI is stable land, so the
    # median difference is the scene-to-scene calibration bias. Subtracting it centers
    # the background at 0 dB, so the threshold flags genuine local darkening (water).
    offset = float(np.nanmedian(flood[valid])) if valid.any() else 0.0
    flood = flood - offset

    mask = (flood > threshold) & valid
    mask = remove_small_blobs(mask, min_size=10)  # drop residual speckle blobs

    # 4. Area / coverage stats.
    lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
    m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
    m_per_deg_lat = 110540
    pixel_w_m = ((req.bbox[2] - req.bbox[0]) / W) * m_per_deg_lon
    pixel_h_m = ((req.bbox[3] - req.bbox[1]) / H) * m_per_deg_lat
    pixel_area_m2 = pixel_w_m * pixel_h_m

    flood_pixels = int(mask.sum())
    valid_pixels = int(valid.sum())
    area_km2 = flood_pixels * pixel_area_m2 / 1e6
    pct = (100.0 * flood_pixels / valid_pixels) if valid_pixels else 0.0

    before_med = float(np.nanmedian(before)) if np.isfinite(before).any() else None
    after_med = float(np.nanmedian(after)) if np.isfinite(after).any() else None
    flood_max = float(np.nanmax(np.where(valid, flood, np.nan))) if valid_pixels else None

    # 5. Save outputs: before/after VV grayscale scenes (for the time slider), the
    #    candidate-flood mask (red map overlay), a dB-drop heatmap clipped to those
    #    pixels, and the full difference as a GeoTIFF for export.
    req_id = str(uuid.uuid4())
    before_png = f"{req_id}_flood_before.png"
    after_png = f"{req_id}_flood_after.png"
    mask_png = f"{req_id}_flood_mask.png"
    diff_png = f"{req_id}_flood_diff.png"
    tiff_file = f"{req_id}_flood.tif"
    before_path = os.path.join(STATIC_DIR, before_png)
    after_path = os.path.join(STATIC_DIR, after_png)
    mask_path = os.path.join(STATIC_DIR, mask_png)
    diff_path = os.path.join(STATIC_DIR, diff_png)
    tiff_path = os.path.join(STATIC_DIR, tiff_file)

    # Common grayscale stretch across both scenes so before/after are comparable.
    grey = get_color_palette("Greyscale")
    both = np.concatenate([before[valid], after[valid]]) if valid_pixels else np.array([0.0, 1.0])
    vis_lo, vis_hi = (float(np.nanpercentile(both, 2)), float(np.nanpercentile(both, 98))) if both.size else (0.0, 1.0)
    if vis_hi <= vis_lo:
        vis_hi = vis_lo + 1.0
    save_visual_png(before, vis_lo, vis_hi, grey, before_path)
    save_visual_png(after, vis_lo, vis_hi, grey, after_path)

    save_mask_png(mask, mask_path)

    diff_vis = np.where(mask, flood, np.nan)
    diff_vmax = max(6.0, float(np.nanmax(diff_vis))) if flood_pixels else 6.0
    save_visual_png(diff_vis, 0.0, diff_vmax, get_color_palette("Ocean (Water Depth)"), diff_path)

    save_geotiff(np.where(valid, flood, np.nan).astype(np.float32), transform, "EPSG:4326", tiff_path)

    return {
        "req_id": req_id,
        "image_url": f"/api/static/{mask_png}",
        "before_url": f"/api/static/{before_png}",
        "after_url": f"/api/static/{after_png}",
        "diff_url": f"/api/static/{diff_png}",
        "geotiff_url": f"/api/static/{tiff_file}",
        "bbox": req.bbox,
        "stats": {
            "area_km2": round(area_km2, 3),
            "percentage": round(pct, 2),
            "flood_pixels": flood_pixels,
            "valid_pixels": valid_pixels,
            "before_median_db": round(before_med, 2) if before_med is not None else None,
            "after_median_db": round(after_med, 2) if after_med is not None else None,
            "flood_max_db": round(flood_max, 2) if flood_max is not None else None,
            "threshold_db": threshold,
            "calibration_offset_db": round(offset, 2),
        },
        "vis_min": round(vis_lo, 2),
        "vis_max": round(vis_hi, 2),
        "pre_date": pre_date,
        "post_date": post_date,
        "pre_scene_id": pre_item.id,
        "post_scene_id": post_item.id,
        "pre_count": len(pre),
        "post_count": len(post),
        "event_date": req.event_date,
        "orbit": orbit,
    }


# ============================================================
# Evapotranspiration (SEBAL) — Landsat-9 + ERA5-Land (CDS)
# ============================================================
def _is_thermal_landsat(item):
    """True for Landsat 8/9 scenes — both carry the thermal band (ST_B10) SEBAL
    needs. Sentinel-2 has no thermal band and is not usable for SEBAL."""
    ident = item.id.lower()
    plat = str(item.properties.get("platform", "")).lower()
    return ("landsat-8" in ident or "landsat-9" in ident
            or plat in ("landsat-8", "landsat-9"))


def _landsat_overpass_hour_utc(item):
    """Rounded UTC acquisition hour from the STAC item, clamped to >=1.

    sebal._cds_retrieve reads the [hour-1, hour] accumulation pair, so hour 0
    would request '-01:00'. Clamp to 1 (Landsat descending passes are mid-morning
    local, so the UTC hour is almost always well away from midnight anyway).
    """
    ts = item.properties.get("datetime", "")
    try:
        t = ts.replace("Z", "+00:00")
        dt = __import__("datetime").datetime.fromisoformat(t)
        return max(1, int(round(dt.hour + dt.minute / 60.0)))
    except Exception:
        return 5


def _map_cds_error(e):
    """Translate a Copernicus CDS / ERA5-Land failure into an actionable HTTP error."""
    msg = str(e).lower()
    if "cdsapirc" in msg or "no url" in msg or ("url" in msg and "key" in msg) \
            or "missing/incomplete configuration" in msg:
        return HTTPException(
            status_code=400,
            detail="Copernicus CDS credentials not found. Add your personal access "
                   "token to a ~/.cdsapirc file (url + key) to fetch ERA5-Land data.")
    if "401" in msg or "403" in msg or "not authorized" in msg or "forbidden" in msg \
            or "licence" in msg or "license" in msg:
        return HTTPException(
            status_code=400,
            detail="Copernicus CDS rejected the request — verify the API key and that "
                   "the ERA5-Land licence is accepted in your CDS account.")
    if "timeout" in msg or "timed out" in msg or "queue" in msg:
        return HTTPException(
            status_code=504,
            detail="ERA5-Land retrieval timed out in the Copernicus CDS queue. "
                   "Please try again shortly.")
    return HTTPException(status_code=502, detail=f"ERA5-Land (CDS) retrieval failed: {e}")


def _expand_bbox_for_anchors(bbox, min_half_deg=0.06):
    """Grow a small ROI to a minimum window so SEBAL has scene context.

    SEBAL's hot/cold anchors are scene-scale features — a tiny drawn ROI may
    contain neither. We calibrate the anchors over this expanded window (~13 km
    when the ROI is smaller) and later crop the ET back to the requested extent,
    so even very small areas can be analysed. Returns the (possibly unchanged)
    compute bbox centred on the ROI.
    """
    minx, miny, maxx, maxy = bbox
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    hx = max((maxx - minx) / 2.0, min_half_deg)
    hy = max((maxy - miny) / 2.0, min_half_deg)
    return [cx - hx, cy - hy, cx + hx, cy + hy]


def _crop_to_bbox(arr, transform, target_bbox):
    """Crop a raster (numpy array + affine transform) to target_bbox.

    Used to return ET over the requested ROI after computing anchors on a larger
    window. Returns (cropped_array, cropped_transform, actual_cropped_bbox).
    """
    import rasterio
    from rasterio.windows import Window, transform as win_transform

    minx, miny, maxx, maxy = target_bbox
    H, W = arr.shape
    inv = ~transform
    c0, r0 = inv * (minx, maxy)   # top-left corner
    c1, r1 = inv * (maxx, miny)   # bottom-right corner
    col0 = max(0, int(np.floor(min(c0, c1))))
    col1 = min(W, int(np.ceil(max(c0, c1))))
    row0 = max(0, int(np.floor(min(r0, r1))))
    row1 = min(H, int(np.ceil(max(r0, r1))))
    col1 = max(col1, col0 + 1)    # always keep at least one pixel
    row1 = max(row1, row0 + 1)
    if col0 >= W or row0 >= H:     # ROI outside the computed grid — no crop
        return arr, transform, target_bbox

    win = Window(col0, row0, col1 - col0, row1 - row0)
    sub = arr[row0:row1, col0:col1]
    new_tf = win_transform(win, transform)
    px_w, px_h = transform.a, -transform.e
    new_minx, new_maxy = new_tf.c, new_tf.f
    new_maxx = new_minx + (col1 - col0) * px_w
    new_miny = new_maxy - (row1 - row0) * px_h
    return sub, new_tf, [new_minx, new_miny, new_maxx, new_maxy]


def _regrid_min_res(arr, transform, bbox, min_px=256, max_px=1500):
    """Resample a raster up to a minimum display resolution (aspect-preserving).

    A tiny ROI yields only a handful of native pixels, so the overlay looks blocky
    and a polygon clip applied at that resolution has ragged edges. Resampling the
    (unmasked) array to >= min_px on the short side — then masking at that finer
    grid — gives a smooth overlay with crisp ROI clipping. Returns (arr2, transform2);
    unchanged if the array is already large enough.
    """
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_bounds

    h, w = arr.shape
    if min(h, w) >= min_px:
        return arr, transform
    minx, miny, maxx, maxy = bbox
    aspect = (maxx - minx) / (maxy - miny) if (maxy - miny) else 1.0
    if aspect >= 1:
        new_h = min_px
        new_w = int(round(min_px * aspect))
    else:
        new_w = min_px
        new_h = int(round(min_px / aspect))
    new_w = max(min_px, min(new_w, max_px))
    new_h = max(min_px, min(new_h, max_px))
    dst_transform = from_bounds(minx, miny, maxx, maxy, new_w, new_h)
    dst = np.full((new_h, new_w), np.nan, dtype=np.float32)
    reproject(source=arr, destination=dst,
              src_transform=transform, src_crs="EPSG:4326",
              dst_transform=dst_transform, dst_crs="EPSG:4326",
              src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    return dst, dst_transform


def _et_pixel_area_m2(bbox, shape):
    """Approximate WGS84 pixel area [m^2] for the ET grid (as elsewhere in app.py)."""
    h, w = shape
    lat_center = (bbox[1] + bbox[3]) / 2.0
    m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
    m_per_deg_lat = 110540
    pixel_w_m = ((bbox[2] - bbox[0]) / w) * m_per_deg_lon
    pixel_h_m = ((bbox[3] - bbox[1]) / h) * m_per_deg_lat
    return pixel_w_m * pixel_h_m


def _et_density_bins(eta):
    """Agronomic ETa bands (mm/day) as integer percentages of valid pixels."""
    valid = eta[~np.isnan(eta) & ~np.isinf(eta)]
    if len(valid) == 0:
        return None
    total = len(valid)
    very_high = np.sum(valid > 6)
    high = np.sum((valid >= 4) & (valid <= 6))
    moderate = np.sum((valid >= 2) & (valid < 4))
    low = np.sum(valid < 2)
    return {
        "very_high": int(round(very_high / total * 100)),
        "high": int(round(high / total * 100)),
        "moderate": int(round(moderate / total * 100)),
        "low": int(round(low / total * 100)),
    }


@app.post("/api/et/single")
def calculate_et_single(req: EtRequest):
    """SEBAL actual evapotranspiration (mm/day) for one Landsat-9 scene."""
    clean_old_static_files()
    validate_bbox(req.bbox)

    # 1. Resolve the Landsat-9 scene.
    try:
        catalog = get_catalog()
        item = catalog.get_collection("landsat-c2-l2").get_item(req.item_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load scene: {e}")
    if not item:
        raise HTTPException(status_code=404, detail=f"Landsat scene {req.item_id} not found.")
    if not _is_thermal_landsat(item):
        raise HTTPException(
            status_code=400,
            detail="SEBAL evapotranspiration requires a Landsat-8 or Landsat-9 scene "
                   "(thermal band ST_B10). Sentinel-2 has no thermal band.")

    lon = (req.bbox[0] + req.bbox[2]) / 2.0
    lat = (req.bbox[1] + req.bbox[3]) / 2.0
    date_str = item.properties.get("datetime", "")[:10]
    hour = _landsat_overpass_hour_utc(item)
    cloud_cover = item.properties.get("eo:cloud_cover", None)

    # 2. Run the SEBAL pipeline over a window at least ~13 km wide so the hot/cold
    #    anchors have scene context (a tiny ROI alone rarely contains both); the ET
    #    is cropped back to the requested extent afterwards. Anchor failure -> 400;
    #    CDS failure -> mapped error.
    compute_bbox = _expand_bbox_for_anchors(req.bbox)
    try:
        result = sebal.run_sebal_single(item, compute_bbox, lon, lat, date_str, hour)
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        # The ERA5-Land (CDS) fetch is the most fragile step; classify anything
        # that looks CDS-related into an actionable message, else a generic 500.
        msg = str(e).lower()
        cds_hint = any(k in msg for k in (
            "cds", "cdsapi", "cdsapirc", "era5", "licence", "license",
            "not authorized", "forbidden", "queue", "timed out", "401", "403"))
        if cds_hint:
            raise _map_cds_error(e)
        raise HTTPException(status_code=500, detail=f"SEBAL computation failed: {e}")

    eta = result["eta"]
    transform = result["transform"]

    # 3. Crop the ET grid back to the requested ROI extent (native 30 m resolution;
    #    anchors were calibrated on the larger compute window above).
    out_bbox = req.bbox
    if compute_bbox != req.bbox:
        eta, transform, out_bbox = _crop_to_bbox(eta, transform, req.bbox)

    # A small ROI leaves only a few native pixels — resample up to a smooth display
    # grid so the overlay isn't blocky and the ROI polygon clip has crisp edges.
    # Stats and the GeoTIFF stay on the accurate native grid.
    eta_disp, transform_disp = _regrid_min_res(eta, transform, out_bbox, min_px=256)

    # Clip to a drawn/uploaded ROI polygon — mask the native grid (for stats/GeoTIFF)
    # and the display grid (for the PNG) each at their own resolution.
    if req.geometry:
        from rasterio.features import geometry_mask
        geoms = extract_geojson_geometries(req.geometry)
        if geoms:
            m_native = geometry_mask(geoms, out_shape=eta.shape, transform=transform, invert=False)
            eta = np.where(m_native, np.nan, eta)
            m_disp = geometry_mask(geoms, out_shape=eta_disp.shape, transform=transform_disp, invert=False)
            eta_disp = np.where(m_disp, np.nan, eta_disp)

    # 4. Stats, water volume, density bins.
    stats = calculate_roi_stats(eta)
    if np.isnan(stats.get("mean", np.nan)):
        raise HTTPException(
            status_code=400,
            detail="No valid evapotranspiration pixels in the ROI (all cloud/water "
                   "masked). Try a clearer scene or a different area.")

    pixel_area_m2 = _et_pixel_area_m2(out_bbox, eta.shape)
    valid_pixels = int(np.sum(~np.isnan(eta) & ~np.isinf(eta)))
    valid_area_m2 = valid_pixels * pixel_area_m2
    # mean ET (mm/day) over the valid area -> daily water volume (m^3/day).
    water_volume_m3 = stats["mean"] * 1e-3 * valid_area_m2

    density_bins = _et_density_bins(eta)

    vmin = req.vis_min if req.vis_min is not None else stats["p2"]
    vmax = req.vis_max if req.vis_max is not None else stats["p98"]
    if vmax <= vmin:
        vmax = vmin + 1.0

    # 5. Save PNG + GeoTIFF with the shared helpers.
    req_id = str(uuid.uuid4())
    png_filename = f"{req_id}_et.png"
    tiff_filename = f"{req_id}_et.tif"
    png_path = os.path.join(STATIC_DIR, png_filename)
    tiff_path = os.path.join(STATIC_DIR, tiff_filename)
    save_visual_png(eta_disp, vmin, vmax, get_color_palette(req.palette), png_path)  # smooth display grid
    save_geotiff(eta, transform, result["crs"], tiff_path)                            # native-res export

    anchors = result["anchors"]
    met = result["met"]
    et0 = result["et0"]

    return {
        "req_id": req_id,
        "image_url": f"/api/static/{png_filename}",
        "geotiff_url": f"/api/static/{tiff_filename}",
        "stats": {
            **stats,
            "valid_pixels": valid_pixels,
            "valid_area_km2": round(valid_area_m2 / 1e6, 3),
            "water_volume_m3_day": round(water_volume_m3, 1),
        },
        "vis_min": round(float(vmin), 3),
        "vis_max": round(float(vmax), 3),
        "density_bins": density_bins,
        "date": date_str,
        "scene_id": item.id,
        "bbox": out_bbox,
        "cloud_cover": float(cloud_cover) if cloud_cover is not None else None,
        "overpass_hour_utc": hour,
        "anchors": {
            "T_cold_C": round(anchors["T_cold"] - 273.15, 2),
            "T_hot_C": round(anchors["T_hot"] - 273.15, 2),
            "iterations": int(anchors["n_iter"]),
            "cold_method": anchors.get("cold_method", "strict"),
            "hot_method": anchors.get("hot_method", "strict"),
        },
        "met": {
            "T_air_C": round(met["T_air_C"], 1),
            "RH_pct": round(met["RH_pct"], 0),
            "wind_speed": round(met["wind_speed"], 2),
            "Rs_down": round(met["Rs_down"], 0),
            "Rl_down": round(met["Rl_down"], 0),
        },
        "et0": round(et0["ET0"], 2) if et0 else None,
        "kc": round(result["kc"], 2) if result.get("kc") is not None else None,
    }


@app.post("/api/et/time-series")
def calculate_et_time_series(req: EtTimeSeriesRequest):
    """SEBAL ETa trend over Landsat-9 scenes (one CDS fetch per date — capped)."""
    clean_old_static_files()
    validate_bbox(req.bbox)

    date_range = f"{req.start_date}/{req.end_date}"
    try:
        results, items = search_stac(
            collection="landsat-c2-l2",
            bbox=req.bbox,
            date_range=date_range,
            cloud_cover=None,          # no filter — surface cloud % per scene instead
            orbit="BOTH",
            limit=100,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STAC search error: {str(e)}")

    # Landsat-9 only (thermal band required for SEBAL).
    item_map = {it.id: it for it in items if _is_thermal_landsat(it)}
    results = [r for r in results if r["id"] in item_map]
    if not results:
        return {"timeseries": [], "index": "ETa (SEBAL)",
                "platform": "Landsat 9 (Optical)", "skipped": []}

    # Chronological, then subsample evenly to the (hard-capped) scene budget.
    results.sort(key=lambda x: x["date"])
    max_s = min(req.max_scenes or 6, 8)
    if len(results) > max_s:
        idx = np.linspace(0, len(results) - 1, max_s, dtype=int)
        results = [results[i] for i in idx]

    lon = (req.bbox[0] + req.bbox[2]) / 2.0
    lat = (req.bbox[1] + req.bbox[3]) / 2.0
    # Calibrate anchors on a >=~13 km window (small ROIs lack scene contrast),
    # then crop each ETa back to the ROI for the per-scene statistics.
    compute_bbox = _expand_bbox_for_anchors(req.bbox)

    timeseries, skipped = [], []
    for scene in results:
        scene_id = scene["id"]
        date_str = scene["date"]
        cc = scene["cloud_cover"]
        item = item_map[scene_id]
        try:
            hour = _landsat_overpass_hour_utc(item)
            # ET0 not needed per-point; skip it to save one CDS fetch per scene.
            res = sebal.run_sebal_single(item, compute_bbox, lon, lat, date_str, hour,
                                         with_et0=False)
            eta = res["eta"]
            tf = res["transform"]
            if compute_bbox != req.bbox:
                eta, tf, _ = _crop_to_bbox(eta, tf, req.bbox)
            if req.geometry:
                from rasterio.features import geometry_mask
                geoms = extract_geojson_geometries(req.geometry)
                if geoms:
                    m = geometry_mask(geoms, out_shape=eta.shape,
                                      transform=tf, invert=False)
                    eta = np.where(m, np.nan, eta)
            stats = calculate_roi_stats(eta)
            if np.isnan(stats.get("mean", np.nan)):
                skipped.append({"date": date_str, "reason": "no valid ET pixels"})
                continue
            timeseries.append({
                "date": date_str,
                "scene_id": scene_id,
                "mean": float(stats["mean"]),
                "min": float(stats["min"]),
                "max": float(stats["max"]),
                "std": float(stats["std"]),
                "cloud_cover": float(cc) if cc is not None else 0.0,
            })
        except Exception as e:
            # One scene's CDS/anchor failure must not abort the whole series.
            print(f"[et-timeseries] skipping {scene_id}: {e}")
            skipped.append({"date": date_str, "reason": str(e)[:200]})
            continue

    return {
        "timeseries": timeseries,
        "index": "ETa (SEBAL)",
        "platform": "Landsat 9 (Optical)",
        "skipped": skipped,
    }


@app.post("/api/aef/cluster")
def cluster_aef_embeddings(req: AefClusterRequest):
    clean_old_static_files()
    validate_bbox(req.bbox)

    # 1. Resolve index path. Cached in the workspace root (not STATIC_DIR) so
    # clean_old_static_files()'s 30-min sweep never deletes it and forces a
    # re-download from data.source.coop on the next request.
    index_path = os.path.join(os.path.dirname(BASE_DIR), "aef_index.parquet")
    if not os.path.exists(index_path):
        import requests
        print("Downloading aef_index.parquet...")
        url = "https://data.source.coop/tge-labs/aef/v1/annual/aef_index.parquet"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        try:
            res = requests.get(url, headers=headers, timeout=60)
            if res.status_code == 200:
                with open(index_path, "wb") as f:
                    f.write(res.content)
            else:
                raise HTTPException(status_code=500, detail=f"Failed to download AEF index: HTTP {res.status_code}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to retrieve AEF index: {str(e)}")

    # 2. Read parquet index
    import pandas as pd
    try:
        df = pd.read_parquet(index_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load AEF index: {str(e)}")

    # 3. Query overlapping tiles
    df_year = df[df["year"] == req.year]
    min_lon, min_lat, max_lon, max_lat = req.bbox
    
    overlapping = df_year[
        (df_year["wgs84_west"] <= max_lon) &
        (df_year["wgs84_east"] >= min_lon) &
        (df_year["wgs84_south"] <= max_lat) &
        (df_year["wgs84_north"] >= min_lat)
    ]
    
    if len(overlapping) == 0:
        raise HTTPException(
            status_code=404,
            detail=f"No AlphaEarth satellite embedding tiles found for year {req.year} in the selected area."
        )

    # 4. Define target grid in EPSG:4326
    import rasterio
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_origin
    
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = 10 * deg_per_meter  # 10m
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    # Cap size to avoid OOM and long network transfer times
    width = max(10, min(width, 150))
    height = max(10, min(height, 150))

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"

    # Prepare array to hold the 64 embedding bands
    bands_data = np.full((64, height, width), np.nan, dtype=np.float32)

    try:
        for _, row in overlapping.iterrows():
            s3_path = row["path"]
            http_path = s3_path.replace("s3://us-west-2.opendata.source.coop", "https://data.source.coop")
            vsi_path = f"/vsicurl/{http_path}"
            
            from rasterio.windows import Window
            from rasterio.transform import Affine

            # Open once for metadata + window geometry (cheap), then read the 64
            # bands in parallel handles (the slow part) via read_window_bands_parallel.
            with rasterio.Env(**GDAL_OPTS), rasterio.open(vsi_path) as src:
                src_crs = src.crs
                src_transform = src.transform
                src_nodata = src.nodata
                src_bbox = transform_bounds("EPSG:4326", src_crs, min_lon, min_lat, max_lon, max_lat)
                left, bottom, right, top = src_bbox

                row1, col1 = src.index(left, top)
                row2, col2 = src.index(right, bottom)

                row_start = max(0, min(row1, row2, src.height))
                row_end = max(0, min(max(row1, row2), src.height))
                col_start = max(0, min(col1, col2, src.width))
                col_end = max(0, min(max(col1, col2), src.width))

            if row_end > row_start and col_end > col_start:
                window = Window(col_start, row_start, col_end - col_start, row_end - row_start)

                # Decimated parallel read of all 64 bands to target shape
                src_data = read_window_bands_parallel(vsi_path, window, height, width, n_bands=64)
                window_transform = rasterio.windows.transform(window, src_transform)
                scale_x = window.width / width
                scale_y = window.height / height
                decimated_transform = window_transform * Affine.scale(scale_x, scale_y)

                for b in range(1, 65):
                    temp_dest = np.zeros(target_shape, dtype=np.float32)
                    reproject(
                        source=src_data[b-1],
                        destination=temp_dest,
                        src_transform=decimated_transform,
                        src_crs=src_crs,
                        dst_transform=target_transform,
                        dst_crs=target_crs,
                        resampling=Resampling.bilinear,
                        src_nodata=src_nodata,
                        dst_nodata=np.nan
                    )
                    mask = ~np.isnan(temp_dest)
                    bands_data[b-1, mask] = temp_dest[mask]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read satellite embeddings: {str(e)}")

    # Apply geometry mask if provided
    if req.geometry:
        from rasterio.features import geometry_mask
        geoms = extract_geojson_geometries(req.geometry)
        if geoms:
            mask = geometry_mask(geoms, out_shape=target_shape, transform=target_transform, invert=False)
            for b in range(64):
                bands_data[b, mask] = np.nan

    # 5. Unsupervised clustering
    valid_mask = ~np.isnan(bands_data).any(axis=0)
    valid_mask_flat = valid_mask.flatten()
    valid_pixels = bands_data.reshape(64, -1).T[valid_mask_flat]

    if len(valid_pixels) == 0:
        raise HTTPException(
            status_code=400,
            detail="The selected ROI contains no valid satellite embedding data. Try adjusting the bounding box."
        )

    # KMeans requires n_samples >= n_clusters; clamp so tiny ROIs don't crash.
    effective_clusters = max(1, min(req.num_clusters, len(valid_pixels)))

    # Perform KMeans
    from sklearn.cluster import KMeans
    try:
        kmeans = KMeans(n_clusters=effective_clusters, random_state=42, n_init=10)
        cluster_labels = kmeans.fit_predict(valid_pixels)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Clustering algorithm failure: {str(e)}")

    # Sort labels descending by pixel count
    unique_labels, counts = np.unique(cluster_labels, return_counts=True)
    sorted_indices = np.argsort(-counts)
    sorted_labels = unique_labels[sorted_indices]
    label_map = {old: new + 1 for new, old in enumerate(sorted_labels)}
    sorted_cluster_labels = np.array([label_map[l] for l in cluster_labels])

    # Reconstruct 2D classification map (0 is transparent background)
    class_map = np.zeros(height * width, dtype=np.uint8)
    class_map[valid_mask_flat] = sorted_cluster_labels
    class_map = class_map.reshape(height, width)

    # Define color scheme (10 distinct vibrant/harmonious colors)
    CLUSTER_COLORS = [
        "#3b82f6",  # Blue
        "#10b981",  # Green
        "#ef4444",  # Red
        "#f59e0b",  # Amber/Yellow
        "#8b5cf6",  # Purple
        "#ec4899",  # Pink
        "#14b8a6",  # Teal
        "#f97316",  # Orange
        "#6366f1",  # Indigo
        "#84cc16"   # Lime
    ]

    legend = {}
    for i in range(effective_clusters):
        class_val = i + 1
        color = CLUSTER_COLORS[i % len(CLUSTER_COLORS)]
        legend[class_val] = {
            "name": f"Cluster {class_val}",
            "color": color
        }

    # 6. Save outputs
    req_id = str(uuid.uuid4())
    png_filename = f"{req_id}_aef_cluster.png"
    tiff_filename = f"{req_id}_aef_cluster.tif"
    
    png_path = os.path.join(STATIC_DIR, png_filename)
    tiff_path = os.path.join(STATIC_DIR, tiff_filename)

    colorize_lulc_png(class_map, legend, png_path)
    save_geotiff(class_map.astype(np.float32), target_transform, target_crs, tiff_path)

    # Calculate statistics
    lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
    m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
    m_per_deg_lat = 110540
    pixel_w_m = ((req.bbox[2] - req.bbox[0]) / width) * m_per_deg_lon
    pixel_h_m = ((req.bbox[3] - req.bbox[1]) / height) * m_per_deg_lat
    pixel_area_m2 = pixel_w_m * pixel_h_m

    stats = compute_lulc_stats(class_map, legend, pixel_area_m2)

    # Build legend info for frontend
    legend_info = {}
    for class_val, info in legend.items():
        legend_info[str(class_val)] = {
            "name": info["name"],
            "color": info["color"]
        }

    return {
        "req_id": req_id,
        "image_url": f"/api/static/{png_filename}",
        "geotiff_url": f"/api/static/{tiff_filename}",
        "stats": stats,
        "legend": legend_info,
        "bbox": req.bbox,
        "year": req.year,
        "num_clusters": effective_clusters
    }

def sample_native_query_reference(overlapping, q_geoms):
    """
    Sample the query reference embedding at NATIVE ~10 m resolution.

    The main ROI grid is decimated (capped at 150x150), so a small distinct
    feature such as a water body becomes only a few pixels and its edges are
    blended toward the surrounding land. Averaging those blended pixels into the
    reference corrupts it and can rank the feature BELOW the background. Google's
    tutorial samples references at scale=10, so we mirror that: read the source
    COGs at full resolution over just the query polygon, keep valid pixels inside
    it using NEAREST resampling (no blending), then unit-normalize and average.
    Returns a (64,) reference vector, or None if no valid pixels are found.
    """
    import rasterio
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_origin
    from rasterio.windows import Window
    from rasterio.features import geometry_mask

    # Bounds of the query geometry (recursively scan coordinate tuples).
    xs, ys = [], []
    def _walk(c):
        if isinstance(c, (list, tuple)):
            if len(c) >= 2 and isinstance(c[0], (int, float)) and isinstance(c[1], (int, float)):
                xs.append(c[0]); ys.append(c[1])
            else:
                for sub in c:
                    _walk(sub)
    for g in q_geoms:
        _walk(g.get("coordinates", []))
    if not xs:
        return None

    pad = 20.0 / 111000.0  # ~20 m padding around the polygon
    qminx, qminy = min(xs) - pad, min(ys) - pad
    qmaxx, qmaxy = max(xs) + pad, max(ys) + pad

    res = 10.0 / 111000.0
    qw = max(1, min(int(np.ceil((qmaxx - qminx) / res)), 256))
    qh = max(1, min(int(np.ceil((qmaxy - qminy) / res)), 256))
    qpw = (qmaxx - qminx) / qw
    qph = (qmaxy - qminy) / qh
    qtt = from_origin(qminx, qmaxy, qpw, qph)
    qshape = (qh, qw)

    qbands = np.full((64, qh, qw), np.nan, dtype=np.float32)
    for _, row in overlapping.iterrows():
        http_path = row["path"].replace("s3://us-west-2.opendata.source.coop", "https://data.source.coop")
        vsi_path = f"/vsicurl/{http_path}"
        try:
            with rasterio.Env(**GDAL_OPTS), rasterio.open(vsi_path) as src:
                left, bottom, right, top = transform_bounds("EPSG:4326", src.crs, qminx, qminy, qmaxx, qmaxy)
                r1, c1 = src.index(left, top)
                r2, c2 = src.index(right, bottom)
                row_start = max(0, min(r1, r2, src.height))
                row_end = max(0, min(max(r1, r2), src.height))
                col_start = max(0, min(c1, c2, src.width))
                col_end = max(0, min(max(c1, c2), src.width))
                if row_end <= row_start or col_end <= col_start:
                    continue
                window = Window(col_start, row_start, col_end - col_start, row_end - row_start)
                src_data = src.read(window=window, out_dtype=np.float32)  # native res, no decimation
                window_transform = rasterio.windows.transform(window, src.transform)
                for b in range(64):
                    temp = np.zeros(qshape, dtype=np.float32)
                    reproject(
                        source=src_data[b],
                        destination=temp,
                        src_transform=window_transform,
                        src_crs=src.crs,
                        dst_transform=qtt,
                        dst_crs="EPSG:4326",
                        resampling=Resampling.nearest,  # preserve pure embeddings
                        src_nodata=src.nodata,
                        dst_nodata=np.nan,
                    )
                    m = ~np.isnan(temp)
                    qbands[b, m] = temp[m]
        except Exception:
            continue

    qmask = geometry_mask(q_geoms, out_shape=qshape, transform=qtt, invert=True, all_touched=True)
    qmask = qmask & (~np.isnan(qbands).any(axis=0))
    qp = qbands[:, qmask].T
    if len(qp) == 0:
        return None
    # Return the raw-scale mean embedding so callers can either unit-normalize it
    # (dot-product mode) or subtract the ROI mean from it (centered mode).
    return qp.mean(axis=0)


@app.post("/api/aef/similarity")
def search_aef_similarity(req: AefSimilarityRequest):
    clean_old_static_files()
    validate_bbox(req.bbox)

    # 1. Resolve index path. Cached in the workspace root (not STATIC_DIR) so
    # clean_old_static_files()'s 30-min sweep never deletes it and forces a
    # re-download from data.source.coop on the next request.
    index_path = os.path.join(os.path.dirname(BASE_DIR), "aef_index.parquet")
    if not os.path.exists(index_path):
        import requests
        url = "https://data.source.coop/tge-labs/aef/v1/annual/aef_index.parquet"
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        try:
            res = requests.get(url, headers=headers, timeout=60)
            if res.status_code == 200:
                with open(index_path, "wb") as f:
                    f.write(res.content)
            else:
                raise HTTPException(status_code=500, detail=f"Failed to download AEF index: HTTP {res.status_code}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to retrieve AEF index: {str(e)}")

    # 2. Read parquet index
    import pandas as pd
    try:
        df = pd.read_parquet(index_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load AEF index: {str(e)}")

    # 3. Query overlapping tiles
    df_year = df[df["year"] == req.year]
    min_lon, min_lat, max_lon, max_lat = req.bbox
    
    overlapping = df_year[
        (df_year["wgs84_west"] <= max_lon) &
        (df_year["wgs84_east"] >= min_lon) &
        (df_year["wgs84_south"] <= max_lat) &
        (df_year["wgs84_north"] >= min_lat)
    ]
    
    if len(overlapping) == 0:
        raise HTTPException(
            status_code=404,
            detail=f"No AlphaEarth satellite embedding tiles found for year {req.year} in the selected area."
        )

    # 4. Define target grid in EPSG:4326 (capped at 150x150 for speed)
    import rasterio
    from rasterio.warp import transform_bounds, reproject, Resampling
    from rasterio.transform import from_origin
    
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = 10 * deg_per_meter  # 10m
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    width = max(10, min(width, 150))
    height = max(10, min(height, 150))

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"

    # Prepare array to hold the 64 embedding bands
    bands_data = np.full((64, height, width), np.nan, dtype=np.float32)

    try:
        for _, row in overlapping.iterrows():
            s3_path = row["path"]
            http_path = s3_path.replace("s3://us-west-2.opendata.source.coop", "https://data.source.coop")
            vsi_path = f"/vsicurl/{http_path}"
            
            from rasterio.windows import Window
            from rasterio.transform import Affine

            # Open once for metadata + window geometry, then read all 64 bands in
            # parallel handles (see read_window_bands_parallel) to avoid serial fetches.
            with rasterio.Env(**GDAL_OPTS), rasterio.open(vsi_path) as src:
                src_crs = src.crs
                src_transform = src.transform
                src_nodata = src.nodata
                src_bbox = transform_bounds("EPSG:4326", src_crs, min_lon, min_lat, max_lon, max_lat)
                left, bottom, right, top = src_bbox

                row1, col1 = src.index(left, top)
                row2, col2 = src.index(right, bottom)

                row_start = max(0, min(row1, row2, src.height))
                row_end = max(0, min(max(row1, row2), src.height))
                col_start = max(0, min(col1, col2, src.width))
                col_end = max(0, min(max(col1, col2), src.width))

            if row_end > row_start and col_end > col_start:
                window = Window(col_start, row_start, col_end - col_start, row_end - row_start)

                src_data = read_window_bands_parallel(vsi_path, window, height, width, n_bands=64)
                window_transform = rasterio.windows.transform(window, src_transform)
                scale_x = window.width / width
                scale_y = window.height / height
                decimated_transform = window_transform * Affine.scale(scale_x, scale_y)

                for b in range(1, 65):
                    temp_dest = np.zeros(target_shape, dtype=np.float32)
                    reproject(
                        source=src_data[b-1],
                        destination=temp_dest,
                        src_transform=decimated_transform,
                        src_crs=src_crs,
                        dst_transform=target_transform,
                        dst_crs=target_crs,
                        resampling=Resampling.bilinear,
                        src_nodata=src_nodata,
                        dst_nodata=np.nan
                    )
                    mask = ~np.isnan(temp_dest)
                    bands_data[b-1, mask] = temp_dest[mask]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read satellite embeddings: {str(e)}")

    # Extract valid mask for the ROI
    valid_mask = ~np.isnan(bands_data).any(axis=0)
    valid_mask_flat = valid_mask.flatten()

    # Apply custom ROI geometry mask if provided
    if req.geometry:
        from rasterio.features import geometry_mask
        geoms = extract_geojson_geometries(req.geometry)
        if geoms:
            mask = geometry_mask(geoms, out_shape=target_shape, transform=target_transform, invert=False)
            for b in range(64):
                bands_data[b, mask] = np.nan
            valid_mask = ~np.isnan(bands_data).any(axis=0)
            valid_mask_flat = valid_mask.flatten()

    # 5. Extract Query Feature reference vector
    from rasterio.features import geometry_mask
    ref_vector = None
    try:
        q_geoms = extract_geojson_geometries(req.query_geometry)
        if not q_geoms:
            raise ValueError("Could not parse query geometry - no valid geometries found")
        
        # Preferred: sample the reference at native ~10 m resolution so small,
        # distinct features (e.g. water bodies) are not blended with their
        # surroundings on the coarse ROI grid.
        ref_vector = sample_native_query_reference(overlapping, q_geoms)

        if ref_vector is None or np.isnan(ref_vector).any():
            # Fallback 1: average the query pixels on the coarse ROI grid.
            # all_touched=True so a small polygon still captures pixels.
            q_mask = geometry_mask(q_geoms, out_shape=target_shape, transform=target_transform, invert=True, all_touched=True)
            q_mask = q_mask & valid_mask

            query_pixels = bands_data[:, q_mask].T  # shape (N_query_pixels, 64)

            if len(query_pixels) > 0 and not np.isnan(query_pixels).all():
                # Raw-scale mean embedding of the query pixels (normalized or
                # ROI-centered later depending on the similarity mode).
                ref_vector = np.nanmean(query_pixels, axis=0)
            else:
                # Fallback 2: compute centroid and find the nearest valid pixel.
                try:
                    qg = req.query_geometry
                    if qg.get("type") == "Feature":
                        coords = qg["geometry"]["coordinates"][0]
                    elif qg.get("type") == "Polygon":
                        coords = qg["coordinates"][0]
                    else:
                        coords = qg.get("geometry", qg).get("coordinates", [[]])[0]

                    avg_lon = sum(pt[0] for pt in coords) / len(coords)
                    avg_lat = sum(pt[1] for pt in coords) / len(coords)
                except Exception:
                    # Ultimate fallback: use center of bbox
                    avg_lon = (req.bbox[0] + req.bbox[2]) / 2.0
                    avg_lat = (req.bbox[1] + req.bbox[3]) / 2.0

                col_f, row_f = ~target_transform * (avg_lon, avg_lat)
                center_col = int(np.clip(col_f, 0, width - 1))
                center_row = int(np.clip(row_f, 0, height - 1))

                # Try the centroid pixel first (raw-scale, single reference)
                candidate = bands_data[:, center_row, center_col]
                if not np.isnan(candidate).any():
                    ref_vector = candidate
                else:
                    # Scan expanding neighborhood for nearest valid pixel
                    for radius in range(1, max(height, width)):
                        found = False
                        for dr in range(-radius, radius + 1):
                            for dc in range(-radius, radius + 1):
                                r, c = center_row + dr, center_col + dc
                                if 0 <= r < height and 0 <= c < width:
                                    px = bands_data[:, r, c]
                                    if not np.isnan(px).any():
                                        ref_vector = px
                                        found = True
                                        break
                            if found:
                                break
                        if found:
                            break
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to extract query feature geometry: {str(e)}")

    if ref_vector is None or np.isnan(ref_vector).any():
        raise HTTPException(
            status_code=400,
            detail="The drawn query feature lies completely in a no-data region. Please draw your query polygon over an area with visible satellite data inside the Target ROI."
        )

    # 6. Compute similarity for every valid pixel.
    #
    # AlphaEarth embeddings are unit-length, so a dot product equals the cosine of
    # the angle between vectors. Two modes:
    #
    #  * "dotproduct" (Google's literal method): unit-normalize each pixel and dot
    #    it with the reference. Faithful to the Earth Engine tutorial
    #    (arrayImage.multiply(mosaic).reduce('sum')). Works well in diverse scenes,
    #    but in homogeneous ROIs the embeddings share a large common component, so
    #    the MOST distinctive features (e.g. water) can rank BELOW the background.
    #
    #  * "centered" (default): subtract the ROI-mean embedding from every pixel and
    #    from the reference before the cosine. This removes the shared component so
    #    distinct features are correctly ranked highest. Required for reliable
    #    feature search (water, built-up, etc.) over uniform terrain.
    valid_pixels = bands_data.reshape(64, -1).T[valid_mask_flat]

    if len(valid_pixels) == 0:
         raise HTTPException(status_code=400, detail="No active pixels inside the ROI.")

    mode = (req.mode or "centered").lower()

    if mode == "dotproduct":
        ref_unit = ref_vector / (np.linalg.norm(ref_vector) or 1e-6)
        pixel_norms = np.linalg.norm(valid_pixels, axis=1, keepdims=True)
        pixel_norms[pixel_norms == 0] = 1e-6
        similarities = (valid_pixels / pixel_norms) @ ref_unit
    else:
        mode = "centered"
        roi_mean = valid_pixels.mean(axis=0)
        ref_c = ref_vector - roi_mean
        ref_c = ref_c / (np.linalg.norm(ref_c) or 1e-6)
        centered = valid_pixels - roi_mean
        c_norms = np.linalg.norm(centered, axis=1, keepdims=True)
        c_norms[c_norms == 0] = 1e-6
        similarities = (centered / c_norms) @ ref_c

    # Reconstruct similarity map
    sim_map = np.full(height * width, np.nan, dtype=np.float32)
    sim_map[valid_mask_flat] = similarities
    sim_map = sim_map.reshape(height, width)

    # 7. Calculate Match Stats. Default threshold differs by mode: dot-product
    # similarities cluster high (~0.9), centered ones spread around 0.
    if req.threshold is not None:
        threshold = req.threshold
    else:
        threshold = 0.9 if mode == "dotproduct" else 0.5
    match_pixels = int(np.sum(sim_map[valid_mask] >= threshold))
    total_valid_pixels = int(np.sum(valid_mask))
    match_percentage = (match_pixels / total_valid_pixels) * 100.0 if total_valid_pixels > 0 else 0.0

    lat_center = (req.bbox[1] + req.bbox[3]) / 2.0
    m_per_deg_lon = 111320 * np.cos(np.radians(lat_center))
    m_per_deg_lat = 110540
    pixel_w_m = ((req.bbox[2] - req.bbox[0]) / width) * m_per_deg_lon
    pixel_h_m = ((req.bbox[3] - req.bbox[1]) / height) * m_per_deg_lat
    pixel_area_m2 = pixel_w_m * pixel_h_m
    
    match_area_ha = (match_pixels * pixel_area_m2) / 10000.0

    stats = calculate_roi_stats(sim_map)
    stats["match_pixels"] = match_pixels
    stats["match_percentage"] = round(match_percentage, 2)
    stats["match_area_ha"] = round(match_area_ha, 2)
    stats["threshold"] = threshold

    # 8. Save outputs
    req_id = str(uuid.uuid4())
    png_filename = f"{req_id}_aef_similarity.png"
    tiff_filename = f"{req_id}_aef_similarity.tif"
    
    png_path = os.path.join(STATIC_DIR, png_filename)
    tiff_path = os.path.join(STATIC_DIR, tiff_filename)

    palette_colors = get_color_palette(req.palette or "Magma (Sequential)")

    # Render the FULL continuous similarity as a heatmap (brighter = more similar).
    #  * dotproduct: fixed [0, 1] range, faithful to Google's {min:0, max:1}.
    #  * centered: similarities spread around 0, so stretch to the data's own
    #    [p2, p98] range for visible contrast (distinct features stand out).
    if mode == "dotproduct":
        vmin, vmax = 0.0, 1.0
    else:
        vmin = float(stats.get("p2", 0.0))
        vmax = float(stats.get("p98", 1.0))
        if vmax <= vmin:
            vmax = vmin + 0.1

    save_visual_png(sim_map, vmin, vmax, palette_colors, png_path)
    save_geotiff(sim_map, target_transform, target_crs, tiff_path)

    return {
        "req_id": req_id,
        "image_url": f"/api/static/{png_filename}",
        "geotiff_url": f"/api/static/{tiff_filename}",
        "stats": stats,
        "bbox": req.bbox,
        "year": req.year,
        "threshold": threshold,
        "mode": mode,
        "vis_min": vmin,
        "vis_max": vmax
    }

# --- LSM INTEGRATION ENDPOINTS ---
LSM_PROBABILITY_TIF = os.environ.get('LSM_PROBABILITY_TIF', 'S:\\LSM\\probability.tif')
LSM_CLASS_TIF = os.environ.get('LSM_CLASS_TIF', 'S:\\LSM\\class_small.tif')
# In production, districts_geo is copied to public, which is relative to frontend/public.
DISTRICTS_GEO_DIR = os.path.join(os.path.dirname(BASE_DIR), 'frontend', 'public', 'districts_geo')

lsm_dataset = None
if os.path.exists(LSM_PROBABILITY_TIF):
    try:
        import rasterio
        lsm_dataset = rasterio.open(LSM_PROBABILITY_TIF)
        print("Opened LSM probability raster successfully.")
    except Exception as e:
        print(f"Error opening LSM probability raster: {e}")

lsm_class_dataset = None
if os.path.exists(LSM_CLASS_TIF):
    try:
        import rasterio
        lsm_class_dataset = rasterio.open(LSM_CLASS_TIF)
        print("Opened LSM class raster successfully.")
    except Exception as e:
        print(f"Error opening LSM class raster: {e}")

def sanitize_lsm_filename(name: str) -> str:
    return re.sub(r'[^a-zA-Z0-9]', '_', str(name))

@app.get("/api/probability")
def get_lsm_probability(lat: float = Query(...), lon: float = Query(...)):
    if lsm_dataset is None:
        raise HTTPException(status_code=500, detail="LSM Probability raster not loaded. Make sure probability.tif is present.")

    try:
        val = list(lsm_dataset.sample([(lon, lat)]))[0][0]
        if np.isnan(val):
            val = None
        else:
            val = float(val)

        return {
            "lat": lat,
            "lon": lon,
            "probability": val
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/point-query")
def point_query(filename: str = Query(...), lat: float = Query(...), lon: float = Query(...)):
    """
    Generic "value at point" lookup against a GeoTIFF this session already
    generated (a `geotiff_url` returned by one of the /api/*/calculate
    endpoints). Used for the map's double-click query feature.
    """
    safe_name = os.path.basename(filename)
    if not safe_name.lower().endswith(".tif"):
        raise HTTPException(status_code=400, detail="Only .tif rasters can be queried")

    tiff_path = os.path.abspath(os.path.join(STATIC_DIR, safe_name))
    if os.path.commonpath([tiff_path, STATIC_DIR]) != STATIC_DIR or not os.path.exists(tiff_path):
        raise HTTPException(status_code=404, detail="Raster not found (it may have expired — rerun the tool)")

    try:
        value = sample_geotiff_value(tiff_path, lat, lon)
        return {"lat": lat, "lon": lon, "value": value}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/district-stats")
def get_lsm_district_stats(state: str = Query(...), district: str = Query(...)):
    if lsm_class_dataset is None:
        raise HTTPException(status_code=500, detail="LSM Class raster not loaded. Make sure class_small.tif is present.")

    filename = f"{sanitize_lsm_filename(state)}_{sanitize_lsm_filename(district)}.json"
    filepath = os.path.join(DISTRICTS_GEO_DIR, filename)

    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail=f"Geometry not found for district: {district}, state: {state}")

    try:
        import json
        import rasterio.mask
        with open(filepath, 'r', encoding='utf-8') as f:
            geo_data = json.load(f)

        geom = geo_data['features'][0]['geometry']
        
        out_image, out_transform = rasterio.mask.mask(lsm_class_dataset, [geom], crop=True)
        
        flat = out_image.flatten()
        flat = flat[~np.isnan(flat)]
        
        total_in_district = len(flat)
        valid_pixels = flat[flat != 0.0]
        total_valid = len(valid_pixels)
        
        analyzed_percentage = (total_valid / total_in_district * 100) if total_in_district > 0 else 0.0
        
        vals, counts = np.unique(valid_pixels, return_counts=True)
        counts_dict = dict(zip([int(v) for v in vals], [int(c) for c in counts]))
        
        stats = {}
        for c in range(1, 6):
            count = counts_dict.get(c, 0)
            percentage = (count / total_valid * 100) if total_valid > 0 else 0.0
            stats[str(c)] = round(percentage, 1)

        return {
            "state": state,
            "district": district,
            "total_pixels": total_in_district,
            "valid_pixels": total_valid,
            "analyzed_percentage": round(analyzed_percentage, 1),
            "stats": stats
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Highway-wise LSM analysis (live fallback; precomputed JSON is primary) ---
# The full-resolution class raster (~111 m/px) is needed for meaningful
# highway-corridor stats; class_small.tif (~3.2 km/px) is only a last resort.
LSM_CLASS_FULL_TIF = os.environ.get('LSM_CLASS_FULL_TIF', 'S:\\LSM\\class.tif')

# Analysis must run on the full-resolution NH dataset only — never on a
# simplified/downscaled copy (it understates lengths on winding mountain roads).
HIGHWAYS_GEOJSON_PATH = os.environ.get(
    'HIGHWAYS_GEOJSON',
    os.path.join(os.path.dirname(BASE_DIR), 'INDIA_NATIONAL_HIGHWAY.geojson')
)

lsm_class_full_dataset = None
if os.path.exists(LSM_CLASS_FULL_TIF):
    try:
        import rasterio
        lsm_class_full_dataset = rasterio.open(LSM_CLASS_FULL_TIF)
        print("Opened LSM full-resolution class raster successfully.")
    except Exception as e:
        print(f"Error opening LSM full-resolution class raster: {e}")

_highway_features_cache = None

def _get_highway_features():
    global _highway_features_cache
    if _highway_features_cache is None:
        from backend import highway_lsm
        _highway_features_cache = highway_lsm.load_highway_features(HIGHWAYS_GEOJSON_PATH)
    return _highway_features_cache

@app.get("/api/highway-stats")
def get_lsm_highway_stats(name: str = Query(...), buffer: int = Query(500)):
    from backend import highway_lsm

    class_ds = lsm_class_full_dataset if lsm_class_full_dataset is not None else lsm_class_dataset
    if class_ds is None:
        raise HTTPException(status_code=500, detail="LSM class raster not loaded. Make sure class.tif is present.")

    try:
        features = _get_highway_features()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load highways.geojson: {e}")

    feature = features.get(name)
    if feature is None:
        raise HTTPException(status_code=404, detail=f"Highway not found: {name}")

    if buffer not in highway_lsm.BUFFERS_M:
        buffer = 500

    try:
        return highway_lsm.analyze_highway(feature, class_ds, lsm_dataset, buffers_m=(buffer,))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/static/{filename}")
def serve_static(filename: str):
    file_path = os.path.abspath(os.path.join(STATIC_DIR, filename))
    if os.path.commonpath([file_path, STATIC_DIR]) != STATIC_DIR:
        raise HTTPException(status_code=404, detail="File not found")
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")

