import os
import re
import ast
import operator as _op
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pystac_client
import planetary_computer
import rasterio
from rasterio.warp import transform_bounds, reproject, Resampling
from rasterio.transform import from_origin
from PIL import Image


# --- GDAL / vsicurl tuning -------------------------------------------------
# IMPORTANT: rasterio does NOT honour these from os.environ — they must be
# applied via an explicit `with rasterio.Env(**GDAL_OPTS):` around the read.
# Measured on an AlphaEarth 64-band COG: a windowed 64-band read takes ~200s
# with the defaults but ~8s inside rasterio.Env, because NUM_THREADS reads the
# bands in parallel instead of one serial HTTP round-trip per band.
#   - NUM_THREADS=ALL_CPUS: parallel band/block reads — the single biggest win
#   - DISABLE_READDIR_ON_OPEN: skip the directory listing GDAL issues on open
#   - GDAL_HTTP_TIMEOUT / MAX_RETRY: fail fast instead of hanging forever
#   - VSI_CACHE + multirange: coalesce range requests and reuse fetched blocks
GDAL_OPTS = {
    "GDAL_NUM_THREADS": "ALL_CPUS",
    "GDAL_HTTP_VERSION": "2",
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff",
    "GDAL_HTTP_TIMEOUT": "30",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "VSI_CACHE": True,
    "VSI_CACHE_SIZE": 100000000,  # 100 MB
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
}


def read_window_bands_parallel(vsi_path, window, out_h, out_w, n_bands=64, groups=8):
    """Decimated read of all `n_bands` of a windowed remote COG, in parallel.

    A single rasterio dataset handle is NOT thread-safe, so the bands are split
    across `groups` worker threads that each open their OWN handle. This overlaps
    the per-band HTTP fetches: measured on an AlphaEarth 64-band tile this cuts a
    cold read from ~88s (serial) to ~40s. More than ~8 groups makes the open-data
    host throttle and gets slower, so the group count is kept modest.

    Returns a (n_bands, out_h, out_w) float32 array (band order preserved).
    """
    band_ids = list(range(1, n_bands + 1))
    chunks = [c for c in (band_ids[i::groups] for i in range(groups)) if c]
    results = {}

    def _read_group(bands):
        with rasterio.Env(**GDAL_OPTS), rasterio.open(vsi_path) as s:
            arr = s.read(bands, out_shape=(len(bands), out_h, out_w),
                         window=window, out_dtype=np.float32)
        return list(zip(bands, arr))

    with ThreadPoolExecutor(max_workers=len(chunks)) as ex:
        for part in ex.map(_read_group, chunks):
            for b, a in part:
                results[b] = a
    return np.stack([results[b] for b in band_ids])


# --- Safe formula evaluation ----------------------------------------------
_ALLOWED_BINOPS = {
    ast.Add: _op.add, ast.Sub: _op.sub, ast.Mult: _op.mul,
    ast.Div: _op.truediv, ast.Pow: _op.pow, ast.Mod: _op.mod,
}
_ALLOWED_UNARYOPS = {ast.UAdd: _op.pos, ast.USub: _op.neg}


def _allowed_funcs():
    # Built lazily so np is already imported above.
    return {
        "sqrt": np.sqrt, "log": np.log, "log10": np.log10, "exp": np.exp,
        "abs": np.abs, "minimum": np.minimum, "maximum": np.maximum,
        "clip": np.clip, "power": np.power,
    }


def safe_eval_formula(formula, variables):
    """Safely evaluate a band-math formula such as ``(B8 - B4) / (B8 + B4)``.

    Only arithmetic (+ - * / ** %) on the supplied band arrays/numbers and a
    small whitelist of numpy functions (sqrt, log, log10, exp, abs, minimum,
    maximum, clip, power) are permitted; both ``sqrt(B8)`` and ``np.sqrt(B8)``
    forms are accepted. Anything else — attribute access, unknown names, dunder
    tricks, comprehensions, calls to other functions — raises ValueError.

    This replaces a previous ``eval()`` which executed arbitrary user input.
    """
    funcs = _allowed_funcs()

    def _eval(node):
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
                return node.value
            raise ValueError("Only numeric constants are allowed in a formula.")
        if isinstance(node, ast.Name):
            if node.id in variables:
                return variables[node.id]
            raise ValueError(f"Unknown band or name '{node.id}' in formula.")
        if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINOPS:
            return _ALLOWED_BINOPS[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARYOPS:
            return _ALLOWED_UNARYOPS[type(node.op)](_eval(node.operand))
        if isinstance(node, ast.Call):
            fname = None
            if isinstance(node.func, ast.Name):
                fname = node.func.id
            elif (isinstance(node.func, ast.Attribute)
                  and isinstance(node.func.value, ast.Name)
                  and node.func.value.id == "np"):
                fname = node.func.attr
            if fname not in funcs:
                raise ValueError("Only sqrt/log/log10/exp/abs/minimum/maximum/clip/power are allowed.")
            if node.keywords:
                raise ValueError("Keyword arguments are not allowed in a formula.")
            return funcs[fname](*[_eval(a) for a in node.args])
        raise ValueError("Unsupported expression in formula.")

    try:
        tree = ast.parse(formula, mode="eval")
    except SyntaxError as e:
        raise ValueError(f"Invalid formula syntax: {e}")
    return _eval(tree)

# Initialize Planetary Computer Catalog
STAC_API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"

def get_catalog():
    return pystac_client.Client.open(STAC_API_URL, modifier=planetary_computer.sign_inplace)

def extract_geojson_geometries(geojson):
    if not geojson:
        return []
    if isinstance(geojson, dict):
        if geojson.get("type") == "FeatureCollection":
            return [f["geometry"] for f in geojson.get("features", []) if f.get("geometry")]
        elif geojson.get("type") == "Feature":
            return [geojson["geometry"]] if geojson.get("geometry") else []
        elif "geometry" in geojson:
            return [geojson["geometry"]]
        else:
            return [geojson]
    return []


def search_stac(collection, bbox, date_range, cloud_cover=None, orbit=None, limit=50):
    """
    Search Planetary Computer STAC.
    bbox: [min_lon, min_lat, max_lon, max_lat]
    date_range: 'YYYY-MM-DD/YYYY-MM-DD'
    """
    catalog = get_catalog()
    query = {}
    
    # Apply cloud cover constraints for optical collections
    if cloud_cover is not None and collection in ["sentinel-2-l2a", "landsat-c2-l2"]:
        query["eo:cloud_cover"] = {"lt": cloud_cover}
        
    # Apply orbit state filters for Sentinel-1 Radar
    if orbit is not None and orbit.upper() != "BOTH" and collection == "sentinel-1-grd":
        # In STAC, orbit state is sat:orbit_state
        query["sat:orbit_state"] = {"eq": orbit.lower()}

    search = catalog.search(
        collections=[collection],
        bbox=bbox,
        datetime=date_range,
        query=query,
        limit=limit
    )
    
    items = search.item_collection()
    results = []
    
    for item in items:
        # Extract properties
        date_str = item.properties.get("datetime", "")
        if date_str:
            date_str = date_str.split("T")[0]
            
        cc = item.properties.get("eo:cloud_cover", None)
        thumb = item.assets.get("thumbnail", None)
        thumb_url = thumb.href if thumb else ""
        
        results.append({
            "id": item.id,
            "date": date_str,
            "cloud_cover": cc,
            "thumbnail": thumb_url,
            "properties": item.properties
        })
        
    # Sort by date descending
    results.sort(key=lambda x: x["date"], reverse=True)
    return results, items

def read_aligned_bands(item, bbox_wgs84, band_mapping, target_resolution=10):
    """
    Fetch, crop, and align raster bands from a STAC Item to EPSG:4326 grid inside bbox.
    bbox_wgs84: [min_lon, min_lat, max_lon, max_lat]
    band_mapping: dict of app_band_name -> pc_asset_name
    """
    min_lon, min_lat, max_lon, max_lat = bbox_wgs84
    
    # 1. Define resolution in degrees (approximately 10m = 0.00009 degrees)
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = target_resolution * deg_per_meter
    
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    # Cap dimensions to avoid out-of-memory or timeout errors (max 1500x1500)
    width = min(width, 1500)
    height = min(height, 1500)
    # Ensure a minimum display resolution so a SMALL ROI is not rendered as a few
    # blocky native pixels (which also makes any ROI-polygon clip look ragged).
    # Upscale preserving aspect; normal-sized ROIs (short side >= MIN_DISP) are
    # left unchanged, so this only affects tiny areas.
    MIN_DISP = 256
    short = max(1, min(width, height))
    if short < MIN_DISP:
        scale = MIN_DISP / short
        width = min(1500, int(round(width * scale)))
        height = min(1500, int(round(height * scale)))
    width = max(10, width)
    height = max(10, height)
    
    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    
    # Affine transform for EPSG:4326
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"
    
    aligned_data = {}

    # rasterio.Env applies the GDAL /vsicurl tuning (parallel reads, caching,
    # HTTP timeout) to every read below — without it remote reads are far slower.
    with rasterio.Env(**GDAL_OPTS):
      for app_band, asset_name in band_mapping.items():
        if asset_name not in item.assets:
            continue

        signed_href = planetary_computer.sign(item.assets[asset_name].href)

        with rasterio.open(signed_href) as src:
            dest = np.zeros(target_shape, dtype=np.float32)

            # Reproject source asset bounding slice directly into destination array
            reproject(
                source=rasterio.band(src, 1),
                destination=dest,
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=target_transform,
                dst_crs=target_crs,
                resampling=Resampling.bilinear,
                src_nodata=src.nodata,
                dst_nodata=0.0
            )
            
            # Replace nan/infinite with 0
            dest = np.nan_to_num(dest)
            aligned_data[app_band] = dest
            
    return aligned_data, target_transform, target_crs

def calculate_index(bands_data, platform, index_name, formula=None):
    """
    Compute spectral indices or custom formulas on aligned numpy arrays.
    """
    # Normalize optical bands to reflectance if Sentinel-2 (assets are scaled by 10000 in raw Sentinel)
    # Note: MPC Sentinel-2 L2A assets are raw DN values scaled by 10000.
    # Landsat C2 L2 surface reflectance are scaled by 2.75e-5 and offset by -0.2.
    scaled_bands = {}
    
    if platform == "Sentinel-2 (Optical)":
        for b, arr in bands_data.items():
            scaled_bands[b] = arr / 10000.0
    elif "Landsat" in platform:
        for b, arr in bands_data.items():
            if b in ["B1", "B2", "B3", "B4", "B5", "B6", "B7"]:
                scaled_bands[b] = arr * 0.0000275 - 0.2
            elif b in ["B10", "ST_B10"]:
                # Brightness temp in Kelvin
                scaled_bands[b] = arr * 0.00341802 + 149.0
            else:
                scaled_bands[b] = arr
    else:
        # Sentinel-1 Radar or DEM - use values directly
        scaled_bands = bands_data

    # Calculate index
    if index_name == "NDVI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        red = scaled_bands.get("B4")
        if nir is not None and red is not None:
            denom = (nir + red)
            denom[denom == 0] = 1e-6
            return (nir - red) / denom
            
    elif index_name == "GNDVI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        green = scaled_bands.get("B3")
        if nir is not None and green is not None:
            denom = (nir + green)
            denom[denom == 0] = 1e-6
            return (nir - green) / denom
            
    elif index_name == "NDWI (Water)" or index_name == "NDWI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        green = scaled_bands.get("B3")
        if nir is not None and green is not None:
            denom = (green + nir)
            denom[denom == 0] = 1e-6
            return (green - nir) / denom
            
    elif index_name == "NDMI":
        nir = scaled_bands.get("B8") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B5")
        swir1 = scaled_bands.get("B11") if platform == "Sentinel-2 (Optical)" else scaled_bands.get("B6")
        if nir is not None and swir1 is not None:
            denom = (nir + swir1)
            denom[denom == 0] = 1e-6
            return (nir - swir1) / denom
            
    elif index_name == "LST (Thermal)":
        # Convert Kelvin to Celsius: K - 273.15
        # NOTE: use explicit None checks, not `a or b` — numpy arrays raise
        # "truth value of an array is ambiguous" when used in a boolean context.
        thermal = scaled_bands.get("ST_B10")
        if thermal is None:
            thermal = scaled_bands.get("B10")
        if thermal is not None:
            return thermal - 273.15
            
    elif index_name == "VV" and "Sentinel-1" in platform:
        return scaled_bands.get("VV")
        
    elif index_name == "VH" and "Sentinel-1" in platform:
        return scaled_bands.get("VH")
        
    elif index_name == "VH/VV Ratio" and "Sentinel-1" in platform:
        vv = scaled_bands.get("VV")
        vh = scaled_bands.get("VH")
        if vv is not None and vh is not None:
            # S1 GRD backscatter on MPC is typically in decibel scale (dB) already
            # If in dB, VH/VV ratio is vh - vv (since log(A/B) = log(A) - log(B))
            return vh - vv

    elif "Custom" in index_name and formula:
        # Evaluate the custom band-math formula with a sandboxed AST evaluator
        # (no eval()). Band names map directly to their scaled numpy arrays, e.g.
        # "(B8 - B4) / (B8 + B4)".
        try:
            result = safe_eval_formula(formula, dict(scaled_bands))
        except ValueError:
            raise
        except Exception as e:
            raise ValueError(f"Custom formula evaluation failed: {e}")
        # A constant/scalar formula (e.g. "1") yields a scalar; broadcast it to
        # the band grid so downstream .shape / masking still works.
        if np.isscalar(result) or (hasattr(result, "ndim") and result.ndim == 0):
            ref = next(iter(scaled_bands.values()), None)
            if ref is None:
                raise ValueError("Custom formula produced a scalar with no band to size it.")
            result = np.full_like(ref, float(result), dtype=np.float32)
        return result
            
    raise ValueError(f"Unknown index or platform: {index_name}")

def calculate_roi_stats(data):
    """Calculate statistics of calculated raster array."""
    valid_data = data[~np.isnan(data) & ~np.isinf(data)]
    if len(valid_data) == 0:
        return {"min": 0, "max": 0, "mean": 0, "std": 0}
        
    p2 = float(np.percentile(valid_data, 2))
    p98 = float(np.percentile(valid_data, 98))
    
    return {
        "min": float(np.min(valid_data)),
        "max": float(np.max(valid_data)),
        "mean": float(np.mean(valid_data)),
        "std": float(np.std(valid_data)),
        "p2": p2,
        "p98": p98
    }

def get_color_palette(name):
    palettes = {
        "Red-Yellow-Green (Vegetation)": ['#d7191c', '#fdae61', '#ffffbf', '#a6d96a', '#1a9641'],
        "Blue-White-Green (Water/Veg)": ['#0000ff', '#ffffff', '#008000'],
        "Blue-Yellow-Red (Thermal)": ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'],
        "Viridis (Sequential)": ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
        "Magma (Sequential)": ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fcfdbf'],
        "Inferno (Sequential)": ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746'],
        "Plasma (Sequential)": ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
        "Turbo (Rainbow Enhanced)": ['#30123b', '#466be3', '#28bbec', '#32f197', '#a2fc3c', '#f2f221', '#fc8961', '#cf2547', '#7a0403'],
        "Ocean (Water Depth)": ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'],
        # Evapotranspiration: low -> high = dry -> wet (darkred -> orange -> yellow -> green -> navy).
        "ET (Dry-Wet)": ['#8B0000', '#FF4500', '#FFFF00', '#00FF00', '#000080'],
        "Terrain (Elevation)": ['#006400', '#32CD32', '#FFFF00', '#DAA520', '#8B4513', '#A0522D', '#D2691E', '#CD853F', '#F4A460', '#DEB887', '#D3D3D3', '#FFFFFF'],
        "Greyscale": ['#000000', '#FFFFFF']
    }
    return palettes.get(name, palettes["Red-Yellow-Green (Vegetation)"])

def _hex_to_rgb01(hex_color):
    """'#rrggbb' -> (r, g, b) floats in [0, 1]."""
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)


def apply_linear_palette(norm_data, palette_colors):
    """Map a [0,1]-normalized array to RGB via a linear gradient over palette_colors.

    Pure-numpy replacement for matplotlib's
    ``LinearSegmentedColormap.from_list(...)(norm_data)``: the palette colors are
    placed at equal positions across [0,1] and each channel is linearly
    interpolated. Returns an (H, W, 3) float array in [0, 1].
    """
    anchors = np.array([_hex_to_rgb01(c) for c in palette_colors], dtype=np.float64)
    x = np.clip(norm_data, 0.0, 1.0)
    if len(anchors) == 1:
        rgb = np.empty(x.shape + (3,), dtype=np.float64)
        rgb[...] = anchors[0]
        return rgb
    positions = np.linspace(0.0, 1.0, len(anchors))
    return np.stack(
        [np.interp(x, positions, anchors[:, ch]) for ch in range(3)],
        axis=-1,
    )


def save_visual_png(data, vmin, vmax, palette_colors, output_path):
    """
    Map array to RGB based on color palette and stretch values, and save as PNG.
    """
    # Replace nan/inf
    clean_data = np.nan_to_num(data, nan=vmin)

    # Normalize index array to [0, 1] using vmin and vmax
    if vmax == vmin:
        vmax = vmin + 1e-6
    norm_data = (clean_data - vmin) / (vmax - vmin)
    norm_data = np.clip(norm_data, 0.0, 1.0)

    # Map normalized values to RGB through the linear palette gradient
    rgb01 = apply_linear_palette(norm_data, palette_colors)

    # Keep transparency where data was originally NaN/inf or completely 0 (no data)
    alpha = np.ones(clean_data.shape, dtype=np.uint8) * 255
    alpha[np.isnan(data)] = 0

    # Combine RGB with Alpha channel
    rgb = (rgb01 * 255).astype(np.uint8)
    rgba_output = np.dstack((rgb, alpha))

    img = Image.fromarray(rgba_output, "RGBA")
    img.save(output_path, "PNG")

def save_geotiff(data, transform, crs, output_path):
    """
    Export single-band raw float raster to GeoTIFF format.
    """
    height, width = data.shape
    with rasterio.open(
        output_path,
        'w',
        driver='GTiff',
        height=height,
        width=width,
        count=1,
        dtype=rasterio.float32,
        crs=crs,
        transform=transform,
        nodata=np.nan
    ) as dst:
        dst.write(data.astype(rasterio.float32), 1)


def sample_geotiff_value(tiff_path, lat, lon):
    """
    Open a single-band GeoTIFF (as saved by save_geotiff) and sample the
    pixel value at a WGS84 lat/lon. Returns None if the point falls outside
    the raster bounds or lands on a nodata pixel.
    """
    with rasterio.open(tiff_path) as ds:
        if ds.crs and ds.crs.to_epsg() != 4326:
            from rasterio.warp import transform as warp_transform
            xs, ys = warp_transform("EPSG:4326", ds.crs, [lon], [lat])
            x, y = xs[0], ys[0]
        else:
            x, y = lon, lat

        if not (ds.bounds.left <= x <= ds.bounds.right and ds.bounds.bottom <= y <= ds.bounds.top):
            return None

        val = list(ds.sample([(x, y)]))[0][0]
        if val is None or np.isnan(val):
            return None
        return float(val)


# ============================================================
# LULC (Land Use / Land Cover) Processing Functions
# ============================================================

# ESA WorldCover 10m — 11 discrete classes
ESA_WORLDCOVER_LEGEND = {
    10:  {"name": "Tree cover",              "color": "#006400"},
    20:  {"name": "Shrubland",               "color": "#ffbb22"},
    30:  {"name": "Grassland",               "color": "#ffff4c"},
    40:  {"name": "Cropland",                "color": "#f096ff"},
    50:  {"name": "Built-up",                "color": "#fa0000"},
    60:  {"name": "Bare / sparse vegetation", "color": "#b4b4b4"},
    70:  {"name": "Snow and ice",            "color": "#f0f0f0"},
    80:  {"name": "Permanent water bodies",  "color": "#0064c8"},
    90:  {"name": "Herbaceous wetland",      "color": "#0096a0"},
    95:  {"name": "Mangroves",               "color": "#00cf75"},
    100: {"name": "Moss and lichen",         "color": "#fae6a0"},
}

# Impact Observatory 10m Annual LULC v02 — 9 discrete classes.
# Class values are non-contiguous (3 and 6 are unused) per the collection's
# own `classification:classes` / `file:values` STAC metadata — do not
# renumber these to be consecutive.
IO_LULC_LEGEND = {
    1:  {"name": "Water",              "color": "#419bdf"},
    2:  {"name": "Trees",              "color": "#397d49"},
    4:  {"name": "Flooded Vegetation", "color": "#7a87c6"},
    5:  {"name": "Crops",              "color": "#e49635"},
    7:  {"name": "Built Area",         "color": "#c4281b"},
    8:  {"name": "Bare Ground",        "color": "#a59b8f"},
    9:  {"name": "Snow/Ice",           "color": "#a8ebff"},
    10: {"name": "Clouds",             "color": "#616161"},
    11: {"name": "Rangeland",          "color": "#e3e2c3"},
}


def get_lulc_legend(dataset):
    """Return the class legend dict for the specified LULC dataset."""
    if dataset == "esa-worldcover":
        return ESA_WORLDCOVER_LEGEND
    elif dataset == "io-lulc":
        return IO_LULC_LEGEND
    else:
        raise ValueError(f"Unknown LULC dataset: {dataset}")


def fetch_lulc_raster(bbox_wgs84, dataset, year):
    """
    Search Planetary Computer STAC for the requested LULC dataset and year,
    fetch the classification raster, crop to bbox, and reproject to EPSG:4326.
    Returns: (class_array, transform, crs)
    """
    catalog = get_catalog()

    if dataset == "esa-worldcover":
        collection_name = "esa-worldcover"
        asset_key = "map"
    elif dataset == "io-lulc":
        collection_name = "io-lulc-annual-v02"
        asset_key = "data"
    else:
        raise ValueError(f"Unknown LULC dataset: {dataset}")

    date_range = f"{year}-01-01/{year}-12-31"

    search = catalog.search(
        collections=[collection_name],
        bbox=bbox_wgs84,
        datetime=date_range,
        limit=10
    )

    items = search.item_collection()
    if len(items) == 0:
        raise ValueError(f"No {dataset} items found for year {year} in the given area.")

    # Pick the first matching item
    item = items[0]

    if asset_key not in item.assets:
        raise ValueError(f"Asset '{asset_key}' not found in STAC item {item.id}.")

    signed_href = planetary_computer.sign(item.assets[asset_key].href)

    min_lon, min_lat, max_lon, max_lat = bbox_wgs84

    # Define target grid in EPSG:4326
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = 10 * deg_per_meter  # 10m
    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))

    # Cap dimensions
    width = min(width, 2000)
    height = min(height, 2000)
    # Minimum display resolution so a small ROI isn't a few blocky pixels (only
    # affects tiny areas; normal ROIs are unchanged). Classes use nearest
    # resampling, so boundaries stay crisp.
    MIN_DISP = 256
    short = max(1, min(width, height))
    if short < MIN_DISP:
        scale = MIN_DISP / short
        width = min(2000, int(round(width * scale)))
        height = min(2000, int(round(height * scale)))
    width = max(10, width)
    height = max(10, height)

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height

    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    target_shape = (height, width)
    target_crs = "EPSG:4326"

    with rasterio.open(signed_href) as src:
        dest = np.zeros(target_shape, dtype=np.uint8)

        reproject(
            source=rasterio.band(src, 1),
            destination=dest,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=target_transform,
            dst_crs=target_crs,
            resampling=Resampling.nearest,   # Nearest-neighbor for categorical data
            src_nodata=src.nodata if src.nodata is not None else 0,
            dst_nodata=0
        )

    return dest, target_transform, target_crs


def colorize_lulc_png(class_array, legend, output_path):
    """
    Map discrete class values to their canonical RGBA colors and save as PNG.
    Pixels with value 0 (nodata) are made transparent.
    """
    height, width = class_array.shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)

    for class_val, info in legend.items():
        hex_color = info["color"]
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)

        mask = class_array == class_val
        rgba[mask, 0] = r
        rgba[mask, 1] = g
        rgba[mask, 2] = b
        rgba[mask, 3] = 255

    # Nodata pixels (value 0 or unmatched) remain fully transparent (alpha=0)
    img = Image.fromarray(rgba, "RGBA")
    img.save(output_path, "PNG")


def compute_lulc_stats(class_array, legend, pixel_area_m2=100.0):
    """
    Count pixels per class and compute area statistics.
    pixel_area_m2: approximate area of one pixel in square meters (default 100 = 10m × 10m).
    Returns dict: { class_value: { name, color, pixel_count, area_ha, percentage } }
    """
    total_valid = int(np.sum(class_array > 0))
    if total_valid == 0:
        return {}

    stats = {}
    for class_val, info in legend.items():
        count = int(np.sum(class_array == class_val))
        if count == 0:
            continue
        area_ha = (count * pixel_area_m2) / 10000.0  # 1 ha = 10000 m²
        percentage = (count / total_valid) * 100.0

        stats[str(class_val)] = {
            "name": info["name"],
            "color": info["color"],
            "pixel_count": count,
            "area_ha": round(area_ha, 2),
            "percentage": round(percentage, 2)
        }

    return stats


# ============================================================
# Flood Detection (Sentinel-1 SAR backscatter change)
# ============================================================
# Mirrors the methodology in flood.py: warp Sentinel-1 GRD VV scenes onto a fixed
# grid, convert the amplitude DN to relative decibels, take before/after scenes and
# flag pixels that got markedly darker (backscatter drop = candidate new water).
# The one change requested over flood.py: instead of compositing every scene in a
# window, the caller picks the single scene closest to the event date in each of a
# user-supplied pre-event and post-event date range (see backend/app.py).


def compute_flood_grid(bbox_wgs84, target_resolution=10, max_dim=1500):
    """Define the fixed EPSG:4326 output grid (transform, (height, width)) for a bbox.

    Uses the same 10 m-in-degrees approximation and dimension cap as the optical
    pipeline so the resulting PNG/GeoTIFF aligns with the Leaflet bbox overlay.
    """
    min_lon, min_lat, max_lon, max_lat = bbox_wgs84
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = target_resolution * deg_per_meter
    width = min(int(np.ceil((max_lon - min_lon) / deg_resolution)), max_dim)
    height = min(int(np.ceil((max_lat - min_lat) / deg_resolution)), max_dim)
    # Minimum resolution so a small ROI isn't a few blocky pixels (aspect-preserving;
    # normal ROIs unchanged).
    MIN_DISP = 256
    short = max(1, min(width, height))
    if short < MIN_DISP:
        scale = MIN_DISP / short
        width = min(max_dim, int(round(width * scale)))
        height = min(max_dim, int(round(height * scale)))
    width = max(10, width)
    height = max(10, height)
    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    return transform, (height, width)


def load_grd_vv_db(item, bbox_wgs84, shape, asset="vv"):
    """Warp a Sentinel-1 GRD scene asset onto the bbox grid and return backscatter in dB.

    GRD assets on Planetary Computer are GCP-referenced amplitude (DN) rasters, so
    (as in flood.py) we warp from the GCP CRS through a WarpedVRT to EPSG:4326 and
    convert the amplitude DN to relative decibels with 20*log10(DN). Pixels with
    DN <= 0 (no-data) become NaN.
    """
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import from_bounds, transform as window_transform, Window

    min_lon, min_lat, max_lon, max_lat = bbox_wgs84
    H, W = shape
    pixel_w = (max_lon - min_lon) / W
    pixel_h = (max_lat - min_lat) / H
    target_transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)

    href = planetary_computer.sign(item.assets[asset].href)
    dn = np.full((H, W), np.nan, dtype="float64")

    with rasterio.Env(**GDAL_OPTS), rasterio.open(href) as src:
        gcps, gcp_crs = src.gcps
        vrt_kwargs = {"crs": "EPSG:4326", "resampling": Resampling.bilinear}
        if gcps:
            # GRD products carry ground-control points rather than an affine grid.
            vrt_kwargs["src_crs"] = gcp_crs
        with WarpedVRT(src, **vrt_kwargs) as vrt:
            # Read an INTEGER, in-bounds window over the bbox (WarpedVRT forbids
            # boundless reads, and rasterio auto-promotes an out-of-range window to
            # a boundless one). Then reproject that patch onto the fixed output grid,
            # leaving NaN wherever the scene footprint does not cover the bbox.
            win = from_bounds(min_lon, min_lat, max_lon, max_lat, vrt.transform)
            col_off = max(0, int(np.floor(win.col_off)))
            row_off = max(0, int(np.floor(win.row_off)))
            col_end = min(vrt.width, int(np.ceil(win.col_off + win.width)))
            row_end = min(vrt.height, int(np.ceil(win.row_off + win.height)))

            if col_end > col_off and row_end > row_off:
                window = Window(col_off, row_off, col_end - col_off, row_end - row_off)
                src_arr = vrt.read(1, window=window).astype("float64")
                src_transform = window_transform(window, vrt.transform)

                reproject(
                    source=src_arr,
                    destination=dn,
                    src_transform=src_transform,
                    src_crs="EPSG:4326",
                    dst_transform=target_transform,
                    dst_crs="EPSG:4326",
                    resampling=Resampling.bilinear,
                    src_nodata=0,
                    dst_nodata=np.nan,
                )

    dn[dn <= 0] = np.nan
    return 20.0 * np.log10(dn)


def despeckle_db(arr, size=5):
    """Median-filter a dB array to suppress SAR speckle, preserving NaN no-data.

    SAR backscatter is grainy (speckle), so a per-pixel before/after difference is
    very noisy. A small median filter knocks the speckle down while keeping edges,
    which is what makes a single-scene flood difference usable.
    """
    from scipy.ndimage import median_filter
    finite = np.isfinite(arr)
    if not finite.any():
        return arr
    filled = np.where(finite, arr, float(np.nanmedian(arr)))
    out = median_filter(filled, size=size, mode="nearest")
    out[~finite] = np.nan
    return out


def remove_small_blobs(mask, min_size=10):
    """Drop connected True regions smaller than min_size pixels (residual speckle)."""
    from scipy.ndimage import label
    lbl, n = label(mask)
    if n == 0:
        return mask
    counts = np.bincount(lbl.ravel())
    small = [i for i in range(1, len(counts)) if counts[i] < min_size]
    if small:
        mask = mask & ~np.isin(lbl, small)
    return mask


def save_mask_png(mask, output_path, color=(239, 68, 68), alpha=200):
    """Save a boolean mask as RGBA PNG: True -> solid color, elsewhere transparent.

    Default color is red (flood extent).
    """
    h, w = mask.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[mask, 0] = color[0]
    rgba[mask, 1] = color[1]
    rgba[mask, 2] = color[2]
    rgba[mask, 3] = alpha
    Image.fromarray(rgba, "RGBA").save(output_path, "PNG")

