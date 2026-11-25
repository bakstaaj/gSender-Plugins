# Carve Studio 0.1.0

Carve Studio is the start of a top-side vector design and CAM workspace for gSender. It is designed around editable 2D geometry on a rectangular stock face. The product scope excludes 3D relief carving, rotary work and underside machining.

## Current foundation

- Set the stock width and height in millimeters.
- Set stock thickness, or use the first-import auto-size mode to size width and height from the imported vector bounds plus 10% total margin.
- Create layers, switch the active drawing layer, and hide or show layers; hidden layers stay out of selection, SVG export and toolpath generation.
- Import SVG paths, lines, rectangles, circles, ellipses, polylines and polygons.
- Import ASCII DXF LINE, CIRCLE, ARC and LWPOLYLINE entities, including curved polyline segments.
- Select, shift-select, drag and delete vector objects; draw lines, rectangles and circles.
- Drag left-to-right to window-select fully enclosed objects; drag right-to-left to crossing-select objects touched by the box.
- Duplicate and mirror selections across the stock's horizontal or vertical centerline, or set their X/Y position and bounding-box size numerically.
- Use Delete, Ctrl+A and Ctrl+D for common selection actions.
- Undo and redo edits; save and reopen versioned `.carve` project files.
- Zoom, pan, fit the stock to view and export the current drawing as SVG.
- Generate a centerline profile preview, load it into the gSender visualizer and open Carve, or save G-code with configurable depth, stepdown, safe Z, feed, plunge and spindle RPM.
- Start a new project with a save / discard / cancel prompt when vectors are present. Profile toolpaths default to cutting through the stock thickness, with an option to use the explicit cut-depth value.
- Generate a peck-drilling preview from circle centers using the shared depth, peck depth, safe Z, plunge and spindle settings.
- Use bundled fonts including Short Stack and Relief SingleLine, or import local TTF and OTF outline fonts from the Text panel. Imported font files are retained in the gSender profile across restarts.
- Generate V Groove Profile paths from selected closed letter outlines. Both variable depth and fixed depth use the same connected centerline strokes. Relief SingleLine open strokes use fixed depth.
- Generate a pocket preview for selected closed boundaries using nested inward tool-center offsets, a flat tool diameter, stepover, depth and pass depth; counters are preserved as uncut islands.
- Optimize profiles by joining open vector endpoints within 0.02 mm and ordering contours by nearest travel start.

## Local deployment

Install dependencies with `npm ci` and build with `npm run build`. The version folder also includes `carve-studio-v0.1.0.zip` for installation through the gSender plugin manager.

Run `npm run deploy:local` from this folder to build and copy the plugin manifest and UI into the current user's gSender plugin installation. Set `GSENDER_PLUGIN_DIR` to override the default destination.

## Initial limitations

- SVG styles, groups, text, transforms and clipping are not interpreted; supported elements use their raw geometry and map the SVG viewBox to the stock size.
- DXF import currently reads basic ASCII entities only. Binary DXF, units metadata, splines, blocks and classic POLYLINE/VERTEX entities are not handled yet.
- On the first import, auto-size mode fits stock to the vector bounds with 5% margin on each side (10% total). Manually entered width or height disables auto-size. DXF coordinates are assumed to be millimeters; SVG dimensions with explicit physical units are converted to millimeters, and unqualified viewBox units are treated as millimeters.
- Profile G-code follows vector centerlines and supports holding tabs on closed through-cut contours. It does not apply cutter-radius compensation or entry leads. Simulate and verify the generated G-code, work offset, stock zero, tool and clearances before cutting.
- V Groove Profile on outlined letters uses a sampled Voronoi medial-axis estimate. Relief SingleLine uses open centerline strokes from its SVG font asset and a constant selected depth because a centerline has no stroke width from which to calculate a variable depth. Review the preview and simulate the generated G-code before machining; output has not been validated on a CNC.
- Pocketing uses sampled closed contours and polygon offsets, with round joins. It does not yet include ramp entry, finish allowance, tabs or material/tool presets. Simulate the generated G-code and verify the tool, work offset, stock zero and clearances before cutting.

## Product direction

Continue the editor with snapping and real layer editing, then add profile and pocket operations with previews, tool definitions, depth controls and explicit safe-height behavior.

All displayed geometry is a top view. Depth is a toolpath parameter, not a 3D design surface.
