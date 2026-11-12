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

**Region contours** marks where each MeshCore region scope is. Turn it on under **Region Scope** in the map controls. Each scope gets one coloured area, drawn around the repeaters that belong to it.

The area is schematic. It shows which repeaters carry a scope and which of them hear each other. It is not a coverage map: CoreScope doesn't know how far a repeater's signal really carries.

- **Hover** an area to name the scopes under the cursor.
- **Click** an area to list the repeaters configured for each scope or seen carrying its traffic, and how many separate groups the scope has.
- **Scope list**: tick or untick scopes to show or hide them. Colours are handed out in name order, so hiding a scope never recolours the others.

The overlay needs no configuration to appear, but what it can show depends on what your instance knows about each repeater's regions. See [What puts a repeater in a region](#what-puts-a-repeater-in-a-region).

### How an area is drawn

- **An octagon round every repeater of the scope.** Its corners are 4 km from the repeater unless you set another radius with [`mapDefaults.contours.radiusKm`](configuration.md#region-contours). If you know a site reaches further or less far, give that repeater its own radius with `mapDefaults.contours.radii`.
- **A thin band between two of the scope's repeaters that hear each other**, when their octagons don't already meet. A link counts when it was heard in at least one direction. The band is narrower than an octagon on purpose: a link shows the far end heard the near one, not that the ground between them is covered.
- **Nothing between repeaters with no known link.** A scoped flood only crosses from one repeater to another through a repeater that forwards the scope, so a link through a repeater outside the scope draws no band. The click box says how many separate groups of linked repeaters a scope has.

Repeaters without a GPS position can't be placed and aren't drawn.

#### Why it is schematic

Earlier versions estimated each repeater's reach from terrain, path loss and link distances. Checked against the receptions a live mesh had actually logged (870 of them, each hidden in turn), the best model put 80% of listeners inside the drawn reach, where a plain circle of the same area put 75%. It also drew areas well past where people on the ground could be heard, with an edge that looked measured. The octagons make no such claim.

### What puts a repeater in a region

A repeater belongs to a scope's area when there is evidence for it, from one of these sources:

| Evidence | Where it comes from | Needs config |
|----------|---------------------|--------------|
| Reported region list | The newest list the repeater reported, from either of two collectors. Observers that publish a `/neighbors` report ask nearby repeaters for their scopes, and companions answer region-discovery requests ([Client regions](../client-regions.md)). The names arrive in plain text. | No, for `/neighbors` reports; `clientRegions.enabled` for companions |
| Default scope | The scope a repeater's own adverts go out under. Counts only for repeaters, and only while its reported list (if any) names it. | Region names |
| Seen carrying | The repeater's full public key appears in the path of scoped traffic. Counts only for scopes on its reported list, once it has one. | Region names |

Only the newest reported list counts, whichever collector it came from, so a region removed from a repeater's list drops out of its area. A list marked as cut short (truncated) adds the regions it names but rules nothing out: a scope the repeater was seen carrying, or its default scope, still counts.

Scoped packets carry a code derived from the region name, not the name itself. CoreScope can only tell which region a packet belongs to if it knows the name, from [`hashRegions`](configuration.md#region-names) or [`autoRegionKeys`](configuration.md#region-names). Traffic for a name it doesn't know is stored as an unknown scope and counts as evidence for nothing.

### When a region doesn't appear

- **No repeater reports it and it isn't in `hashRegions`.** Add the name to `hashRegions`, or turn on `autoRegionKeys` (which only helps once some repeater has reported the name).
- **Its repeaters have no GPS position.**
- **The instance restarted in the last few minutes.** The link graph is rebuilt about 5 minutes after startup; until then few links are known, so bands are missing and a scope counts more separate groups than usual. Reload the page after that.
- **A newer report replaced the old one.** The newest reported list wins, so a region removed from a repeater's list drops out of its area.

### Known limits

- Being seen carrying a scope never expires for a repeater that has never reported a list, so on an instance that keeps packets for a long time an old scope can linger.
- The radius is the same for every repeater unless you set its own: a hilltop site and one in a valley look alike.
- A band shows a link CoreScope has seen, however long. A rare long link draws a long band.
- The pulse duration on the Live page is fixed for now.

### Links

The overlay's state is kept in the URL, so a shared link opens as you had it:

| Parameter | Meaning |
|-----------|---------|
| `contours=1` / `contours=0` | Region contours on or off |
| `contoursHide=a,b` | Scopes hidden from the overlay |

For example: `#/map?contours=1&contoursHide=us`.

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
