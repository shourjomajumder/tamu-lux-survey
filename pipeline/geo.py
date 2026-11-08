"""Shared geometry: camera rays from phone attitude, local metric coordinates."""
import math
import numpy as np

LAT0, LON0 = 30.6150, -96.3400          # local origin (A&M main campus)
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT0))


def to_xy(lat, lon):
    return (np.asarray(lon, float) - LON0) * M_LON, (np.asarray(lat, float) - LAT0) * M_LAT


def to_ll(x, y):
    return LAT0 + np.asarray(y, float) / M_LAT, LON0 + np.asarray(x, float) / M_LON


def qmat(qw, qx, qy, qz):
    w, x, y, z = qw, qx, qy, qz
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def pixel_ray(row, u, v, img_w_portrait):
    """Bearing (deg from north) and elevation (deg) of a portrait-image pixel.
    Device frame: back camera looks along -Z, portrait right=+X, up=+Y.
    Reference frame (CoreMotion xTrueNorthZVertical): x=north, y=west, z=up.
    Verified against logged heading (median error ~1.4 deg)."""
    f = float(row.get("fy_px") or row.get("fx_px") or 1400)
    cxp = img_w_portrait - 1 - float(row.get("cy_px") or img_w_portrait / 2)
    cyp = float(row.get("cx_px") or 960)
    d_dev = np.array([(u - cxp) / f, (cyp - v) / f, -1.0])
    d_dev /= np.linalg.norm(d_dev)
    try:
        R = qmat(*(float(row[k]) for k in ("qw", "qx", "qy", "qz")))
        d = R @ d_dev
        bearing = math.degrees(math.atan2(-d[1], d[0])) % 360
        elev = math.degrees(math.asin(max(-1.0, min(1.0, d[2]))))
    except (KeyError, ValueError, TypeError):
        bearing = (float(row.get("heading_deg") or 0) + math.degrees(math.atan((u - cxp) / f))) % 360
        elev = math.degrees(math.atan((cyp - v) / f))
    return bearing, elev


def cct_from_rgb(r, g, b):
    """Approximate correlated colour temperature (K) from mean sRGB (0-255) via McCamy."""
    def lin(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    R, G, B = lin(r), lin(g), lin(b)
    X = 0.4124 * R + 0.3576 * G + 0.1805 * B
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
    Z = 0.0193 * R + 0.1192 * G + 0.9505 * B
    s = X + Y + Z
    if s <= 0:
        return None
    x, y = X / s, Y / s
    n = (x - 0.3320) / (0.1858 - y)
    cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33
    return int(max(1500, min(10000, cct)))
