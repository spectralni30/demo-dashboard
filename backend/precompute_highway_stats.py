"""
Precompute National Highway-wise landslide susceptibility statistics.

Mirrors the district precompute pattern: the frontend serves these JSON files
directly so the deployed app never needs the (huge, local-only) LSM rasters.

Outputs
-------
frontend/public/highway_stats.json
    One entry per highway with lengths, per-class stats for every buffer
    width, probability stats and bounds (no geometry — kept small).
frontend/public/highway_segments/{SANITIZED_NAME}.json
    Per-highway class-coloured centreline segments + simplified buffer
    polygons for the interactive map.

Usage:  python -m backend.precompute_highway_stats [--limit N]
Requires the full-resolution rasters (see LSM_CLASS_FULL_TIF /
LSM_PROBABILITY_TIF env vars, default S:\\LSM\\).
"""

import argparse
import json
import os
import re
import sys
import time
from collections import OrderedDict

import rasterio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import highway_lsm

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(BASE_DIR)
PUBLIC_DIR = os.path.join(REPO_DIR, 'frontend', 'public')

# Analysis must run on the full-resolution NH dataset only — never on a
# simplified/downscaled copy (it understates lengths on winding mountain roads).
HIGHWAYS_GEOJSON = os.environ.get(
    'HIGHWAYS_GEOJSON',
    os.path.join(REPO_DIR, 'INDIA_NATIONAL_HIGHWAY.geojson')
)
STATS_OUT = os.path.join(PUBLIC_DIR, 'highway_stats.json')
SEGMENTS_DIR = os.path.join(PUBLIC_DIR, 'highway_segments')

CLASS_TIF = os.environ.get('LSM_CLASS_FULL_TIF', 'S:\\LSM\\class.tif')
PROB_TIF = os.environ.get('LSM_PROBABILITY_TIF', 'S:\\LSM\\probability.tif')


def sanitize(name):
    return re.sub(r'[^a-zA-Z0-9]', '_', str(name))


def centroid_key(feature):
    """Coarse geographic bucket so consecutive highways share raster tiles."""
    try:
        parts = list(highway_lsm._line_parts(feature))
        lon = sum(p[:, 0].mean() for p in parts) / len(parts)
        lat = sum(p[:, 1].mean() for p in parts) / len(parts)
        return (round(lat), round(lon / 2.0), lon)
    except Exception:
        return (0, 0, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='only process first N highways (smoke test)')
    args = ap.parse_args()

    class_ds = rasterio.open(CLASS_TIF)
    prob_ds = rasterio.open(PROB_TIF)
    print(f"Highway source: {HIGHWAYS_GEOJSON}", flush=True)
    features = highway_lsm.load_highway_features(HIGHWAYS_GEOJSON)
    print(f"{len(features)} unique highways", flush=True)
    os.makedirs(SEGMENTS_DIR, exist_ok=True)

    names = sorted(features.keys(), key=lambda n: centroid_key(features[n]))
    if args.limit:
        names = names[:args.limit]

    # Filenames must be unique case-insensitively (Windows FS) — the dataset
    # has case-variant names like "NH 752I" vs "NH 752i", so collisions get a
    # numeric suffix. The chosen filename is stored on each stats entry
    # ("seg") so the frontend never has to re-derive it.
    seg_files = {}
    used_lower = set()
    for n in names:
        fname = f"{sanitize(n)}.json"
        k = fname.lower()
        suffix = 2
        while k in used_lower:
            fname = f"{sanitize(n)}_{suffix}.json"
            k = fname.lower()
            suffix += 1
        used_lower.add(k)
        seg_files[n] = fname

    class_cache = OrderedDict()
    prob_cache = OrderedDict()
    stats_entries = []
    failures = []
    seg_bytes_total = 0
    t0 = time.time()

    for i, name in enumerate(names):
        try:
            r = highway_lsm.analyze_highway(
                features[name], class_ds, prob_ds,
                class_cache=class_cache, prob_cache=prob_cache,
            )
        except Exception as e:
            failures.append((name, str(e)))
            print(f"[{i + 1}/{len(names)}] FAILED {name}: {e}", flush=True)
            continue

        seg_payload = {
            'name': r['name'],
            'step_m': r['step_m'],
            'segments': r.pop('segments'),
            'buffer_polygons': r.pop('buffer_polygons'),
        }
        seg_path = os.path.join(SEGMENTS_DIR, seg_files[name])
        with open(seg_path, 'w', encoding='utf-8') as f:
            json.dump(seg_payload, f, separators=(',', ':'))
        seg_bytes_total += os.path.getsize(seg_path)

        r['seg'] = seg_files[name]
        stats_entries.append(r)

        if (i + 1) % 25 == 0 or i + 1 == len(names):
            dt = time.time() - t0
            print(f"[{i + 1}/{len(names)}] {name}  ({dt:.0f}s elapsed, "
                  f"segments total {seg_bytes_total / 1e6:.1f} MB)", flush=True)

    stats_entries.sort(key=lambda e: str(e['name']))
    with open(STATS_OUT, 'w', encoding='utf-8') as f:
        json.dump(stats_entries, f, separators=(',', ':'))

    print(f"\nDone in {time.time() - t0:.0f}s: {len(stats_entries)} highways, "
          f"{len(failures)} failures.")
    print(f"stats file: {STATS_OUT} ({os.path.getsize(STATS_OUT) / 1e6:.1f} MB)")
    print(f"segments dir total: {seg_bytes_total / 1e6:.1f} MB")
    for name, err in failures:
        print(f"  FAILED: {name}: {err}")


if __name__ == '__main__':
    main()
