"""Build public/maps/admin-2/{ISO}.geojson from Overture Maps division areas.

Usage: python scripts/build-admin2-boundaries.py <overture-release> <output-directory> [ISO,ISO,...]
Needs duckdb with the httpfs and spatial extensions; reads the public Overture bucket.
"""
import json
import pathlib
import sys

import duckdb

COUNTRIES = ["US", "CA", "MX", "DE", "FR", "IT", "ES", "NL", "TW", "AU", "BR", "SG", "GB", "RU", "KR", "ZA", "TR",
             "PH", "IN", "MY", "HK", "TH", "JP", "VN", "SA", "NG", "CN"]
# Second-order units are Overture counties; Brazil models its municipalities as localities.
SUBTYPE = {"BR": "locality"}
# Simplification tolerance in degrees; continental countries need less detail at the zooms the dashboard reaches.
TOLERANCE = {"US": 0.02, "CA": 0.03, "RU": 0.04, "BR": 0.02, "AU": 0.03, "CN": 0.02, "IN": 0.015, "MX": 0.015}
DEFAULT_TOLERANCE = 0.008

release, output = sys.argv[1], pathlib.Path(sys.argv[2])
countries = sys.argv[3].split(",") if len(sys.argv) > 3 else COUNTRIES
output.mkdir(parents=True, exist_ok=True)
connection = duckdb.connect()
connection.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'")
source = (f"read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division_area/*', "
          "hive_partitioning=1)")


def ring(points):
    rounded = []
    for longitude, latitude in points:
        point = [round(longitude, 3), round(latitude, 3)]
        if not rounded or rounded[-1] != point:
            rounded.append(point)
    return rounded if len(rounded) >= 4 else None


def polygon(rings):
    outer = ring(rings[0])
    if not outer:
        return None
    return [outer] + [inner for inner in map(ring, rings[1:]) if inner]


for country in countries:
    tolerance = TOLERANCE.get(country, DEFAULT_TOLERANCE)
    rows = connection.execute(f"""
        SELECT names."primary", coalesce(names.common['en'], ''), coalesce(region, ''),
          ST_AsGeoJSON(ST_SimplifyPreserveTopology(geometry, {tolerance}))
        FROM {source}
        WHERE country = ? AND subtype = ? AND class = 'land' AND names."primary" IS NOT NULL
        ORDER BY region, names."primary", id""", [country, SUBTYPE.get(country, "county")]).fetchall()
    features = []
    for name, english, region, geometry in rows:
        shape = json.loads(geometry)
        polygons = [shape["coordinates"]] if shape["type"] == "Polygon" else shape["coordinates"] \
            if shape["type"] == "MultiPolygon" else []
        kept = [value for value in map(polygon, polygons) if value]
        if not kept:
            continue
        features.append({
            "type": "Feature",
            "properties": {"country_code": country, "region_code": region, "name": english or name, "native_name": name},
            "geometry": {"type": "MultiPolygon", "coordinates": kept}
        })
    target = output / f"{country}.geojson"
    if not features:
        target.unlink(missing_ok=True)
        print(country, "no second-order units")
        continue
    target.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False,
                                 separators=(",", ":")) + "\n", encoding="utf-8")
    print(country, len(features), target.stat().st_size)
