"""
Core engine for National Highway-wise landslide susceptibility analysis.

Methodology
-----------
1. The selected highway's (Multi)LineString is densified to ~STEP_M spaced
   stations; total length is computed from the densified chain.
2. A corridor is sampled with transect rows parallel to the centreline at
   fixed offsets (OFFSETS_M, both sides). Row samples are weighted by the
   corridor band each row represents, giving an area-composition estimate of
   the buffered corridor without rasterising huge windows.
3. The susceptibility class raster is sampled at every station/offset point
   using tile-grouped windowed reads (memory-safe on the full-resolution
   country rasters). The probability raster is sampled at the same points.
4. Along-line classes become run-length "segments" for map colouring, and
   per-class lengths/percentages for the table & charts.
5. Display buffer polygons are built with shapely in a highway-centred
   azimuthal-equidistant projection and simplified for the web map.

Class raster convention (same as the district analysis): values 1..5 =
Very Low..Very High, 0 / NaN = outside the analysed study area.
"""

import json
import math

import numpy as np

STEP_M = 100.0                      # along-line station spacing
OFFSETS_M = (125.0, 250.0, 500.0, 750.0, 1000.0)  # transect rows each side
BUFFERS_M = (250, 500, 1000)        # corridor half-widths offered in the UI

M_PER_DEG_LAT = 111132.0
M_PER_DEG_LON_EQ = 111320.0

CLASS_KEYS = ("1", "2", "3", "4", "5")


# ---------------------------------------------------------------------------
# Highway geometry helpers
# ---------------------------------------------------------------------------

def load_highway_features(path):
    """Return {name: feature} for every highway in the GeoJSON file.

    Sources like INDIA_NATIONAL_HIGHWAY.geojson store one feature per road
    segment (tens of thousands of features, many per highway), so all
    segments sharing a Name are merged into a single MultiLineString
    feature. Whitespace in names is normalised ("NH  309" -> "NH 309").
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    merged = {}
    for feat in data.get("features", []):
        props = feat.get("properties") or {}
        name = props.get("Name")
        if not name:
            continue
        name = " ".join(str(name).split())
        geom = feat.get("geometry") or {}
        if geom.get("type") == "LineString":
            parts = [geom["coordinates"]]
        elif geom.get("type") == "MultiLineString":
            parts = list(geom["coordinates"])
        else:
            continue

        entry = merged.get(name)
        if entry is None:
            merged[name] = {
                "type": "Feature",
                "properties": {"Name": name, "Road_Type": props.get("Road_Type")},
                "geometry": {"type": "MultiLineString", "coordinates": parts},
            }
        else:
            entry["geometry"]["coordinates"].extend(parts)
    return merged


def _line_parts(feature):
    """Yield each LineString of the feature as an (N, 2) lon/lat array."""
    geom = feature.get("geometry") or {}
    if geom.get("type") == "LineString":
        coords = [geom["coordinates"]]
    elif geom.get("type") == "MultiLineString":
        coords = geom["coordinates"]
    else:
        coords = []
    for part in coords:
        arr = np.asarray(part, dtype=float)
        if arr.ndim == 2 and len(arr) >= 2:
            yield arr[:, :2]


def _densify_part(arr, step_m=STEP_M):
    """Densify one line part into equal-length steps.

    Returns dict with:
      boundaries : (n+1, 2) lon/lat step-boundary vertices (for map segments)
      mids       : (n, 2) lon/lat step midpoints (sampling stations)
      normals    : (n, 2) unit normals in local metric (for transect offsets)
      step_len_m : actual metres represented by every step
      total_m    : part length in metres
    """
    lon, lat = arr[:, 0], arr[:, 1]
    lat_mid = np.radians((lat[:-1] + lat[1:]) / 2.0)
    dx = (lon[1:] - lon[:-1]) * M_PER_DEG_LON_EQ * np.cos(lat_mid)
    dy = (lat[1:] - lat[:-1]) * M_PER_DEG_LAT
    seg_len = np.hypot(dx, dy)
    cum = np.concatenate(([0.0], np.cumsum(seg_len)))
    total = float(cum[-1])
    if total <= 0.0:
        return None

    n_steps = max(1, int(round(total / step_m)))
    step = total / n_steps
    bound_d = np.linspace(0.0, total, n_steps + 1)
    mid_d = (bound_d[:-1] + bound_d[1:]) / 2.0

    boundaries = np.column_stack((np.interp(bound_d, cum, lon), np.interp(bound_d, cum, lat)))
    mids = np.column_stack((np.interp(mid_d, cum, lon), np.interp(mid_d, cum, lat)))

    seg_idx = np.clip(np.searchsorted(cum, mid_d, side="right") - 1, 0, len(seg_len) - 1)
    safe_len = np.where(seg_len[seg_idx] > 0, seg_len[seg_idx], 1.0)
    tx = dx[seg_idx] / safe_len
    ty = dy[seg_idx] / safe_len
    normals = np.column_stack((-ty, tx))  # left-hand unit normal (metric)

    return {
        "boundaries": boundaries,
        "mids": mids,
        "normals": normals,
        "step_len_m": step,
        "total_m": total,
    }


def densify_highway(feature, step_m=STEP_M):
    """Densify all parts of a highway. Returns (parts, total_length_m)."""
    parts = []
    total = 0.0
    for arr in _line_parts(feature):
        d = _densify_part(arr, step_m)
        if d is not None:
            parts.append(d)
            total += d["total_m"]
    return parts, total


def _offset_points(mids, normals, offset_m):
    """Shift station midpoints sideways by offset_m metres (signed)."""
    lat_rad = np.radians(mids[:, 1])
    dlon = (normals[:, 0] * offset_m) / (M_PER_DEG_LON_EQ * np.cos(lat_rad))
    dlat = (normals[:, 1] * offset_m) / M_PER_DEG_LAT
    return np.column_stack((mids[:, 0] + dlon, mids[:, 1] + dlat))


def corridor_rows(parts, offsets_m=OFFSETS_M):
    """Build the sampling rows for a highway.

    Returns (rows, mids_all, step_len_all) where rows is a list of
    (signed_offset_m, (n,2) lon/lat points); the 0-offset row is the
    centreline stations themselves. All rows share station order.
    """
    mids_all = np.concatenate([p["mids"] for p in parts])
    normals_all = np.concatenate([p["normals"] for p in parts])
    step_len_all = np.concatenate([np.full(len(p["mids"]), p["step_len_m"]) for p in parts])

    rows = [(0.0, mids_all)]
    for off in offsets_m:
        rows.append((off, _offset_points(mids_all, normals_all, off)))
        rows.append((-off, _offset_points(mids_all, normals_all, -off)))
    return rows, mids_all, step_len_all


# ---------------------------------------------------------------------------
# Raster point sampling (tile-grouped windowed reads)
# ---------------------------------------------------------------------------

def sample_raster_points(dataset, lons, lats, tile=1024, cache=None, cache_max=48):
    """Sample band 1 of a rasterio dataset at lon/lat points.

    Points are grouped by raster tile so each needed window is read once,
    which keeps memory bounded on the ~29k x ~29k country rasters.
    `cache` (an OrderedDict) reuses tile blocks across calls — used by the
    bulk precompute where consecutive highways share tiles.
    Returns float array with NaN for points outside the raster.
    """
    from rasterio.windows import Window

    t = dataset.transform
    cols = np.floor((lons - t.c) / t.a).astype(np.int64)
    rows = np.floor((lats - t.f) / t.e).astype(np.int64)

    out = np.full(lons.shape, np.nan, dtype=np.float64)
    valid = (rows >= 0) & (rows < dataset.height) & (cols >= 0) & (cols < dataset.width)
    if not valid.any():
        return out

    vr, vc = rows[valid], cols[valid]
    n_tx = dataset.width // tile + 1
    tile_ids = (vr // tile) * n_tx + (vc // tile)
    order = np.argsort(tile_ids, kind="stable")
    sorted_ids = tile_ids[order]
    uniq, starts = np.unique(sorted_ids, return_index=True)

    vals = np.full(vr.shape, np.nan, dtype=np.float64)
    for gi in range(len(uniq)):
        s = starts[gi]
        e = starts[gi + 1] if gi + 1 < len(uniq) else len(order)
        idx = order[s:e]
        r0 = int(vr[idx[0]] // tile) * tile
        c0 = int(vc[idx[0]] // tile) * tile
        block = None if cache is None else cache.get((r0, c0))
        if block is None:
            h = min(tile, dataset.height - r0)
            w = min(tile, dataset.width - c0)
            block = dataset.read(1, window=Window(c0, r0, w, h))
            if cache is not None:
                cache[(r0, c0)] = block
                while len(cache) > cache_max:
                    cache.popitem(last=False)
        elif cache is not None:
            cache.move_to_end((r0, c0))
        vals[idx] = block[vr[idx] - r0, vc[idx] - c0]

    out[valid] = vals
    return out


def to_classes(values):
    """Map raw raster samples to integer classes 0..5 (0 = not analysed)."""
    cls = np.where(np.isnan(values), 0.0, values)
    cls = np.rint(cls).astype(np.int64)
    cls[(cls < 0) | (cls > 5)] = 0
    return cls


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def _row_band_weights(offsets_present, buffer_m):
    """Corridor band width (m) represented by each transect row.

    Rows sit at signed offsets; each row stands for the slice of corridor
    between the midpoints to its neighbouring rows (clamped to +/-buffer_m),
    so unevenly spaced rows still yield an unbiased area composition.
    """
    offs = sorted(o for o in offsets_present if abs(o) <= buffer_m)
    weights = {}
    for i, o in enumerate(offs):
        lo = -buffer_m if i == 0 else (offs[i - 1] + o) / 2.0
        hi = buffer_m if i == len(offs) - 1 else (o + offs[i + 1]) / 2.0
        weights[o] = hi - lo
    return weights


def _class_percentages(classes, weights):
    """Weighted % per class 1..5 over analysed samples + analysed %."""
    total_w = float(weights.sum())
    valid = classes > 0
    valid_w = float(weights[valid].sum())
    analyzed_pct = (valid_w / total_w * 100.0) if total_w > 0 else 0.0
    stats = {}
    for c in range(1, 6):
        w = float(weights[classes == c].sum())
        stats[str(c)] = round((w / valid_w * 100.0) if valid_w > 0 else 0.0, 1)
    return stats, round(analyzed_pct, 1)


def line_length_stats(line_classes, step_len_m):
    """Per-class length (km) and % of analysed length along the centreline."""
    stats, analyzed_pct = _class_percentages(line_classes, step_len_m)
    lengths = {}
    for c in range(1, 6):
        lengths[str(c)] = round(float(step_len_m[line_classes == c].sum()) / 1000.0, 2)
    unanalyzed_km = round(float(step_len_m[line_classes == 0].sum()) / 1000.0, 2)
    return stats, lengths, analyzed_pct, unanalyzed_km


def corridor_stats(rows, row_classes, row_probs, step_len_all, buffers_m=BUFFERS_M):
    """Weighted corridor composition + probability stats per buffer width."""
    offsets_present = [off for off, _ in rows]
    corridor = {}
    probability = {}
    for b in buffers_m:
        band_w = _row_band_weights(offsets_present, b)
        cls_list, w_list, prob_list, pw_list = [], [], [], []
        for (off, _), cls, prob in zip(rows, row_classes, row_probs):
            if off not in band_w:
                continue
            cls_list.append(cls)
            w_list.append(step_len_all * band_w[off])  # sample area weight
            if prob is not None:
                prob_list.append(prob)
                pw_list.append(np.full(len(cls), band_w[off]))
        classes = np.concatenate(cls_list)
        weights = np.concatenate(w_list)
        stats, analyzed_pct = _class_percentages(classes, weights)
        corridor[str(b)] = {"stats": stats, "analyzed_percentage": analyzed_pct}

        if prob_list:
            probs = np.concatenate(prob_list)
            pw = np.concatenate(pw_list)
            ok = ~np.isnan(probs)
            if ok.any():
                probability[str(b)] = {
                    "min": round(float(np.nanmin(probs)), 4),
                    "mean": round(float(np.average(probs[ok], weights=pw[ok])), 4),
                    "max": round(float(np.nanmax(probs)), 4),
                }
    return corridor, probability


# ---------------------------------------------------------------------------
# Map geometry outputs
# ---------------------------------------------------------------------------

def _simplify_run(coords_lonlat, tolerance_deg=5e-4):
    """Douglas-Peucker simplify one run's vertex chain (lon/lat array)."""
    if len(coords_lonlat) <= 2:
        return coords_lonlat
    from shapely.geometry import LineString
    simplified = LineString(coords_lonlat).simplify(tolerance_deg, preserve_topology=False)
    return np.asarray(simplified.coords)


def build_segments(parts, line_classes, tolerance_deg=5e-4):
    """Run-length encode along-line classes into drawable map segments.

    Returns [{"c": class, "km": length, "pts": [[lat, lon], ...]}, ...]
    """
    segments = []
    pos = 0
    for p in parts:
        n = len(p["mids"])
        cls = line_classes[pos:pos + n]
        pos += n
        bounds = p["boundaries"]
        start = 0
        for i in range(1, n + 1):
            if i == n or cls[i] != cls[start]:
                # class-0 runs are only drawn as a grey "not analysed" trace,
                # so they tolerate much coarser simplification
                tol = tolerance_deg * 4 if cls[start] == 0 else tolerance_deg
                run = _simplify_run(bounds[start:i + 1], tol)
                pts = [[round(float(la), 5), round(float(lo), 5)] for lo, la in run]
                segments.append({
                    "c": int(cls[start]),
                    "km": round((i - start) * p["step_len_m"] / 1000.0, 2),
                    "pts": pts,
                })
                start = i
    return segments


def _round_coords(obj, ndigits=4):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(v), ndigits) for v in obj]
        return [_round_coords(v, ndigits) for v in obj]
    return obj


def buffer_polygon_geojson(feature, buffer_m):
    """Simplified display polygon of the buffered highway (GeoJSON geometry)."""
    from shapely.geometry import shape, mapping
    from shapely.ops import transform as shp_transform
    from pyproj import Transformer

    geom = shape(feature["geometry"])
    c = geom.centroid
    aeqd = f"+proj=aeqd +lat_0={c.y} +lon_0={c.x} +datum=WGS84 +units=m +no_defs"
    fwd = Transformer.from_crs("EPSG:4326", aeqd, always_xy=True).transform
    inv = Transformer.from_crs(aeqd, "EPSG:4326", always_xy=True).transform

    buffered = shp_transform(fwd, geom).buffer(buffer_m, quad_segs=4)
    buffered = buffered.simplify(max(buffer_m / 3.0, 60.0), preserve_topology=False)
    gj = mapping(shp_transform(inv, buffered))
    return {"type": gj["type"], "coordinates": _round_coords(gj["coordinates"])}


# ---------------------------------------------------------------------------
# Top-level analysis
# ---------------------------------------------------------------------------

def analyze_highway(feature, class_ds, prob_ds=None, buffers_m=BUFFERS_M,
                    step_m=STEP_M, include_geometry=True,
                    class_cache=None, prob_cache=None):
    """Full NH-wise susceptibility analysis for one highway feature.

    class_ds / prob_ds are open rasterio datasets (prob_ds optional).
    """
    parts, total_m = densify_highway(feature, step_m)
    if not parts:
        raise ValueError("Highway has no usable line geometry")

    offsets = tuple(o for o in OFFSETS_M if o <= max(buffers_m))
    rows, mids_all, step_len_all = corridor_rows(parts, offsets)

    # One batched sampling call per raster: all rows share the same tiles,
    # so per-row calls would re-read every tile len(rows) times.
    all_pts = np.concatenate([pts for _, pts in rows])
    class_vals = sample_raster_points(class_ds, all_pts[:, 0], all_pts[:, 1], cache=class_cache)
    row_classes = [to_classes(v) for v in np.split(class_vals, len(rows))]
    if prob_ds is not None:
        prob_vals = sample_raster_points(prob_ds, all_pts[:, 0], all_pts[:, 1], cache=prob_cache)
        row_probs = list(np.split(prob_vals, len(rows)))
    else:
        row_probs = [None] * len(rows)

    line_classes = row_classes[0]
    stats, class_lengths, analyzed_pct, unanalyzed_km = line_length_stats(line_classes, step_len_all)
    corridor, probability = corridor_stats(rows, row_classes, row_probs, step_len_all, buffers_m)

    props = feature.get("properties") or {}
    result = {
        "name": props.get("Name"),
        "road_type": props.get("Road_Type"),
        "total_length_km": round(total_m / 1000.0, 2),
        "step_m": step_m,
        "analyzed_percentage": analyzed_pct,
        "unanalyzed_km": unanalyzed_km,
        "stats": stats,
        "class_lengths_km": class_lengths,
        "corridor": corridor,
        "probability": probability,
        "bounds": [
            [round(float(mids_all[:, 1].min()), 4), round(float(mids_all[:, 0].min()), 4)],
            [round(float(mids_all[:, 1].max()), 4), round(float(mids_all[:, 0].max()), 4)],
        ],
    }

    if include_geometry:
        result["segments"] = build_segments(parts, line_classes)
        result["buffer_polygons"] = {
            str(b): buffer_polygon_geojson(feature, b) for b in buffers_m
        }
    return result
