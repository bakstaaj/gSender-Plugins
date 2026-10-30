# Roughing Blank Planner v0.2.1

Roughing Blank Planner is a gSender plugin for sizing a billet around a part NC program, recording machine workholding resources, and generating a stock-preparation program for review in Carve.

The plugin does not start a CNC job. Treat generated G-code as a draft: verify the part envelope, datum, billet, cutter, hole positions, clamp locations, clearances, and toolpaths in Carve before machining.

## Planning model

The source NC program supplies the part's XY motion envelope and cutting Z size. The planner uses cutting moves for Z sizing so rapid moves and retracts do not inflate the part thickness. The selected billet must have enough thickness for the part Z size plus the part-area roughing allowance.

The XY blank dimensions include the cutter diameter around the programmed perimeter path. Additional per-side clearances depend on the selected hold-down method:

| Method | XY clearance applied around the part |
| --- | --- |
| Bottom Surface | None. Vacuum or adhesive holds the underside. |
| Perimeter Surface | Cutter diameter plus the configured XY edge margin on each side. |
| Top Surface | Cutter diameter, the largest configured clamp overlap, and the XY edge margin on each side. |
| Fastening | Cutter diameter plus edge margin on the two bolt sides; zero extra XY margin on the other sides. |
| Fixture | Cutter diameter plus the XY edge margin on each side. |

For Fastening, the planner checks aligned, matching-diameter bolt pairs in both X and Y. It evaluates each layout across all configured billets and selects the fitting combination with the smallest planned blank envelope volume. The volume comparison includes the blank's outside dimensions, cutter diameter, and selected billet thickness; billet volume is used only to break ties. Two 6 mm wide by 2 mm thick tabs are left on the two sides occupied by the bolt pair.

The part-area Z roughing allowance is separate from XY clearance. It sets the target remaining thickness for the central pocket. The outside profile is cut through the selected stock while leaving the tabs for retention. Fastening plans also include through-holes and flat-bottom bolt-head counterbores.

## Configure the machine

Use the numbered tabs to set up the reusable machine resources:

1. **Billet Stock:** Add raw stock, or import/export the inventory as CSV. Each row records name, length, width, thickness, and material.
2. **Cutting Tools:** Record end mills and drills. Tool diameter and units determine which cutters can be recommended for the part and operation.
3. **Bed Plate:** Upload one complete bed-plate DXF. Put the closed boundary on a perimeter/outline layer, mounting circles on a bolts/mounting layer, and alignment circles on a pins/alignment layer. Review and edit the generated perimeter and hole tables before saving.
4. **T-Tracks:** Upload track DXFs, then review and edit the extracted track dimensions.
5. **Surface Clamps:** Enter contact width, height above the support surface, overlap over the part, and minimum/maximum reach to a bolt hole or T-track.
6. **Vise:** Enter jaw width, maximum opening, jaw height, and the X/Y center of the open jaws from the bed-plate datum.
7. **Other Fixtures:** Record dedicated fixture DXFs and editable fixture dimensions or alignment marks.

DXF uploads are configuration aids. Confirm the extracted dimensions and coordinates against the physical machine. The planner keeps the editable setup values; it does not generate a fixture from the original DXF.

## Example using the test-machine data

This example uses the `cnc-006.nc` part and the inventory currently configured in the local test plugin. It shows why the planner can choose a longer, narrower X-axis blank even though the Y-axis blank fits a smaller raw billet.

### Inputs

- Part NC envelope: **68.175 × 23.175 mm**, with a **15 mm cutting Z size**.
- Selected cutter: **3 mm end mill**.
- XY edge margin: **5 mm per side** where the method calls for it.
- Bolt-head pocket diameter: **10 mm**; bed-plate mounting holes: **36 holes, Ø5.5 mm**.
- Configured billets: **3 × 3 × ½ in**, **4 × 4 × ¾ in**, and **6 × 6 × 1 in**.

### Compare the best bolt-pair layouts

The lowest-volume X-axis pair is **Bolt 10 and Bolt 17**, spaced **114.5 mm** apart. The bolt sides need 3 mm cutter diameter plus the 5 mm edge margin per side. The resulting outside blank is **143.5 × 26.175 mm**. It fits the configured 6 × 6 × 1 in billet. At 25.4 mm billet thickness, its envelope volume is about **95,405 mm³**.

The Y-axis pair shown in the earlier test plan is **Bolt 28 and Bolt 24**, spaced **69.5 mm** apart. Its outside blank is **71.175 × 98.5 mm** and fits the 4 × 4 × ¾ in billet. At 19.05 mm billet thickness, its envelope volume is about **133,555 mm³**.

The X-axis option has the smaller planned blank volume, so v0.2.1 selects it. It consumes a larger raw billet: the 6 × 6 × 1 in billet is about **589,934 mm³**, compared with about **196,645 mm³** for the 4 × 4 × ¾ in billet. The selection objective is the planned blank volume, not the purchased-stock volume.

### Generate and review

1. Open **Plan a Part**, load `cnc-006.nc`, and choose **Fastening**.
2. Confirm the recommended 3 mm cutter, 10 mm bolt-head pocket, 5 mm edge margin, and billet inventory.
3. Review the selected X-axis pair, 114.5 mm hole spacing, blank dimensions, part translation, roughing target, and tab sides.
4. Generate the preparation file and load it into Carve for review. Confirm that the through-holes, counterbores, pocket, outside profile, and tabs match the physical setup. Do not run the file until the complete setup has been checked.

## Install and build

Import `roughing-blank-planner-v0.2.1.zip` through the gSender plugin manager. Approve the requested Storage and Visualizer Load permissions.

To build from source, run `npm ci`, `npm run build`, and `package-plugin.ps1` from this version directory. The package includes the plugin manifest, this README, and the built `ui/` directory.
