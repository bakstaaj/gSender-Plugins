# CAMLab

**Prototype v0.1.16 · gSender 1.7.0-Edge-2 · Plugin SDK 0.2.2** · [Download CAMLab v0.1.16 release package](https://github.com/bakstaaj/gSender-Plugins/releases/download/camlab-v0.1.16/camlab-v0.1.16.zip)

Import an STL or STEP model, enter blank stock dimensions, select an end mill, and generate top, bottom, front, and back mesh-slice contour files. The plugin intersects the model mesh at successive levels along each setup's cutting axis, offsets each closed contour by the tool radius, and retains internal contours such as through-holes and slots. Two tabs are placed on opposing straight sides of the outside contour when both sides can fit them; otherwise both tabs are spaced along the longest straight edge during the final stock cut.

## Settings and output

- Blank length (X), width (Y), and thickness (Z)
- XY origin: center the model in stock or retain its imported XY coordinates
- Tool number, diameter, and spindle RPM
- Step down, feed rate, plunge rate, and safe Z
- Tab width along the edge and tab height measured up from the stock bottom
- Top view of projected model, top slice contours, final cut, and tab locations
- Download G-code or load it into gSender's visualizer for review
- Separate top, bottom, front, and back G-code files with full previews and Copy all controls

Z zero is at the model and stock top. Waterline contours are generated at each step-down level through the model height. Below the model bottom, the bottom cross-section is repeated to the entered stock thickness. When a pass goes below the tab-clearance depth, the tool retracts and skips the two spans on the outer contour, leaving the configured tab height connected to the stock. Hole and slot contours remain cut through without tabs.

## Current limits

The top-side program uses the last reachable profile down to the stock bottom when it detects an undercut and retains tabs on its final perimeter through-cut. The bottom-side program contains only internal contours identified as inaccessible from above but accessible after flipping; it omits every outside perimeter path and all tabs so it cannot release the part. Front-side (Y−) and back-side (Y+) programs generate full waterline contours after rotating the stock −90° or +90° about stock-centered X, respectively; each keeps tabs on its final through-cut. Side programs cover the entire stock width at the selected step-down and carry the nearest valid section through blank margins. Keep the selected X datum registered and machine Y on the stock thickness centerline; reset Z0 to the newly exposed Y face. Preserve registration and follow each file's setup comments. The files do not clear pocket interiors, generate raster/relief paths or roughing passes, add ramps or lead-ins, or check fixtures and clamps. Closed mesh sections are required; open or non-manifold models may not produce usable contours. If a waterline lands exactly on STEP mesh vertices, contouring retries on nearby planes up to 20 microns away to avoid double-counting coplanar mesh edges. If an internal feature is too small for the selected cutter, generation stops with an error rather than silently dropping that feature. STL facets and STEP tessellation set contour resolution. STEP units are converted to millimeters; STL files are assumed to be millimeters.

The G-code uses G21, G90, G17, G94, G54, tool change `M6`, and spindle start/stop. The default spindle value is an example. Verify the selected tool, RPM, controller's tool-change behavior, origin, stock, workholding, and feeds. Simulate the file in gSender and inspect tab retention before machining. Physical CNC motion has not been validated.

## Build and install

Tab width and tab height are saved in this browser's local storage and restored when CAMLab is reopened.

Hover over any setting to see a tooltip explaining its purpose and effect. Tab width and tab height are saved in this browser's local storage and restored when CAMLab is reopened.

Separate top-side, bottom-side, front-side, and back-side panes display the complete G-code and can be scrolled vertically and horizontally. Each pane has a Copy all button for copying its entire program.

Run `npm ci`, `npm run build`, and `npm run package` from this version folder in MSYS2/Git Bash. Import `camlab-v0.1.16.zip` using gSender's plugin manager. Approve the Visualizer Load permission to use the Load into gSender buttons. Loading replaces the current visualizer file; it does not start the job.

## Third-party components

- STEP import uses [occt-import-js](https://github.com/kovacsv/occt-import-js), distributed under LGPL-2.1.
- Polygon union uses polygon-clipping (ISC).
- Polygon offset uses clipper-lib (Boost Software License 1.0).

The OpenCascade WebAssembly importer is included as a separate UI resource so its module file can be replaced independently of the plugin code. See `THIRD_PARTY_NOTICES.md` for license texts and package versions.
