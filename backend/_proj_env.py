"""Neutralise a foreign PROJ installation leaking in via the process environment.

The PostgreSQL/PostGIS Windows installer sets PROJ_LIB and GDAL_DATA as *machine*
level environment variables pointing at its own PROJ 7-era data directory. Every
process on the box inherits them. rasterio's bundled GDAL honours PROJ_LIB when
it is set, so any EPSG lookup loads PostGIS's proj.db instead of the one shipped
in site-packages/rasterio/proj_data, and dies with:

    CRSError: The EPSG code is unknown. PROJ: proj_create_from_database:
    ...postgis-3.5\\proj\\proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2
    whereas a number >= 5 is expected. It comes from another PROJ installation.

Unsetting the variables makes rasterio fall back to its own bundled data, which
is the copy its GDAL was actually built against. We unset rather than repoint:
pyproj resolves its own data dir correctly today, and handing it rasterio's
proj.db via PROJ_DATA would be a different version skew.

`del os.environ[...]` calls unsetenv(), so the change reaches the C runtime that
PROJ reads at initialisation. This must therefore run before the first
`import rasterio` anywhere in the process — hence the import at the top of
`backend/__init__.py`, which every entry point passes through.
"""

import os

_FOREIGN_MARKERS = ("postgresql", "postgis")


def scrub():
    """Drop inherited PROJ/GDAL data-dir vars that point outside our venv."""
    removed = {}
    for var in ("PROJ_LIB", "PROJ_DATA", "GDAL_DATA"):
        value = os.environ.get(var)
        if not value:
            continue
        # Only strip values from a foreign install. A deliberately-set path (e.g.
        # a conda env's own share/proj) is left alone.
        if any(marker in value.lower() for marker in _FOREIGN_MARKERS):
            del os.environ[var]
            removed[var] = value
    return removed


_removed = scrub()

if _removed:
    for _var, _value in _removed.items():
        print(f"[proj_env] Ignoring inherited {_var}={_value} "
              f"(foreign PROJ install); using the copy bundled with rasterio.")
