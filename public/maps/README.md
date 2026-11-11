# World map asset

`world-map-units.geojson` is derived from Natural Earth 1:110m Admin 0 Map Units and contains only geometry, ISO code candidates, and label coordinates required by the dashboard.

- Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_map_units.geojson
- Dataset: Natural Earth 5.1.1
- License: public domain
- Retrieved: 2026-07-31

`admin-1/{ISO}.geojson` contains simplified first-order administrative boundaries for the 27 supported countries and regions. Files are loaded only after selecting a country or zooming into the world map.

- Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_admin_1_states_provinces.geojson
- Dataset: Natural Earth 5.1.1, Admin-1 States and Provinces
- License: public domain
- Retrieved: 2026-07-31
- Processing: filtered by ISO alpha-2 code, reduced to display fields, topology-preserving simplification at 0.015 degrees

`admin-2/{ISO}.geojson` contains simplified second-order boundaries (counties, districts, municipalities) for the 24 supported countries where Overture publishes them; Taiwan, Hong Kong and Vietnam have none. A file is loaded after its country is selected and drawn once the map is zoomed in.

- Source: Overture Maps divisions, `division_area` (`subtype=county`, `class=land`; Brazil uses `subtype=locality` for its municipalities)
- Dataset: Overture Maps release 2026-10-21.0
- License: ODbL 1.0 (OpenStreetMap-derived); credit shown on the map as "© OpenStreetMap contributors, Overture Maps Foundation"
- Retrieved: 2026-11-11
- Processing: `python scripts/build-admin2-boundaries.py 2026-10-21.0 public/maps/admin-2` (DuckDB with httpfs and spatial) keeps the name, English name and ISO 3166-2 region code, simplifies with topology preserved at 0.008–0.04 degrees depending on country size, and rounds coordinates to three decimals
