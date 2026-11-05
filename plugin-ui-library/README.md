# gSender Plugin UI Standard

An initial shared CSS foundation and clickable component catalog for future gSender plugin work. The catalog uses Surface Height Map `v0.1.39` as its primary baseline and collects UI patterns from the maintained plugin source folders.

## Open the catalog

Open `index.html` directly in a browser. It has no build step and does not connect to gSender or a CNC controller. Jog, home, file, probe, and export examples are visual specimens; only local preview interactions are enabled.

## Files

- `shared.css` — the single source for color, spacing, typography, fields, buttons, cards, status, layout, and responsive component patterns.
- `index.html` — clickable index and annotated object layouts.
- `library.js` — preview-only interactions for the origin picker, segmented choice, DRO mode, map exaggeration, homing state, and active section index.

## Catalog contents and source patterns

| Shared object | Source patterns |
| --- | --- |
| Settings group | Surface Height Map's map dimensions, probe feeds, retracts, and radio choices |
| Origin location picker | Surface Height Map and File First origin selectors; Surface Perimeter Mapper rectangle-origin workflow |
| Jog and control panel | Surface Height Map and File First DRO, step selector, home, XY/Z pad, and probe actions |
| Surface map viewer | Surface Height Map's measured canvas, height range, exaggeration, and STL export |
| Workflow and progress | Surface Perimeter Mapper's staged readiness; Surface Height Map calibration progress and stop action |
| Status and diagnostics | CNC Machine Diagnostics, Machine Event Notifier, Camera Monitor, and probe-signal verification |
| File action row | Surface Height Map compensation, Image Heightmap Engraver image input, and CAMLab file workflows |

## Adoption guidance

Copy `shared.css` into a plugin's source tree and load it from that plugin's entry page. Use the shared object classes and CSS custom properties as the visual contract; keep plugin behavior and controller calls in the plugin's own code. Each plugin is packaged independently, so the stylesheet must be included in that plugin's build/package output. This catalog is the first standard proposal, not a migration of existing plugins.

Prefer semantic labels, fieldsets, buttons, and status regions. Keep machine actions gated by the plugin's real connection and safety logic; never wire the catalog preview handlers into motion commands.
