**Latest release package:** [Download surface-perimeter-mapper-v0.1.2.zip](https://github.com/bakstaaj/gSender-Plugins/releases/download/surface-perimeter-mapper-v0.1.2/surface-perimeter-mapper-v0.1.2.zip)

# 3D Surface Perimeter Mapper v0.1.2

A gSender plugin for a 3D touch probe. It finds the machine bed, follows a part's perimeter, then samples its top surface and can export the measurements as CSV and an ASCII STL surface.

## Testing notice

The following shapes have been successfully tested in the simulator: **circle, square, rectangle, right triangle, and equilateral triangle**. Simulator results do not establish that the plugin has been tested on a physical machine. This is a supervised prototype: check the probe, workholding, clearances and machine travel, and remain at the controller throughout a scan.

## Install

Download the release ZIP above and install it using gSender's plugin installer. The plugin requires gSender 1.7.0-Edge-1 or newer and a compatible controller that reports probe status and machine travel settings.

## Setup and scanning

1. Enter the probe-ball diameter, usable thin-shaft length, vertical allowance and approach clearance.
2. Enter the minimum and maximum thickness of the part's perimeter.
3. Choose Circle, Square, Rectangle or Triangle. Enter the part's actual dimensions, set the sample spacing, and choose fast or precise probing and feeds. The search box must include the entire part and room for the probe. Straight-edge shapes use at least 5 mm of calculated margin per side.
4. Home the machine, perform the probe-input test, jog to the approximate center above the part and probe the part-top work origin. The plugin uses G54 and verifies the safe retract.
5. Return to WPOS X0 Y0 at the requested clearance, review the plan, and start the scan while supervising the machine.

The bed search starts near the predicted front edge and steps outward after part contacts, including a final attempt at the search-box boundary. If no bed can be confirmed, it stops for review. Enter the actual dimensions: for example, a 70 mm-side equilateral test triangle has a height of approximately 60.62 mm.

Circle scans probe radially. Square, rectangle and triangle scans follow their edges with axis-aligned probes and change direction after a complete miss. The probe retracts 0.75 times its tip diameter after a contact. The first surface pass probes at least 0.5 tip diameter inside the measured perimeter and reports those heights at the edge. Triangle surface planning uses an interior point calculated from the measured outline, without changing WPOS.

The result is a sampled approximation, not a guarantee that every corner, narrow feature, bay or overhang has been measured. Automated scanning does not support holes, islands or arbitrary concave polygons. Travel checks do not detect clamps or other fixtures. Fast mode records one touch; precise mode includes a slower confirmation touch.

## Development

Run `npm ci`, `npm run build`, and `node tests/bed-search-simulation.cjs` from this version folder. `package-plugin.ps1` creates the install ZIP. Simulation and build checks do not replace supervised testing on the intended machine.
