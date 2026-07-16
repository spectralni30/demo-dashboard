"""
Generate the web map's National Highways overlay from the full-resolution
INDIA_NATIONAL_HIGHWAY.geojson.

The full dataset (~100 MB, ~2M vertices) cannot be rendered by a browser, so
this writes frontend/public/highways_overlay.json — merged per highway and
lightly simplified for DISPLAY ONLY. All analysis (lengths, corridor stats,
per-highway map segments) always runs on the full-resolution source; this
file is never used as an analysis input.

Usage:  python -m backend.make_highway_overlay [--tolerance 0.0001]
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import highway_lsm
from backend.precompute_highway_stats import HIGHWAYS_GEOJSON, PUBLIC_DIR

OVERLAY_OUT = os.path.join(PUBLIC_DIR, 'highways_overlay.json')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tolerance', type=float, default=1e-4,
                    help='display simplification tolerance in degrees (~11 m default)')
    args = ap.parse_args()

    from shapely.geometry import shape, mapping

    print(f"Source: {HIGHWAYS_GEOJSON}", flush=True)
    features = highway_lsm.load_highway_features(HIGHWAYS_GEOJSON)
    print(f"{len(features)} highways", flush=True)

    out_features = []
    for name in sorted(features):
        feat = features[name]
        geom = shape(feat['geometry']).simplify(args.tolerance, preserve_topology=False)
        gj = mapping(geom)
        gj = {
            'type': gj['type'],
            'coordinates': _round(gj['coordinates']),
        }
        out_features.append({
            'type': 'Feature',
            'properties': {'Name': name, 'Road_Type': feat['properties'].get('Road_Type')},
            'geometry': gj,
        })

    collection = {'type': 'FeatureCollection', 'features': out_features}
    with open(OVERLAY_OUT, 'w', encoding='utf-8') as f:
        json.dump(collection, f, separators=(',', ':'))
    print(f"Wrote {OVERLAY_OUT} ({os.path.getsize(OVERLAY_OUT) / 1e6:.1f} MB)")


def _round(obj, nd=5):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(v), nd) for v in obj]
        return [_round(v, nd) for v in obj]
    return obj


if __name__ == '__main__':
    main()
