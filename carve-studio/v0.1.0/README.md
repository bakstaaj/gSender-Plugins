# Carve Studio 0.1.0

Carve Studio is a top-side vector design and CAM workspace for gSender. Draw or import vectors, generate toolpaths, and preview material removal on rectangular stock.

## Install

[Download Carve Studio v0.1.0 for gSender](https://github.com/bakstaaj/gSender-Plugins/releases/download/carve-studio-v0.1.0/carve-studio-v0.1.0.zip)

In a plugin-capable gSender Edge build, open **Tools → Plugins → Install a plugin** and select the ZIP. Then open **Tools → Carve Studio**.

## Current foundation

- Set the stock width and height in millimeters.
- Set stock thickness, or use the first-import auto-size mode to size width and height from the imported vector bounds plus 10% total margin.
- Create layers, switch the active drawing layer, and hide or show layers; hidden layers stay out of selection, SVG export and toolpath generation.
- Import SVG paths, lines, rectangles, circles, ellipses, polylines and polygons.
- Import ASCII DXF LINE, CIRCLE, ARC and LWPOLYLINE entities, including curved polyline segments.
- Draw lines, rectangles, circles, open and closed polylines, 3-point arcs, and text. Grid and object snapping assist drawing and placement.
- Place editable block text along a selected open line, arc, or polyline with start, center, or end alignment and a normal offset.
- Use **Node Edit** to move nodes and Bézier handles. Double-click an edge to insert a node, or select a node and press **Delete**.
- Use **Join Vectors** to connect selected open vectors on the same layer within a maximum endpoint gap. Complete loops close automatically. Use **Close Vector** to connect the two ends of a selected outline with a straight segment.
- **Weld** combines closed shapes, **Subtract** cuts the other selected shapes from a highlighted target, and **Intersect** keeps the area shared by all selected shapes. The results are editable polygon outlines.
- Trim, offset, fillet, chamfer, and add inward fillets to outlines. Create rectangular and circular arrays from selected objects.
- Offset closed outlines inward or outward with sharp joins. Compound outlines keep their inner cutouts.
- Select, shift-select, drag, and delete vectors. Click an enclosed area to select it for machining.
- Drag left-to-right to window-select fully enclosed objects; drag right-to-left to crossing-select objects touched by the box.
- Duplicate and mirror selections across the stock's horizontal or vertical centerline, or set their X/Y position and bounding-box size numerically.
- Use Delete, Ctrl+A and Ctrl+D for common selection actions.
- Undo and redo edits; save and reopen versioned `.carve` project files.
- Zoom, pan, fit the stock to view and export the current drawing as SVG.
- Create local tool presets and apply compatible cutters to Profile, Drilling, V Groove and Pocket. Generated paths retain the selected cutter and tool number.
- Build a combined NC file in toolpath order with tool changes and profiles last. Save G-code or load it into the gSender visualizer.
- Open **Generated toolpaths → Cut preview** to see estimated material removal in angled or top view for the whole job or one operation. A flat-bottom finishing preview also shows its matching clearance pass.
- Start a new project with a save / discard / cancel prompt when vectors are present. Profile toolpaths default to cutting through the stock thickness, with an option to use the explicit cut-depth value.
- Generate a peck-drilling preview from circle centers using the shared depth, peck depth, safe Z, plunge and spindle settings.
- Use bundled fonts including Short Stack and Relief SingleLine, or import local TTF and OTF outline fonts from the Text panel. Imported font files are retained in the gSender profile across restarts.
- Generate V Groove Profile paths from selected closed letter outlines. Both variable depth and fixed depth use the same connected centerline strokes. Relief SingleLine open strokes use fixed depth.
- Open **Flat-bottom V Groove** and choose a V-bit from the tool library. Set the floor depth and V-bit pass depth. The panel shows the usable depth limit for the selected cutter and stock. An optional flat end mill clears broad areas before the V-bit finishes the sloped walls, narrow details, and remaining floor.
- Generate a pocket preview for selected closed boundaries using nested inward tool-center offsets, a flat tool diameter, stepover, depth and pass depth; counters are preserved as uncut islands.
- Generate a V-bit inlay pair from selected closed outlines: a V-carved female pocket and a mirrored V-carved background plug with an adjustable glue gap. Open or single-line vectors in a mixed selection are ignored; a selection containing only open or single-line strokes is rejected. Feed, plunge and RPM use the selected V-bit's library values. Save each half as its own NC file; set up matching stock and work zero for each, then profile the plug's rectangular boundary separately.
- Optimize profiles by joining open vector endpoints within 0.02 mm and ordering contours by nearest travel start.

## Trial and registration

The trial supports drawing, editing, saving projects, and generating toolpaths. SVG and DXF drawing import unlocks after registration.

Open **Registration** and use **Copy checkout link** or scan the Stripe QR code. If your gSender computer has internet access, enter your purchase email and the code from the N0JCG license email, then select **Activate license**.

To activate a computer that stays offline:

1. On that computer, open **Registration → Activate offline → Generate activation request**. Copy the request or save it as a text file.
2. On a phone or computer with internet access, open the [Carve Studio offline activation page](https://www.n0jcg.com/api/v1/licenses/carve-studio-offline). Enter the request, purchase email, and registration code. Copy or download the signed response.
3. Back on the offline computer, paste the response or load its text file, then select **Activate offline**.

Each purchase code activates one gSender profile. The same request can regenerate a lost or expired response without using another seat. Keep the gSender profile intact to preserve its installation key and offline activation. Contact support if you replace the computer or lose the profile.

Issue Carve Studio codes under the `carve-studio` product in the N0JCG licensing administrator. The purchase link uses the existing administrator issuance process.

## Local deployment

Install dependencies with `npm ci`, run `node --test tests/*.test.js`, and build with `npm run build`. The version folder holds the matching install ZIP.

Run `npm run deploy:local` from this folder to build and copy the plugin manifest and UI into the current user's gSender plugin installation. Set `GSENDER_PLUGIN_DIR` to override the default destination.

## Initial limitations

- SVG styles, groups, text, transforms and clipping are not interpreted; supported elements use their raw geometry and map the SVG viewBox to the stock size.
- DXF import currently reads basic ASCII entities only. Binary DXF, units metadata, splines, blocks and classic POLYLINE/VERTEX entities are not handled yet.
- On the first import, auto-size mode fits stock to the vector bounds with 5% margin on each side (10% total). Manually entered width or height disables auto-size. DXF coordinates are assumed to be millimeters; SVG dimensions with explicit physical units are converted to millimeters, and unqualified viewBox units are treated as millimeters.
- Profile can follow the vector or offset closed outlines by the cutter radius. Nested boundaries reverse the cut side, so Outside cuts around the part and inside its holes. Open vectors require On vector. Closed through-cut contours support holding tabs. Entry leads are not included. Simulate and verify the generated G-code, work offset, stock zero, tool and clearances before cutting.
- V Groove Profile on outlined letters uses a sampled Voronoi medial-axis estimate. Relief SingleLine uses open centerline strokes from its SVG font asset and a constant selected depth because a centerline has no stroke width from which to calculate a variable depth. Review the preview and simulate the generated G-code before machining; output has not been validated on a CNC.
- Pocketing uses sampled closed contours and polygon offsets with round joins. Simulate the generated G-code and verify the tool, work offset, stock zero, and clearances before cutting.
- V-bit inlay jobs are deliberately exported as two separate NC files because the pocket and mirrored plug are machined on separate stock setups. The plug uses a rectangular boundary around the selected artwork; a separate profile operation is needed to release it from its blank. Verify mirror orientation, glue gap, tool, work zero, and stock setup in a simulator before cutting.
- The vector editor works in top view. Cut preview estimates the result of the generated toolpaths on stock.
