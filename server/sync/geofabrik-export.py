import argparse
import hashlib
import heapq
import json
import math
import pathlib

import osmium
from osmium.filter import KeyFilter


RESIDENTIAL_BUILDINGS = {
    "apartments", "bungalow", "cabin", "detached", "dormitory", "ger",
    "house", "residential", "semidetached_house", "terrace"
}


def rank(value):
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:8], 16)


def point_in_ring(longitude, latitude, ring):
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous[:2]
        x2, y2 = current[:2]
        if (y1 > latitude) != (y2 > latitude):
            crossing = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < crossing:
                inside = not inside
        previous = current
    return inside


def polygons_from_geojson(path):
    if not path:
        return []
    document = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    features = document.get("features", [document]) if document.get("type") == "FeatureCollection" else [document]
    polygons = []
    def ring_bbox(ring):
        longitudes = [point[0] for point in ring]
        latitudes = [point[1] for point in ring]
        return min(longitudes), min(latitudes), max(longitudes), max(latitudes)
    for feature in features:
        geometry = feature.get("geometry", feature)
        if geometry.get("type") == "Polygon":
            rings = geometry["coordinates"]
            polygons.append((ring_bbox(rings[0]), rings[0], [(ring_bbox(ring), ring) for ring in rings[1:]]))
        elif geometry.get("type") == "MultiPolygon":
            for rings in geometry["coordinates"]:
                polygons.append((ring_bbox(rings[0]), rings[0], [(ring_bbox(ring), ring) for ring in rings[1:]]))
    return polygons


class AddressSampler:
    def __init__(self, max_records, per_locality, polygons, exclude_polygons=None):
        self.max_records = max_records
        self.per_locality = per_locality
        self.maximum_groups = min(max_records, max(1, math.ceil(max_records / 10)))
        self.group_limit = max(1, min(per_locality, max_records))
        self.residential_limit = min(max_records, 1000)
        self.polygons = polygons
        self.exclude_polygons = exclude_polygons or []
        self.groups = {}
        self.group_heap = []
        self.residential = []

    @staticmethod
    def _inside(longitude, latitude, polygons):
        return any(
            minimum_longitude <= longitude <= maximum_longitude
            and minimum_latitude <= latitude <= maximum_latitude
            and point_in_ring(longitude, latitude, outer)
            and not any(
                hole_bbox[0] <= longitude <= hole_bbox[2]
                and hole_bbox[1] <= latitude <= hole_bbox[3]
                and point_in_ring(longitude, latitude, hole)
                for hole_bbox, hole in holes
            )
            for (minimum_longitude, minimum_latitude, maximum_longitude, maximum_latitude), outer, holes in polygons
        )

    def inside_boundary(self, longitude, latitude):
        if self.exclude_polygons and self._inside(longitude, latitude, self.exclude_polygons):
            return False
        if not self.polygons:
            return True
        return self._inside(longitude, latitude, self.polygons)

    def capture(self, object_type, object_id, tags, longitude, latitude):
        house_number = tags.get("addr:housenumber", "").strip()
        street = (tags.get("addr:street") or tags.get("addr:place") or "").strip()
        if not house_number or not street:
            return
        if not self.inside_boundary(longitude, latitude):
            return
        locality = next((tags.get(key, "").strip() for key in (
            "addr:city", "addr:town", "addr:village", "addr:municipality", "addr:place", "addr:postcode"
        ) if tags.get(key, "").strip()), "")
        record_id = f"{object_type}/{object_id}"
        record_rank = rank(record_id)
        building = tags.get("building", "").strip().casefold()
        is_residential = building in RESIDENTIAL_BUILDINGS
        group_key = locality.casefold() if locality else f"grid:{math.floor(longitude * 10)}:{math.floor(latitude * 10)}"
        group = self.groups.get(group_key)
        if group is None:
            group_rank = rank(group_key)
            accept_group = True
            if len(self.groups) >= self.maximum_groups:
                while self.group_heap and (
                    self.group_heap[0][1] not in self.groups
                    or self.groups[self.group_heap[0][1]]["rank"] != -self.group_heap[0][0]
                ):
                    heapq.heappop(self.group_heap)
                worst_rank, worst_key = (-self.group_heap[0][0], self.group_heap[0][1]) if self.group_heap else (-1, "")
                if group_rank >= worst_rank:
                    accept_group = False
                else:
                    del self.groups[worst_key]
            if accept_group:
                group = {"rank": group_rank, "records": []}
                self.groups[group_key] = group
                heapq.heappush(self.group_heap, (-group_rank, group_key))
        if group is None and not is_residential:
            return
        properties = {"@type": object_type, "@id": f"{object_type}/{object_id}"}
        for key in (
            "addr:housenumber", "addr:street", "addr:state", "addr:province", "addr:city",
            "addr:town", "addr:village", "addr:municipality", "addr:place", "addr:district",
            "addr:suburb", "addr:county", "addr:postcode", "addr:unit", "addr:flats",
            "addr:country", "name", "building"
        ):
            if key in tags:
                properties[key] = tags[key]
        record = json.dumps({
            "type": "Feature",
            "id": record_id,
            "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
            "properties": properties
        }, ensure_ascii=False, separators=(",", ":"))
        if group is not None:
            group["records"].append((record_rank, record))
            group["records"].sort(key=lambda item: item[0])
            del group["records"][self.group_limit:]
        if is_residential:
            candidate = (-record_rank, record_id, record)
            if len(self.residential) < self.residential_limit:
                heapq.heappush(self.residential, candidate)
            elif record_rank < -self.residential[0][0]:
                heapq.heapreplace(self.residential, candidate)

    def node(self, node):
        if not node.location.valid():
            return
        self.capture(
            "node", node.id, {tag.k: tag.v for tag in node.tags},
            node.location.lon, node.location.lat
        )

    def way(self, way):
        tags = {tag.k: tag.v for tag in way.tags}
        if not tags.get("addr:housenumber") or not (tags.get("addr:street") or tags.get("addr:place")):
            return
        locations = [node.location for node in way.nodes if node.location.valid()]
        if not locations:
            return
        self.capture(
            "way", way.id, tags,
            sum(location.lon for location in locations) / len(locations),
            sum(location.lat for location in locations) / len(locations)
        )

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--boundary")
parser.add_argument("--exclude-boundary", action="append", default=[])
parser.add_argument("--max-records", required=True, type=int)
parser.add_argument("--per-locality", required=True, type=int)
parser.add_argument("--communities-file")
args = parser.parse_args()

# Named residential communities: landuse=residential ways and
# place=neighbourhood/quarter nodes. Collected alongside addresses in the same
# streaming pass; boundary/exclusion polygons apply identically.
COMMUNITY_PLACE_TYPES = {"neighbourhood", "quarter"}
COMMUNITY_LIMIT = 200_000

class CommunityCollector:
    def __init__(self, sampler):
        self.sampler = sampler
        self.records = {}

    def add(self, name, longitude, latitude):
        name = (name or "").strip()
        if not name or len(self.records) >= COMMUNITY_LIMIT:
            return
        if not self.sampler.inside_boundary(longitude, latitude):
            return
        key = f"{name}:{round(longitude * 200)}:{round(latitude * 200)}"
        if key in self.records:
            return
        self.records[key] = json.dumps(
            {"name": name, "longitude": round(longitude, 6), "latitude": round(latitude, 6)},
            ensure_ascii=False, separators=(",", ":")
        )

    def node(self, node, tags):
        if tags.get("place") in COMMUNITY_PLACE_TYPES and node.location.valid():
            self.add(tags.get("name"), node.location.lon, node.location.lat)

    def way(self, way, tags):
        if tags.get("landuse") != "residential":
            return
        locations = [node.location for node in way.nodes if node.location.valid()]
        if not locations:
            return
        self.add(
            tags.get("name"),
            sum(location.lon for location in locations) / len(locations),
            sum(location.lat for location in locations) / len(locations)
        )

exclude_polygons = [polygon for path in args.exclude_boundary for polygon in polygons_from_geojson(path)]
sampler = AddressSampler(args.max_records, args.per_locality, polygons_from_geojson(args.boundary), exclude_polygons)
communities = CommunityCollector(sampler) if args.communities_file else None
location_index = None
location_storage = "flex_mem"
if pathlib.Path(args.input).stat().st_size >= 1_000_000_000:
    location_index = pathlib.Path(args.output).with_suffix(pathlib.Path(args.output).suffix + ".locations.idx")
    location_storage = f"sparse_file_array,{location_index}"
filter_keys = ["addr:housenumber", "addr:street", "addr:place"]
if communities is not None:
    filter_keys += ["landuse", "place"]
processor = osmium.FileProcessor(args.input).with_locations(location_storage).with_filter(KeyFilter(*filter_keys))
try:
    for entity in processor:
        if entity.is_node():
            sampler.node(entity)
            if communities is not None:
                communities.node(entity, {tag.k: tag.v for tag in entity.tags})
        elif entity.is_way():
            sampler.way(entity)
            if communities is not None:
                communities.way(entity, {tag.k: tag.v for tag in entity.tags})
finally:
    del processor
    if location_index:
        location_index.unlink(missing_ok=True)
if communities is not None:
    pathlib.Path(args.communities_file).write_text(
        "\n".join(communities.records.values()) + ("\n" if communities.records else ""), encoding="utf-8"
    )
selected = sorted(
    (record for group in sampler.groups.values() for record in group["records"]),
    key=lambda item: item[0]
)[:args.max_records]
residential_selected = sorted(
    ((-negative_rank, record) for negative_rank, _, record in sampler.residential),
    key=lambda item: item[0]
)
combined = []
seen = set()
for _, record in residential_selected + selected:
    if record in seen:
        continue
    seen.add(record)
    combined.append(record)
    if len(combined) >= args.max_records:
        break
if not combined:
    raise RuntimeError("Geofabrik extract produced no valid address objects")
pathlib.Path(args.output).write_text("\n".join(combined) + "\n", encoding="utf-8")
