"""SEBAL evapotranspiration for PhytoLens.

Ports the SEBAL surface-energy-balance model (daily actual ET, mm/day) —
``lambda*E = Rn - G0 - H`` — from the reference project
(``C:\\Users\\nites\\Downloads\\ET-main``) onto the webapp's plain-numpy EPSG:4326
bbox grid. The physics/equations are preserved verbatim; only the containers are
changed from the reference's xarray/UTM DataArrays to numpy arrays so the outputs
align with every other PhytoLens tool (which all work in EPSG:4326).

Data sources:
  * Landsat-9 C2-L2 surface reflectance + thermal ST_B10 — Microsoft Planetary
    Computer (no auth), read via ``read_landsat_sebal`` (a SEBAL-specific reader,
    NOT ``pc_handler.read_aligned_bands`` — see the note on that function below).
  * ERA5-Land hourly/daily meteorology — Copernicus CDS via ``cdsapi`` (needs a
    ``~/.cdsapirc`` key). ``cdsapi`` / ``xarray`` are imported lazily so this
    module still imports if those optional deps are absent.

This module is framework-agnostic: it raises plain ``ValueError``/exceptions with
clear messages; ``app.py`` maps them to HTTP responses.
"""

from __future__ import annotations

import datetime
import math
import os
import tempfile

import numpy as np
import planetary_computer
import rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin

from backend.pc_handler import GDAL_OPTS


# ---------------------------------------------------------------------------
# Physical constants (identical to the reference GEE notebook / config.py)
# ---------------------------------------------------------------------------
SIGMA = 5.67e-8        # Stefan-Boltzmann                [W m-2 K-4]
CP = 1004.0            # specific heat of air            [J kg-1 K-1]
LAMBDA_VAP = 2.45e6    # latent heat of vaporisation     [J kg-1]
K_VON = 0.41           # von Karman constant             [-]
G_GRAV = 9.81          # gravity                         [m s-2]

# FAO-56 reference-ET constants
GSC = 0.0820           # solar constant                  [MJ m-2 min-1]
SIGMA_DAY = 4.903e-9   # Stefan-Boltzmann (daily)        [MJ K-4 m-2 day-1]

# Landsat Collection-2 Level-2 scaling (USGS) — same literals used in
# pc_handler.calculate_index for consistency.
SR_SCALE, SR_OFFSET = 0.0000275, -0.2      # surface reflectance
ST_SCALE, ST_OFFSET = 0.00341802, 149.0    # surface temperature [K]

# Anchor-pixel selection thresholds
COLD_NDVI, COLD_ALB = 0.60, 0.10
HOT_NDVI = 0.20
HOT_ALB_LO, HOT_ALB_HI = 0.10, 0.35
# Minimum candidate pixels for an anchor class before falling back to a
# scene-relative (NDVI-quantile) selection instead of the fixed thresholds.
MIN_ANCHOR_PIXELS = 10

# Low->high = dry->wet (darkred -> orange -> yellow -> green -> navy). Registered
# in pc_handler.get_color_palette as "ET (Dry-Wet)".
ET_PALETTE = ["#8B0000", "#FF4500", "#FFFF00", "#00FF00", "#000080"]

DEFAULT_ELEV_M = 400.0   # AOI elevation for FAO-56 Rso when none supplied


# ===========================================================================
# Landsat 9 reader + surface parameters  (adapts sources.fetch_landsat9 +
# sources.surface_parameters to the webapp's EPSG:4326 grid)
# ===========================================================================
def _target_grid(bbox_wgs84, target_resolution=30):
    """Build the same EPSG:4326 grid pc_handler.read_aligned_bands uses.

    Keeps ET outputs pixel-aligned with the Leaflet bbox overlay exactly like
    every other tool. Returns (transform, (height, width)).
    """
    min_lon, min_lat, max_lon, max_lat = bbox_wgs84
    deg_per_meter = 1.0 / 111000.0
    deg_resolution = target_resolution * deg_per_meter

    width = int(np.ceil((max_lon - min_lon) / deg_resolution))
    height = int(np.ceil((max_lat - min_lat) / deg_resolution))
    width = max(10, min(width, 1500))
    height = max(10, min(height, 1500))

    pixel_w = (max_lon - min_lon) / width
    pixel_h = (max_lat - min_lat) / height
    transform = from_origin(min_lon, max_lat, pixel_w, pixel_h)
    return transform, (height, width)


def _read_asset(item, asset_name, transform, shape, resampling):
    """Reproject one signed STAC asset onto the target grid, NaN-preserving.

    Unlike pc_handler.read_aligned_bands this fills nodata with NaN (never 0)
    and lets the caller choose the resampling per band — essential for SEBAL,
    where the qa_pixel bitmask must use NEAREST and masked pixels must stay NaN.
    """
    href = planetary_computer.sign(item.assets[asset_name].href)
    dest = np.full(shape, np.nan, dtype=np.float32)
    with rasterio.open(href) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dest,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=transform,
            dst_crs="EPSG:4326",
            resampling=resampling,
            src_nodata=src.nodata,
            dst_nodata=np.nan,
        )
    return dest


def read_landsat_sebal(item, bbox_wgs84, target_resolution=30):
    """Surface parameters for one Landsat C2-L2 scene on the EPSG:4326 bbox grid.

    Returns (albedo, ndvi, lst[K], emissivity, transform, crs) as float32 numpy
    arrays with np.nan in masked / no-data cells.
    """
    transform, shape = _target_grid(bbox_wgs84, target_resolution)
    crs = "EPSG:4326"

    needed = ("blue", "green", "red", "nir08", "swir16", "swir22", "lwir11", "qa_pixel")
    missing = [b for b in needed if b not in item.assets]
    if missing:
        raise ValueError(
            f"Landsat scene {item.id} is missing band(s) required for SEBAL: "
            f"{', '.join(missing)}."
        )

    with rasterio.Env(**GDAL_OPTS):
        raw = {}
        for name in ("blue", "green", "red", "nir08", "swir16", "swir22", "lwir11"):
            raw[name] = _read_asset(item, name, transform, shape, Resampling.bilinear)
        qa = _read_asset(item, "qa_pixel", transform, shape, Resampling.nearest)

    albedo, ndvi, lst, emis = _surface_parameters(raw, qa)
    return albedo, ndvi, lst, emis, transform, crs


def _surface_parameters(raw, qa):
    """Albedo (Liang 2001), NDVI, LST[K], emissivity — water/cloud masked.

    Direct numpy port of sources.surface_parameters: xarray ``.where(cond)`` ->
    ``np.where(cond, val, np.nan)``; equations unchanged.
    """
    with np.errstate(invalid="ignore", divide="ignore"):
        qa_i = np.where(np.isnan(qa), 0, qa).astype(np.uint16)
        # USGS QA_PIXEL bits: 1=dilated cloud, 3=cloud shadow, 4=snow, 5=cloud.
        clear = (((qa_i & (1 << 1)) == 0) & ((qa_i & (1 << 3)) == 0)
                 & ((qa_i & (1 << 4)) == 0) & ((qa_i & (1 << 5)) == 0)
                 & ~np.isnan(qa))

        def sr(name):
            arr = raw[name]
            val = arr * SR_SCALE + SR_OFFSET
            return np.where((arr != 0) & ~np.isnan(arr) & clear, val, np.nan)

        b2, b3, b4 = sr("blue"), sr("green"), sr("red")
        b5, b6, b7 = sr("nir08"), sr("swir16"), sr("swir22")

        # Liang 2001 shortwave albedo — note the reference deliberately omits the
        # green band (b3): weights are on blue, red, nir, swir16, swir22.
        albedo = np.clip(0.356 * b2 + 0.130 * b4 + 0.373 * b5
                         + 0.085 * b6 + 0.072 * b7 - 0.018, 0.05, 0.90)
        ndvi = np.clip((b5 - b4) / (b5 + b4), -1.0, 1.0)
        mndwi = (b3 - b6) / (b3 + b6)
        non_water = mndwi < 0.0

        emis = np.where(ndvi >= 0.16,
                        1.009 + 0.047 * np.log(np.where(ndvi > 0, ndvi, 1e-6)),
                        np.where(ndvi > 0, 0.95, 0.92))
        emissivity = np.clip(emis, 0.90, 1.00)

        lst_raw = raw["lwir11"]
        lst = np.where((lst_raw != 0) & ~np.isnan(lst_raw) & clear,
                       lst_raw * ST_SCALE + ST_OFFSET, np.nan)

        keep = non_water & ~np.isnan(albedo)
        albedo = np.where(keep, albedo, np.nan)
        ndvi = np.where(keep, ndvi, np.nan)
        lst = np.where(keep, lst, np.nan)
        emissivity = np.where(keep, emissivity, np.nan)

    return (albedo.astype(np.float32), ndvi.astype(np.float32),
            lst.astype(np.float32), emissivity.astype(np.float32))


# ===========================================================================
# ERA5-Land -- Copernicus CDS  (ported near-verbatim from sources.py)
# ===========================================================================
def _cds_retrieve(variables, year, month, day, times, area):
    import cdsapi
    req = {"variable": variables, "year": year, "month": month, "day": day,
           "time": times, "area": area, "data_format": "netcdf",
           "download_format": "unarchived"}
    tmp = tempfile.NamedTemporaryFile(suffix=".nc", delete=False); tmp.close()
    cdsapi.Client().retrieve("reanalysis-era5-land", req, tmp.name)
    return tmp.name


def _pt(era, lat, lon):
    latn = "latitude" if "latitude" in era.coords else "lat"
    lonn = "longitude" if "longitude" in era.coords else "lon"
    return era.sel({latn: lat, lonn: lon}, method="nearest")


def fetch_era5land_overpass(lon, lat, date_str, hour=5):
    """Scalar overpass forcing for SEBAL (T, RH, pressure, wind, Rs/Rl down)."""
    import xarray as xr
    y, m, d = date_str.split("-")
    hour = max(1, int(hour))   # _cds_retrieve reads [hour-1, hour]; avoid -01:00
    area = [lat + 0.3, lon - 0.3, lat - 0.3, lon + 0.3]
    f = _cds_retrieve(
        ["2m_temperature", "2m_dewpoint_temperature", "10m_u_component_of_wind",
         "10m_v_component_of_wind", "surface_pressure",
         "surface_solar_radiation_downwards", "surface_thermal_radiation_downwards"],
        y, m, d, [f"{hour-1:02d}:00", f"{hour:02d}:00"], area)
    era = xr.open_dataset(f)
    tname = "valid_time" if "valid_time" in era.coords else "time"
    pt = _pt(era, lat, lon)
    at = lambda n, i: float(pt[n].isel({tname: i}).values)

    T_air_K, Td_K = at("t2m", -1), at("d2m", -1)
    u10, v10, pressure = at("u10", -1), at("v10", -1), at("sp", -1)
    Rs_down = max((at("ssrd", -1) - at("ssrd", 0)) / 3600.0, 0.0)
    Rl_down = max((at("strd", -1) - at("strd", 0)) / 3600.0, 0.0)
    era.close()
    try:
        os.unlink(f)
    except OSError:
        pass

    T_air_C, Td_C = T_air_K - 273.15, Td_K - 273.15
    e_act = 0.6108 * math.exp(17.27 * Td_C / (Td_C + 237.3))
    e_sat = 0.6108 * math.exp(17.27 * T_air_C / (T_air_C + 237.3))
    return dict(T_air_K=T_air_K, T_air_C=T_air_C, RH_pct=100.0 * e_act / e_sat,
                pressure=pressure, wind_speed=math.hypot(u10, v10),
                Rs_down=Rs_down, Rl_down=Rl_down, e_act=e_act)


def fetch_era5land_daily(lon, lat, date_str):
    """Daily aggregates for FAO-56 ET0 (Tmax/min/mean, dewpoint, wind, P, Rs)."""
    import xarray as xr
    y, m, d = date_str.split("-")
    area = [lat + 0.3, lon - 0.3, lat - 0.3, lon + 0.3]
    f = _cds_retrieve(
        ["2m_temperature", "2m_dewpoint_temperature", "10m_u_component_of_wind",
         "10m_v_component_of_wind", "surface_pressure",
         "surface_solar_radiation_downwards"],
        y, m, d, [f"{h:02d}:00" for h in range(24)], area)
    era = xr.open_dataset(f)
    pt = _pt(era, lat, lon)
    t2m = pt["t2m"].values - 273.15
    ssrd = pt["ssrd"].values.astype(float)
    inc = np.diff(ssrd)
    daily = dict(
        Tmax=float(np.nanmax(t2m)), Tmin=float(np.nanmin(t2m)),
        Tmean=float(np.nanmean(t2m)),
        Tdew=float(np.nanmean(pt["d2m"].values - 273.15)),
        u10=float(np.nanmean(np.hypot(pt["u10"].values, pt["v10"].values))),
        P_kPa=float(np.nanmean(pt["sp"].values)) / 1000.0,
        Rs_MJ=float(inc[inc > 0].sum()) / 1e6)
    era.close()
    try:
        os.unlink(f)
    except OSError:
        pass
    return daily


# ===========================================================================
# SEBAL energy balance + daily ETa  (adapts model.py to numpy)
# ===========================================================================
def esat(Tc):
    """Saturation vapour pressure [kPa] at temperature Tc [C]."""
    return 0.6108 * math.exp(17.27 * Tc / (Tc + 237.3))


def air_scalars(met):
    """Air density and friction velocity from ERA5 overpass scalars."""
    Tv = met["T_air_K"] / (1.0 - 0.378 * (met["e_act"] * 1000.0) / met["pressure"])
    rho_air = met["pressure"] / (287.058 * Tv)
    u200 = met["wind_speed"] * math.log(200.0 / 0.1) / math.log(10.0 / 0.1)
    u_star = K_VON * u200 / math.log(200.0 / 0.1)
    return rho_air, u200, u_star


def net_radiation_and_soil_flux(albedo, ndvi, lst, emissivity, met):
    """Step 4 -- net radiation Rn and soil heat flux G0 (numpy)."""
    Rs_down, Rl_down = met["Rs_down"], met["Rl_down"]
    with np.errstate(invalid="ignore", divide="ignore"):
        Rl_up = emissivity * SIGMA * lst ** 4
        Rn = np.clip((1 - albedo) * Rs_down + Rl_down - Rl_up
                     - (1 - emissivity) * Rl_down, 0, None)

        lst_C = lst - 273.15
        ndvi_a = np.abs(ndvi) + 0.001
        G0 = np.clip((lst_C / albedo) * (0.0038 * albedo + 0.0074 * albedo ** 2)
                     * (1 - 0.98 * ndvi_a ** 4) * Rn, 0, None)
        G0 = np.minimum(G0, 0.5 * Rn)   # cap at 50% of Rn
    return Rn, G0


def stability_loop(lst_v, H, hot_zone, T_cold, T_hot, H_hot, rc,
                   u200, u_star, T_air_K, max_iter=10, tol=1e-2):
    """Monin-Obukhov stability solver (ported verbatim from model.py)."""
    log_z = math.log(200.0 / 0.1)
    r_hot_prev = None
    n_iter = 0
    for n_iter in range(1, max_iter + 1):
        L = (-rc * u_star ** 3 * T_air_K) / (H * K_VON * G_GRAV + 1e-6)
        arg = 1.0 - 32.0 / L                       # (1 - 16*z/L), z=2
        x = np.power(np.where(arg > 0, arg, 1.0), 0.25)

        psi_h_u = 2.0 * np.log((x ** 2 + 1.0) / 2.0)
        psi_h_s = -10.0 / L                        # -5*z/L, z=2
        psi_h = np.where(L > 0, psi_h_s, psi_h_u)

        psi_m_u = (2.0 * np.log((x + 1.0) / 2.0)
                   + np.log((x ** 2 + 1.0) / 2.0)
                   - 2.0 * np.arctan(x) + math.pi / 2.0)
        psi_m_s = -1000.0 / L                      # -5*z/L, z=200
        psi_m = np.where(L > 0, psi_m_s, psi_m_u)

        u_star = np.clip(K_VON * u200 / (log_z - psi_m), 0.05, 5.0)
        r_ah_c = np.clip((math.log(2.0 / 0.1) - psi_h) / (u_star * K_VON),
                         10.0, 500.0)

        r_hot = max(np.nanmean(r_ah_c[hot_zone]), 10.0)
        dT_hot = H_hot * r_hot / rc
        a = dT_hot / (T_hot - T_cold)
        b = -a * T_cold
        dT = np.maximum(lst_v * a + b, 0.0)
        H = dT * rc / r_ah_c

        if r_hot_prev is not None and abs(r_hot - r_hot_prev) <= tol * r_hot_prev:
            break
        r_hot_prev = r_hot

    return H, n_iter


def _select_anchors(ndvi_v, alb_v, lst_v):
    """Pick the SEBAL cold (well-watered veg) and hot (dry/bare) anchor temps.

    Two-stage, scene-adaptive selection so SEBAL works beyond lush scenes:

      1. STRICT (reference thresholds): cold = NDVI>COLD_NDVI & albedo>COLD_ALB,
         hot = NDVI<HOT_NDVI & HOT_ALB_LO<albedo<HOT_ALB_HI. Used when each class
         has >= MIN_ANCHOR_PIXELS candidates, so well-vegetated scenes behave
         exactly like the reference.
      2. RELATIVE (fallback): when a class is too sparse, derive it from the
         scene's own NDVI distribution — cold = greenest decile (top 10% NDVI),
         hot = barest quartile (bottom 25% NDVI) — and take the coolest/hottest
         pixels within (5th/95th LST percentile). This is the standard way to
         auto-pick anchors; it uses the real pixel population, not invented values.

    Returns (T_cold, T_hot, cold_method, hot_method). Raises ValueError only when
    the scene genuinely lacks the vegetation or thermal contrast SEBAL needs.
    """
    finite = np.isfinite(lst_v) & np.isfinite(ndvi_v) & np.isfinite(alb_v)
    if np.count_nonzero(finite) < MIN_ANCHOR_PIXELS:
        raise ValueError(
            "SEBAL anchor selection failed: too few valid (cloud/water-free) "
            "pixels in the area. Enlarge the ROI or choose a clearer scene.")
    ndvi_finite = ndvi_v[finite]

    # --- cold anchor: coolest well-watered vegetation ----------------------
    cold_strict = finite & (ndvi_v > COLD_NDVI) & (alb_v > COLD_ALB)
    if np.count_nonzero(cold_strict) >= MIN_ANCHOR_PIXELS:
        T_cold = float(np.percentile(lst_v[cold_strict], 5))
        cold_method = "strict"
    else:
        ndvi_hi = float(np.percentile(ndvi_finite, 90))      # greenest decile
        cold_rel = finite & (ndvi_v >= ndvi_hi)
        if np.count_nonzero(cold_rel) < MIN_ANCHOR_PIXELS or ndvi_hi <= 0.10:
            raise ValueError(
                "SEBAL cold-anchor selection failed: the scene has too little "
                "vegetation (max NDVI %.2f) for a well-watered reference pixel. "
                "Choose an area/scene that includes some green vegetation."
                % float(np.nanmax(ndvi_finite)))
        T_cold = float(np.percentile(lst_v[cold_rel], 5))
        cold_method = "relative"

    # --- hot anchor: hottest dry / bare ground -----------------------------
    hot_strict = finite & (ndvi_v < HOT_NDVI) & (alb_v > HOT_ALB_LO) & (alb_v < HOT_ALB_HI)
    if np.count_nonzero(hot_strict) >= MIN_ANCHOR_PIXELS:
        T_hot = float(np.percentile(lst_v[hot_strict], 95))
        hot_method = "strict"
    else:
        ndvi_lo = float(np.percentile(ndvi_finite, 25))      # barest quartile
        hot_rel = finite & (ndvi_v <= ndvi_lo)
        if np.count_nonzero(hot_rel) < MIN_ANCHOR_PIXELS:
            raise ValueError(
                "SEBAL hot-anchor selection failed: no dry/bare reference pixels "
                "found. Enlarge the ROI to include some bare or sparsely "
                "vegetated ground.")
        T_hot = float(np.percentile(lst_v[hot_rel], 95))
        hot_method = "relative"

    if T_hot - T_cold < 1.0:
        raise ValueError(
            "SEBAL anchor calibration failed: hot (%.1f°C) and cold (%.1f°C) "
            "anchors lack thermal contrast (need ~1°C+). The area is too "
            "thermally uniform — enlarge the ROI or use a clearer, drier scene."
            % (T_hot - 273.15, T_cold - 273.15))

    return T_cold, T_hot, cold_method, hot_method


def sensible_heat(lst, ndvi, albedo, Rn, G0, met, rho_air, u200, u_star):
    """Step 5 -- hot/cold anchor calibration + Monin-Obukhov stability loop.

    Inputs are numpy arrays. Anchors are chosen scene-adaptively by
    ``_select_anchors`` (fixed reference thresholds, with an NDVI-quantile
    fallback for less-vegetated scenes). Raises ValueError on a genuine anchor
    failure so the endpoint can return an actionable 400.
    """
    lst_v, ndvi_v, alb_v = lst, ndvi, albedo
    T_cold, T_hot, cold_method, hot_method = _select_anchors(ndvi_v, alb_v, lst_v)

    hot_zone = lst_v >= 0.995 * T_hot
    Rn_hot = max(np.nanmean(Rn[hot_zone]), 0.0)
    G0_hot = max(np.nanmean(G0[hot_zone]), 0.0)
    H_hot = max(Rn_hot - G0_hot, 10.0)

    rc = rho_air * CP
    r_ah = max(math.log(2.0 / 0.1) / (u_star * K_VON), 10.0)
    dT_hot = H_hot * r_ah / rc
    a = dT_hot / (T_hot - T_cold)
    b = -a * T_cold
    dT = np.maximum(lst_v * a + b, 0.0)
    H = dT * rc / r_ah

    H, n_iter = stability_loop(lst_v, H, hot_zone, T_cold, T_hot, H_hot, rc,
                               u200, u_star, met["T_air_K"])

    H = np.clip(H, 0, 700)
    anchors = dict(T_cold=T_cold, T_hot=T_hot, H_hot=H_hot, n_iter=n_iter,
                   cold_method=cold_method, hot_method=hot_method)
    return H, anchors


def daily_eta(Rn, G0, H, albedo, lat_deg, doy):
    """Step 6 -- evaporative fraction conserved to 24h net radiation -> ETa."""
    with np.errstate(invalid="ignore", divide="ignore"):
        LE_avail = Rn - G0
        LE_inst = LE_avail - H
        denom = np.where(np.abs(LE_avail) >= 1, LE_avail, 1.0)
        Lambda = np.clip(LE_inst / denom, 0.0, 1.0)

        lat_rad = math.radians(lat_deg)
        delta = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
        dr = 1.0 + 0.033 * math.cos(2 * math.pi * doy / 365)
        ws = math.acos(-math.tan(lat_rad) * math.tan(delta))
        Ra_24 = (24 * 60 / math.pi * GSC) * dr * (
            ws * math.sin(lat_rad) * math.sin(delta)
            + math.cos(lat_rad) * math.cos(delta) * math.sin(ws))
        Rs_24 = 0.75 * Ra_24
        Rn_24 = np.clip((1 - albedo) * Rs_24 / 0.0864 - 110.0 * 0.75, 0, None)

        ETa = np.clip(Lambda * Rn_24 * 86400.0 / LAMBDA_VAP, 0.0, 15.0)
    return ETa.astype(np.float32)


def fao56_et0(daily, lat_deg, doy, elev_m):
    """FAO-56 Penman-Monteith reference ET0 [mm/day] (ported verbatim)."""
    Tmax, Tmin, Tmean = daily["Tmax"], daily["Tmin"], daily["Tmean"]
    Tdew, u10, P, Rs = daily["Tdew"], daily["u10"], daily["P_kPa"], daily["Rs_MJ"]

    u2 = u10 * 4.87 / math.log(67.8 * 10 - 5.42)
    ea = esat(Tdew)
    es = (esat(Tmax) + esat(Tmin)) / 2.0
    Delta = 4098 * esat(Tmean) / (Tmean + 237.3) ** 2
    gamma = 0.000665 * P

    phi = math.radians(lat_deg)
    dr = 1 + 0.033 * math.cos(2 * math.pi / 365 * doy)
    dec = 0.409 * math.sin(2 * math.pi / 365 * doy - 1.39)
    ws = math.acos(-math.tan(phi) * math.tan(dec))
    Ra = 24 * 60 / math.pi * GSC * dr * (
        ws * math.sin(phi) * math.sin(dec)
        + math.cos(phi) * math.cos(dec) * math.sin(ws))
    Rso = (0.75 + 2e-5 * elev_m) * Ra
    Rns = (1 - 0.23) * Rs
    Rnl = (SIGMA_DAY * (((Tmax + 273.16) ** 4 + (Tmin + 273.16) ** 4) / 2)
           * (0.34 - 0.14 * math.sqrt(ea)) * (1.35 * min(Rs / Rso, 1.0) - 0.35))
    Rn = Rns - Rnl

    ET0 = ((0.408 * Delta * Rn + gamma * 900 / (Tmean + 273) * u2 * (es - ea))
           / (Delta + gamma * (1 + 0.34 * u2)))
    return dict(ET0=ET0, Tmean=Tmean, u2=u2, Rs=Rs, Rn=Rn, VPD=es - ea)


# ===========================================================================
# High-level pipelines
# ===========================================================================
def run_sebal_single(item, bbox_wgs84, lon, lat, date_str, hour,
                     elev_m=DEFAULT_ELEV_M, with_et0=True):
    """Full SEBAL for one scene (mirrors run.py::compute).

    Returns a dict with the ETa grid, its (transform, crs), anchors, the ERA5
    overpass met scalars, and — when ``with_et0`` — the FAO-56 ET0 reference and
    implied crop coefficient Kc = mean(ETa)/ET0.

    Raises ValueError on anchor failure; propagates CDS/read errors to the caller.
    """
    albedo, ndvi, lst, emis, transform, crs = read_landsat_sebal(item, bbox_wgs84)

    met = fetch_era5land_overpass(lon, lat, date_str, hour)
    rho, u200, u_star = air_scalars(met)

    Rn, G0 = net_radiation_and_soil_flux(albedo, ndvi, lst, emis, met)
    H, anchors = sensible_heat(lst, ndvi, albedo, Rn, G0, met, rho, u200, u_star)

    doy = datetime.datetime.strptime(date_str, "%Y-%m-%d").timetuple().tm_yday
    eta = daily_eta(Rn, G0, H, albedo, lat, doy)

    et0 = kc = None
    if with_et0:
        try:
            daily = fetch_era5land_daily(lon, lat, date_str)
            et0 = fao56_et0(daily, lat, doy, elev_m)
            mean_eta = float(np.nanmean(eta))
            if et0["ET0"] and et0["ET0"] > 0 and np.isfinite(mean_eta):
                kc = mean_eta / et0["ET0"]
        except Exception as exc:   # ET0 is a bonus rail; never fail the ETa run
            print(f"[sebal] FAO-56 ET0 skipped: {exc!r}")

    return {
        "eta": eta, "transform": transform, "crs": crs,
        "anchors": anchors, "met": met, "et0": et0, "kc": kc,
        "Rn": Rn, "G0": G0, "H": H, "ndvi": ndvi, "lst": lst, "albedo": albedo,
    }
