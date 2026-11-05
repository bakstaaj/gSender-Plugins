# CAMLab

**Prototype v0.1.11 · gSender 1.7.0-Edge-2 · Plugin SDK 0.2.2**

Import an STL or STEP model, enter blank stock dimensions, select an end mill, and generate mesh-slice contour finishing paths. The plugin intersects the model mesh at successive Z levels, offsets each closed contour by the tool radius, and retains internal contours such as through-holes and slots. Changing cross-sections follow stepped or tapered model sides. Two tabs are placed at one-third and two-thirds along the longest straight segment of the outside contour during the final stock cut.

## Settings and output

- Blank length (X), width (Y), and thickness (Z)
- XY origin: center the model in stock or retain its imported XY coordinates
- Tool number, diameter, and spindle RPM
- Step down, feed rate, plunge rate, and safe Z
- Tab width along the edge and tab height measured up from the stock bottom
- Top view of projected model, top slice contours, final cut, and tab locations
- Download G-code or load it into gSender's visualizer for review
- Separate top-side and flipped-bottom-side G-code files

Z zero is at the model and stock top. Waterline contours are generated at each step-down level through the model height. Below the model bottom, the bottom cross-section is repeated to the entered stock thickness. When a pass goes below the tab-clearance depth, the tool retracts and skips the two spans on the outer contour, leaving the configured tab height connected to the stock. Hole and slot contours remain cut through without tabs.

## Current limits

This version creates two contour finishing files. The top-side program uses the last reachable profile down to the stock bottom when it detects an undercut and retains tabs on its final perimeter through-cut. The bottom-side program contains only internal contours identified as inaccessible from above but accessible after flipping; it omits every outside perimeter path and all tabs so it cannot release the part. Both files use the same stock XY origin and work offset. Bottom-side coordinates mirror X across the stock centerline for the assumed 180-degree flip about the stock-centered Y axis; Y stays unchanged and only Z0 is reset to the flipped exposed face. Secure the part and preserve XY registration after flipping. The files do not clear pocket interiors, generate raster/relief paths or roughing passes, add ramps or lead-ins, or check fixtures and clamps. Closed mesh sections are required; open or non-manifold models may not produce usable contours. If an internal feature is too small for the selected cutter, generation stops with an error rather than silently dropping that feature. STL facets and STEP tessellation set contour resolution. STEP units are converted to millimeters; STL files are assumed to be millimeters.

The G-code uses G21, G90, G17, G94, G54, tool change `M6`, and spindle start/stop. The default spindle value is an example. Verify the selected tool, RPM, controller's tool-change behavior, origin, stock, workholding, and feeds. Simulate the file in gSender and inspect tab retention before machining. Physical CNC motion has not been validated.

## Build and install

Tab width and tab height are saved in this browser's local storage and restored when CAMLab is reopened.

Hover over any setting to see a tooltip explaining its purpose and effect. Tab width and tab height are saved in this browser's local storage and restored when CAMLab is reopened.

Separate top-side and bottom-side panes display the complete G-code and can be scrolled vertically and horizontally. Each pane has a Copy all button for copying its entire program.

Run `npm ci`, `npm run build`, and `npm run package` from this version folder in MSYS2/Git Bash. Import `camlab-v0.1.11.zip` using gSender's plugin manager. Approve the Visualizer Load permission to use the Load into gSender buttons. Loading replaces the current visualizer file; it does not start the job.

## Third-party components

- STEP import uses [occt-import-js](https://github.com/kovacsv/occt-import-js), distributed under LGPL-2.1.
- Polygon union uses polygon-clipping (ISC).
- Polygon offset uses clipper-lib (Boost Software License 1.0).

The OpenCascade WebAssembly importer is included as a separate UI resource so its module file can be replaced independently of the plugin code. See `THIRD_PARTY_NOTICES.md` for license texts and package versions.
