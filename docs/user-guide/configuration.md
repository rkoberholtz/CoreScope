# Configuration

CoreScope is configured via `config.json` in the server's working directory. Copy `config.example.json` to get started.

## Core settings

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `3000` | HTTP server port |
| `apiKey` | — | Secret key for admin API endpoints (POST/PUT routes) |
| `dbPath` | — | Path to SQLite database file (optional, defaults to `meshcore.db`) |

## MQTT

```json
"mqtt": {
  "broker": "mqtt://localhost:1883",
  "topic": "meshcore/+/+/packets"
}
```

The ingestor connects to this MQTT broker and subscribes to the topic pattern.

### Multiple MQTT sources

Use `mqttSources` for multiple brokers:

```json
"mqttSources": [
  {
    "name": "local",
    "broker": "mqtt://localhost:1883",
    "topics": ["meshcore/#"]
  },
  {
    "name": "remote",
    "broker": "mqtts://mqtt.example.com:8883",
    "username": "user",
    "password": "pass",
    "topics": ["meshcore/SJC/#"]
  }
]
```

## Branding

| Field | Description |
|-------|-------------|
| `branding.siteName` | Site title shown in the nav bar |
| `branding.tagline` | Subtitle on the home page |
| `branding.logoUrl` | URL to a custom logo image |
| `branding.faviconUrl` | URL to a custom favicon |

## Theme

Colors used throughout the UI. All values are hex color codes.

| Field | Description |
|-------|-------------|
| `theme.accent` | Primary accent color (links, buttons) |
| `theme.navBg` | Navigation bar background |
| `theme.navBg2` | Secondary nav background |
| `theme.statusGreen` | Healthy status color |
| `theme.statusYellow` | Degraded status color |
| `theme.statusRed` | Silent/error status color |

See [Customization](customization.md) for the full list — the theme customizer exposes every color.

## Node colors

Default marker colors by role:

```json
"nodeColors": {
  "repeater": "#dc2626",
  "companion": "#2563eb",
  "room": "#16a34a",
  "sensor": "#d97706",
  "observer": "#8b5cf6"
}
```

## Health thresholds

How long (in hours) before a node is marked degraded or silent:

| Field | Default | Description |
|-------|---------|-------------|
| `healthThresholds.infraDegradedHours` | `24` | Repeaters/rooms → degraded after this many hours |
| `healthThresholds.infraSilentHours` | `72` | Repeaters/rooms → silent after this many hours |
| `healthThresholds.nodeDegradedHours` | `1` | Companions/others → degraded |
| `healthThresholds.nodeSilentHours` | `24` | Companions/others → silent |

## Retention

| Field | Default | Description |
|-------|---------|-------------|
| `retention.nodeDays` | `7` | Nodes not seen in N days move to inactive |
| `retention.packetDays` | `30` | Packets older than N days are deleted daily |

> **Note:** Lowering retention does **not** immediately shrink the database file.
> SQLite marks deleted pages as free but does not return them to the filesystem
> unless [incremental auto-vacuum](database.md) is enabled. New databases created
> after v0.x.x have auto-vacuum enabled automatically. Existing databases require
> a one-time migration — see the [Database](database.md) guide.

## Database

| Field | Default | Description |
|-------|---------|-------------|
| `db.vacuumOnStartup` | `false` | Run a one-time full `VACUUM` on startup to enable incremental auto-vacuum (blocks for minutes on large DBs) |
| `db.incrementalVacuumPages` | `1024` | Free pages returned to the OS after each retention reaper cycle |

See [Database](database.md) for details on SQLite auto-vacuum, WAL, and manual maintenance.
See [#919](https://github.com/Kpa-clawbot/CoreScope/issues/919) for background.

## Channel decryption

| Field | Description |
|-------|-------------|
| `channelKeys` | Object of `"label": "hex-key"` pairs for decrypting channel messages |
| `hashChannels` | Array of channel names (e.g., `"#LongFast"`) to match by hash |

See [Channels](channels.md) for details.

## Map defaults

```json
"mapDefaults": {
  "center": [37.45, -122.0],
  "zoom": 9
}
```

Initial map center and zoom level.

### Region contours

Optional `mapDefaults.contours` settings size the [region contours](map.md#region-contours) overlay:

```json
"mapDefaults": {
  "center": [37.45, -122.0],
  "zoom": 9,
  "contours": {
    "radiusKm": 5,
    "tubeWidthKm": 1,
    "radii": {
      "a1b2c3d4": 2,
      "e5f60718": 12
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `mapDefaults.contours.radiusKm` | 4 | The radius of the octagon drawn round every repeater of a scope (0.5–30). |
| `mapDefaults.contours.tubeWidthKm` | a third of the radius | The width of the band drawn between two repeaters that hear each other (0.2–10). It is never wider than the smaller octagon it joins. |
| `mapDefaults.contours.radii` | — | Your own radius, in km (0.5–30), for repeaters whose reach you know, keyed by public key or a unique hex prefix of at least 8 characters. The longest matching prefix wins. |

The settings of the earlier reach model (`mapDefaults.antennaHeights`, `mapDefaults.terrainTiles`, and the `budgetPercentile`, `defaultBudgetDb`, `maxReachKm`, `reachRule`, `marginKm` and `receiverHeightM` fields of `contours`) are no longer used. A config that still has them loads as before.

A value out of range is ignored, and that setting keeps its default.

**If the areas look too big.** The defaults catch the most known receptions, but that's measured at the nodes that heard each repeater, which are mostly rooftop repeaters and observers: they hear past ridges that someone on the ground doesn't. If you know where coverage really ends, try `reachRule: "first"` and a smaller `marginKm` first, then a lower `budgetPercentile` and `receiverHeightM: 2`. `node scripts/validate-reach.js <your instance> --rule first --margin 0.5` shows what each setting costs in known receptions. Since that check only counts receptions outside the drawn area, never area drawn where nobody listens, a more conservative setting always scores lower there.

## Region names

```json
"hashRegions": ["#us", "#us-pa", "#phl"],
"autoRegionKeys": { "enabled": true }
```

Scoped (transport-route) packets carry a code derived from the region name, not the name itself, so the ingestor can only tell which region a packet belongs to if it knows the name.

| Field | Default | Description |
|-------|---------|-------------|
| `hashRegions` | — | Region names used in your network. A missing leading `#` is added. Traffic for a region not listed (or derived, below) is stored as an unknown scope. |
| `autoRegionKeys.enabled` | `false` | Also derive names from the regions repeaters report they are configured for (observer `/neighbors` reports, and [declared regions](../client-regions.md) where enabled). |
| `autoRegionKeys.maxDerived` | `256` | Cap on derived names. |
| `autoRegionKeys.refreshMinutes` | `15` | How often the derived names are rebuilt. |

`autoRegionKeys` is a top-level block next to `hashRegions`. Nested anywhere else it is silently ignored.

These names decide what a repeater's default scope and its seen-carrying traffic can count as, both on the [region contours](map.md#what-puts-a-repeater-in-a-region) and on the Map page's region scope filter. A region list a repeater reports itself needs no names configured.

## Regions

```json
"regions": {
  "SJC": "San Jose, US",
  "SFO": "San Francisco, US"
}
```

Named regions for the region filter dropdown. The `defaultRegion` field sets which region is selected by default. These are observer IATA codes, not MeshCore region scopes; for scopes see [Region names](#region-names).

## Cache TTL

All values in seconds. Controls how long the server caches API responses:

```json
"cacheTTL": {
  "stats": 10,
  "nodeList": 90,
  "nodeDetail": 300,
  "analyticsRF": 1800
}
```

Lower values = fresher data but more server load.

## Packet store

| Field | Default | Description |
|-------|---------|-------------|
| `packetStore.maxMemoryMB` | `1024` | Maximum RAM for in-memory packet store |
| `packetStore.estimatedPacketBytes` | `450` | Estimated bytes per packet (for memory budgeting) |
| `packetStore.retentionHours` | `0` | Only load packets younger than N hours on startup and keep them in memory. **Set this on any instance with a large DB.** `0` = unlimited (loads full DB history — causes OOM on cold start when the DB has hundreds of thousands of paths). Recommended: same as `retention.packetDays × 24` (e.g. `168` for 7 days). |

> **Warning:** Leaving `retentionHours` at `0` on a large database will cause the server to OOM-kill itself on every cold start. The full packet history is loaded into the subpath index at startup; a DB with ~280K paths produces ~13M index entries before the process is killed.

## Timestamps

| Field | Default | Description |
|-------|---------|-------------|
| `timestamps.defaultMode` | `"ago"` | Display mode: `"ago"` (relative) or `"absolute"` |
| `timestamps.timezone` | `"local"` | `"local"` or `"utc"` |
| `timestamps.formatPreset` | `"iso"` | Date format preset |

## Live map

| Field | Default | Description |
|-------|---------|-------------|
| `liveMap.propagationBufferMs` | `5000` | How long to buffer observations before animating |

## HTTPS

```json
"https": {
  "cert": "/path/to/cert.pem",
  "key": "/path/to/key.pem"
}
```

Provide cert and key paths to enable HTTPS.

## Geographic filtering

```json
"geo_filter": {
  "polygon": [[51.55, 3.80], [51.55, 5.90], [50.65, 5.90], [50.65, 3.80]],
  "bufferKm": 20
}
```

Restricts ingestion and API responses to nodes within the polygon plus a buffer margin. Remove the block to disable filtering. Nodes with no GPS fix always pass through.

Can also be configured live via the **🗺️ GeoFilter** tab in the Customizer (requires `apiKey`).

See [Geographic Filtering](geofilter.md) for the full guide.

## Areas

```json
"areas": {
  "BAY": {
    "label": "Bay Area",
    "polygon": [[37.90, -122.55], [37.90, -121.75], [37.25, -121.75], [37.25, -122.55]]
  },
  "SJC": {
    "label": "San Jose",
    "latMin": 37.20, "latMax": 37.45, "lonMin": -122.05, "lonMax": -121.75
  }
}
```

GPS-based display filter. When configured, a pill bar appears in the dashboard letting users scope packets, nodes, and analytics to nodes physically located within a named area. Attribution is based on the transmitting node's own GPS coordinates — not the observer's location.

Each entry supports a `polygon` (array of `[lat, lon]` pairs) or a bounding box (`latMin`/`latMax`/`lonMin`/`lonMax`). Remove the block to disable the area filter UI.

See [Area Filter](area-filter.md) for the full guide including the visual builder tool.

## Home page

The `home` section customizes the onboarding experience. See `config.example.json` for the full structure including `steps`, `checklist`, and `footerLinks`.
