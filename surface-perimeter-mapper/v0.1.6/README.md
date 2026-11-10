# 3D Part Mapping v0.1.6

**Contact-driven perimeter and surface mapping for gSender**

**Latest release package:** [Download the v0.1.6 install ZIP](https://github.com/bakstaaj/gSender-Plugins/releases/download/surface-perimeter-mapper-v0.1.6/surface-perimeter-mapper-v0.1.6.zip)

3D Part Mapping uses a connected-boundary probe path to record a part outline, map its top surface, and create an ASCII STL model. Choose which data to collect, then choose the model representation to view and export.

## Scan coverage

Choose the scan coverage between **Speed and Resolution** and **Part Placement**:

- **Outside perimeter only** follows the outside boundary and takes one top-height touch. The resulting model has a flat top at that touch height, a vertical outside wall, and a bed-level bottom.
- **Inside surface only** follows the boundary to constrain the map, then samples the inside surface. Its surface mesh and STL omit the vertical outside and bed walls.
- **Both perimeter and surface** follows the boundary and maps the inside surface, creating the complete closed model.

The **Display and STL view** selector in Results switches the visible mesh and the ASCII STL copied or downloaded from the plugin. Views that need readings the scan did not collect are disabled. The surface map updates as readings arrive.

## Install

Download the ZIP above and install it from gSender's plugin installer. The plugin requires gSender 1.7.0-Edge-1 or newer and a compatible GRBL or grblHAL controller with probe input and machine-position reporting.

## Setup and operation

1. Enter the probe tip diameter **D**, usable thin-shaft length **L**, perimeter spacing, and fast and slow feeds. The part thickness must not exceed **L**. The plugin clamps an excessive L to the machine's measured available Z travel and shows the calculated limit.
2. Select the scan coverage and perimeter probing mode.
3. Home the machine. Place the part on the bed, then move the probe to exposed bed at the front center, at least one tip diameter in front of the part.
4. Select **Start Probe**. The plugin checks the probe input, probes the bed, establishes the bed as G54 Z0, and starts the selected scan.
5. Stay beside the machine and keep its physical stop accessible. Review the map and choose the desired view before copying or downloading the STL.

The **Skip manual probe test** option is intended for controlled live testing. When enabled, it skips the manual activation/release check; it does not establish that the probe activates correctly. The controller must still report a known, clear probe input.

## Controller behavior and safety

The first bed touch can use the available machine Z travel. Each later downward probe move is limited by **L**. The plugin uses a fixed 1 mm vertical allowance, retracts after contacts, checks the reported travel limits, and offers a recovery dialog when it cannot safely decide how to continue. The recovery dialog includes jog controls and an Exit Scan button.

Keep the physical emergency stop accessible and supervise every automated move. Software travel checks cannot detect clamps, loose workholding, probe damage, or obstacles. Do not resume until the probe and machine position are safe.

## Results and limitations

Surface mapping records measured touch heights and estimates heights along the outside boundary from nearby samples. The surface-only STL is an open surface mesh; the perimeter-only and combined STLs are closed models. STL coordinates are in millimeters with Z referenced to the probed bed.

The simulator has previously completed tests with circles, squares, rectangles, right triangles, and equilateral triangles. The new scan-coverage and model-view options are build-verified but have not yet been revalidated on a physical machine. Shape details narrower than the probe and sample spacing, deep or inaccessible cutouts, and sharp corners can be missed or approximated.

## Development

From this version folder, run **npm ci** and **npm run build**. The production UI is written to the **ui/** folder. The package-plugin.ps1 script creates the gSender install ZIP in **dist/**. Build and package checks do not establish safe machine motion; test new scan settings under direct supervision.
