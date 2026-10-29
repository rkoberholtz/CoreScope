# Map

The Map page shows all nodes on an interactive map, color-coded by role.

[Screenshot: map with colored markers and controls panel]

## Marker shapes and colors

Each node role has a distinct shape and color:

| Role | Shape | Default Color |
|------|-------|---------------|
| Repeater | Diamond | Red |
| Companion | Circle | Blue |
| Room | Square | Green |
| Sensor | Triangle | Orange |
| Observer | Star | Purple |

Stale nodes (not heard recently) appear faded.

## Hash labels

Repeaters can display their short mesh hash ID instead of a plain marker. Toggle **Hash Labels** in the map controls to switch between icon markers and hash-labeled markers.

## Map controls

Open the controls panel with the ⚙️ button (top-right corner).

### Node types

Check or uncheck roles to show/hide them on the map. All roles are visible by default.

### Byte size filter

Filter nodes by packet size category: All, Small, Medium, Large.

### Status filter

Show only active, degraded, or silent nodes.

### Last heard filter

Limit the map to nodes heard within a time window (e.g., 24h, 7d, 30d).

### Clustering

Enable clustering to group nearby nodes into cluster bubbles. Zoom in to expand clusters.

### Neighbor filter

Select a reference node to highlight only its direct neighbors.

## Show Route

Click a node marker, then click **Show Route** in the popup to see the paths packets take to reach that node. Routes are drawn as lines between nodes.

## Region contours

**Region contours** outlines where each MeshCore region scope reaches. Turn it on under **Region Scope** in the map controls. Each scope gets one coloured area per group of its repeaters joined by two-way links. Two groups with no known link between them get separate areas, because a scoped flood only crosses between them through a repeater that forwards the scope.

- **Hover** an area to name the scopes under the cursor.
- **Click** an area to list the repeaters configured for each scope or seen carrying its traffic, and how many separate groups a split scope has.
- **View**: **Convex Hull** (the default) draws everything between a group's farthest edges. **Detailed** shrink-wraps the group's combined reach, filling gaps narrower than 15 km.
- **Scope list**: tick or untick scopes to show or hide them. Colours are handed out in name order, so hiding a scope never recolours the others.

The overlay needs no configuration to appear, but what it can show depends on what your instance knows about each repeater's regions. See [What puts a repeater in a region](#what-puts-a-repeater-in-a-region).

### How an area is drawn

Each repeater's reach is worked out in 72 directions:

- **Range** comes from its proven two-way links: the 75th percentile of their distances × 1.1, kept between 1 and 20 km. A repeater with no links gets 1 km.
- **Terrain** trims the range where line of sight over elevation data ends. Elevation is fetched by your browser (see [`mapDefaults.terrainTiles`](configuration.md#region-contours)); the antenna height is 10 m, raised up to 60 m where the repeater's links need more, unless you set it with [`mapDefaults.antennaHeights`](configuration.md#region-contours).
- **Links** to repeaters in the same area always stretch the reach out to them: evidence beats the model.
- Every repeater keeps at least 1 km of reach, and every area is grown by a 2 km margin with rounded corners, so no member is closer than 3 km to the edge.

Repeaters without a GPS position can't be placed and aren't drawn.

### What puts a repeater in a region

A repeater belongs to a scope's area when there is evidence for it, from one of these sources:

| Evidence | Where it comes from | Needs config |
|----------|---------------------|--------------|
| Reported region list | Observers that publish a `/neighbors` report ask nearby repeaters for their scopes; the names arrive in plain text. | No |
| Declared regions | Companions answer region-discovery requests ([Client regions](../client-regions.md)). | `clientRegions.enabled` |
| Default scope | The scope a repeater's own adverts go out under. Counts only for repeaters, and only while its reported list (if any) names it. | Region names |
| Seen carrying | The repeater's full public key appears in the path of scoped traffic. Counts only for scopes on its reported list, once it has one. | Region names |

Scoped packets carry a code derived from the region name, not the name itself. CoreScope can only tell which region a packet belongs to if it knows the name, from [`hashRegions`](configuration.md#region-names) or [`autoRegionKeys`](configuration.md#region-names). Traffic for a name it doesn't know is stored as an unknown scope and counts as evidence for nothing.

### When a region doesn't appear

- **No repeater reports it and it isn't in `hashRegions`.** Add the name to `hashRegions`, or turn on `autoRegionKeys` (which only helps once some repeater has reported the name).
- **Its repeaters have no GPS position.**
- **The instance restarted in the last few minutes.** The link graph is rebuilt about 5 minutes after startup; until then areas may be split into more groups than usual. Reload the page after that.
- **A newer report replaced the old one.** The newest report for a repeater wins, so a region removed from a repeater's list drops out of its area.

### Known limits

- Being seen carrying a scope never expires for a repeater that has never reported a list, so on an instance that keeps packets for a long time an old scope can linger.
- **Detailed** can reach up to about 1.5 km past the hull on very large reaches.
- The radius rule, floor, margin, terrain model, wrap gap, default view and pulse duration are fixed for now.

### Links

The overlay's state is kept in the URL, so a shared link opens as you had it:

| Parameter | Meaning |
|-----------|---------|
| `contours=1` / `contours=0` | Region contours on or off |
| `contoursView=detailed` | Detailed view (Convex Hull when absent) |
| `contoursHide=a,b` | Scopes hidden from the overlay |

For example: `#/map?contours=1&contoursView=detailed`.

## Popups

Click any marker to see:

- Node name and role
- Public key
- Last seen timestamp
- Link to the full node detail page

## Tips

- Zoom in on dense areas to see individual nodes
- Use the role checkboxes to isolate repeaters and understand coverage
- The neighbor filter is great for seeing which nodes can directly hear each other
- Node colors are [customizable](customization.md) in the theme settings
