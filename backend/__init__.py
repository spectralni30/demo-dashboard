"""Backend package."""

# Must precede any import that pulls in rasterio: PROJ reads its data-dir env
# vars once, at C-library init. See _proj_env for the full story.
from backend import _proj_env  # noqa: F401  (imported for its import-time effect)
