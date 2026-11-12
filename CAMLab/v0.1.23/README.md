# CAMLab

**Prototype v0.1.23 · gSender 1.7.0-Edge-2 · Plugin SDK 0.2.2**

[Download the CAMLab v0.1.23 release package](https://github.com/bakstaaj/gSender-Plugins/releases/download/camlab-v0.1.23/camlab-v0.1.23.zip).

Import an STL or STEP model, enter blank stock dimensions, select an end mill, and generate top, bottom, front, and back mesh-slice contour files. The plugin intersects the model mesh at successive levels along each setup's cutting axis, offsets each closed contour by the tool radius, and retains internal contours such as through-holes and slots. The top-side file places its two tabs on the left and right outline sides. Front and back files add no tabs and preserve the top-side tab support regions.

## Settings and output

- Blank length (X), width (Y), and thickness (Z)
- XY origin: center the model in stock or retain its imported XY coordinates
- Installed collet size (1/4 in, 6 mm, 4 mm, 1/8 in, or 3 mm) and spindle RPM; CAMLab selects cutters that do not exceed the selected collet
- Step down, feed rate, plunge rate, and safe Z
- Tab width along the edge and tab height measured up from the stock bottom
- Top view of projected model, top slice contours, final cut, and tab locations
- Download G-code or load it into gSender's visualizer for review
- Separate top, bottom, front, and back G-code files with full previews and Copy all controls
- Top, front, and back area roughing raster-clears accessible waste, including holes and slots, before contour cuts; bottom remains missed-undercut-only
- Four-file machining order is top → front → back → bottom; side roughing subtracts swept roughing and hole/slot paths already removed by earlier setups
- Left/right stock rails beyond the top perimeter toolpath remain uncut for clamping on all four sides
- Duplicate same-depth contours and raster segments are removed; output groups roughing rasters, circular hole contours, pockets/slots, then perimeter passes
- Compatible outside perimeter waterlines are linked into continuous spiral cuts that ramp down without intermediate safe-Z retracts; tab spans stay at tab-clearance depth, and unsafe links fall back to the conservative segmented paths
- A retract and XY rapid are omitted when the next plunge starts at the same endpoint as the preceding cut

## Four-side machining sequence

Run the four programs in this order:

1. **Top:** Raster-rough the accessible top face, including waste in holes and slots, then cut the reachable contours. Two tabs remain on the left and right sides of the outside perimeter.
2. **Front (Y−):** Rotate the stock −90° about stock-centered X. Rough the face, cut features reachable from the front, and machine the outside perimeter everywhere except the top-tab support zones and left/right clamping rails. No side tabs are added.
3. **Back (Y+):** Rotate the stock +90° about stock-centered X. Rough the remaining accessible face, cut internal features missed from the front, and machine only the perimeter undercuts beneath the retained top tabs. The complete perimeter is not repeated.
4. **Bottom:** Flip the stock 180° about stock-centered X. Cut only internal undercut paths missed from the top; do not cut the outside perimeter or retained tabs.

Keep X registered and Y centered on the stock thickness during each setup. Reset Z zero to the newly exposed face for the front, back, and bottom programs. The left/right stock rails remain available for clamping in all setups.

Z zero is at the model and stock top. The top, front, and back files first raster-clear accessible stock outside the model's tool-offset sections at each step-down level, including hole and slot waste, then run their contour passes. Roughing stops one contour level before full-depth finishing and accumulates preceding model sections to avoid cutting into overhanging geometry. Front and back roughing use their side-face stock rectangles and preserve the top-side tab supports. Top contour finishing places tabs on the left and right sides. The front file cuts the outside perimeter and accessible features without adding tabs, skipping path sections that would cut the top-side tab supports. The back file has area roughing followed by internal contours missed from the front and reachable from the back, plus the perimeter undercut segments beneath the two retained top-side tabs. The full outside perimeter is not repeated from the back. The bottom-side file remains limited to missed undercut contours and receives no area roughing. Waterline contours are generated at each step-down level through the model height. Below the model bottom, the bottom cross-section is repeated to the entered stock thickness. Compatible outside perimeter waterlines are linked into continuous spirals without intermediate safe-Z retracts. Top-side tab spans stay at tab-clearance depth; if an unsafe link or protected region prevents a continuous path, the affected perimeter uses segmented retract paths. Hole and slot contours remain cut through without tabs.

## Current limits

The top-side program uses the last reachable profile down to the stock bottom when it detects an undercut and retains left/right tabs on its final perimeter through-cut. The bottom-side program contains only internal contours identified as inaccessible from above but accessible after flipping; it omits every outside perimeter path and all tabs. The front-side (Y−) program generates full waterline contours and the outside perimeter with area roughing after rotating the stock −90° about stock-centered X; it adds no tabs and avoids the two top-side tab supports. The back-side (Y+) program roughs the face and contains internal contours missed by front-side access and reachable from the back, plus only the perimeter-under-tab segments. It does not repeat the complete outside perimeter and adds no side tabs. Side programs cover the entire stock width at the selected step-down and carry the nearest valid section through blank margins. Run top, front, back, and bottom programs in that order. Roughing paths on front and back subtract the swept areas cleared by prior roughing and hole/slot contours. The bottom file remains undercut-only. Keep the selected X datum registered and machine Y on the stock thickness centerline; reset Z0 to the newly exposed Y face. The left and right stock rails outside the top perimeter toolpath are excluded from cutting on each setup and remain available for clamping. CAMLab groups and deduplicates same-depth contour and raster paths. Top/front/back roughing uses straight raster passes, has no ramped entries, and does not model exact clamp jaw geometry or clearance height; stock propagation is a roughing and hole-slot envelope rather than a full 3D simulation of every contour cut. Closed mesh sections are required; open or non-manifold models may not produce usable contours. If a waterline lands exactly on STEP mesh vertices, contouring retries on nearby planes up to 20 microns away to avoid double-counting coplanar mesh edges. CAMLab retries smaller cutters when a feature is too narrow for the collet-size cutter. With the smallest available cutter, it omits only hole/slot contour sections that cannot be preserved and flags those omissions in the preview status and every G-code file. STL facets and STEP tessellation set contour resolution. STEP units are converted to millimeters; STL files are assumed to be millimeters.

The G-code uses G21, G90, G17, G94, G54, tool change `M6`, and spindle start/stop. CAMLab assigns T1 to the largest standard cutter allowed by the selected collet and uses T2 for a smaller cutter if the entire contour set cannot be made with T1. Roughing uses T1; contour finishing uses the largest cutter that preserves every modeled feature. Verify the installed cutters, tool numbers, RPM, controller's tool-change behavior, origin, stock, workholding, and feeds. Simulate the file in gSender and inspect tab retention before machining. Physical CNC motion has not been validated.

## Build and install

Stock dimensions, XY origin, collet size, spindle speed, step down, feed and plunge rates, tab dimensions, and safe Z are saved in this browser's local storage and restored when CAMLab is reopened. The browser does not restore a previously selected local model file; import the model again after reopening.

Hover over any setting to see a tooltip explaining its purpose and effect.

Separate top-side, bottom-side, front-side, and back-side panes display the complete G-code and can be scrolled vertically and horizontally. Each pane has a Copy all button for copying its entire program.

Run `npm ci`, `npm run build`, and `npm run package` from this version folder in MSYS2/Git Bash. Import `camlab-v0.1.23.zip` using gSender's plugin manager. Approve the Visualizer Load permission to use the Load into gSender buttons. Loading replaces the current visualizer file; it does not start the job.

## Third-party components

- STEP import uses [occt-import-js](https://github.com/kovacsv/occt-import-js), distributed under LGPL-2.1.
- Polygon union uses polygon-clipping (ISC).
- Polygon offset uses clipper-lib (Boost Software License 1.0).

The OpenCascade WebAssembly importer is included as a separate UI resource so its module file can be replaced independently of the plugin code. See `THIRD_PARTY_NOTICES.md` for license texts and package versions.
