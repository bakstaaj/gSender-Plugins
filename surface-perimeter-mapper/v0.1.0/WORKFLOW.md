# 3D Surface Perimeter Mapper — workflow draft

This is a new, separate gSender plugin. It does not extend or modify either Surface Height Map plugin. The initial machine-test milestone maps the perimeter and then probes interior Z rings on a simple centered cylinder with a 3D touch probe. Arbitrary outline tracing remains future work.

## Guided workflow

Each step is gated by the previous step. The UI should explain what the user needs to do, show the relevant live position/probe state, and prevent motion when its prerequisites are not met.

### 1. Describe the probe

Ask for:

- Tip diameter `D`.
- Usable thin-shaft length `L`: measured upward from the top of the ball to the first shaft section wider than the tip.
- A visible vertical safety allowance `C` used by the height calculation.

Show a small diagram explaining the `L` measurement. Do not assume `L` describes the probe body's XY clearance.

### 2. Describe the part and search area

Ask for:

- Minimum and maximum part thickness above the bed around the perimeter.
- The part length in X and width in Y. Calculate the search rectangle by adding the recommended edge margin on both sides of each dimension.
- A minimum edge-to-rectangle margin. Calculate a recommendation from the tip and required approach/release clearance; do not hard-code 5 mm without validating it against the probe geometry and motion plan.
- Perimeter sample spacing, capped at one quarter of the smaller part dimension so at least four samples span it; this limit is independent of tip diameter.

### 3. Jog and probe the rectangle origin

- Provide a jog panel with Home, selectable 0.1/1/10 mm jog increments, X/Y/Z buttons, and an MPOS/WPOS DRO selector. Jogging is available only while connected, homed, idle, and after the probe has passed its signal test.
- Keep the origin selector at the rectangle's lower-left corner in this prototype.
- Poll status reports and require a clear → triggered → clear `Pn:P` sequence before any probe motion.
- Require the controller to report `$23` homing direction, `$130/$131/$132` travel, and active G54.
- Probe the bed from the current Z toward the configured away-from-home Z limit, leaving a safety margin. On the first contact, retract 3.5 mm toward the Z home end and probe again at a slower feed.
- Set active G54 WPOS X0 Y0 Z0 at the confirmed contact. Then retract to `maximum part thickness + tip radius + vertical allowance`, after checking the target against signed Z travel.
- Save the probed machine coordinates as the rectangle return point only after gSender confirms the zero and safe retract.
- The origin action stores both the bed WPOS-zero machine coordinate and the safe retract position. The automatic scan uses the former for WPOS-to-machine travel checks.

### 4. Check probe reach and calculate perimeter height

Let `r = D / 2`, `Hmin`/`Hmax` be the entered thickness range, and `C` be the vertical safety allowance. Assuming `L` starts at the top of the ball, calculate a candidate ball-center height interval:

```text
lowest = max(r + C, Hmax + C - r - L)
highest = Hmin - r - C
```

If `lowest > highest`, stop and tell the user this probe cannot safely reach this part at one perimeter height. Otherwise, select a height inside the valid interval (initial proposal: its midpoint) and show the range and selected value for review. Validate the selected machine Z against controller travel before proceeding.

### 5. Current first scan: centered cylinder

- Ask for the approximate circle radius `R`; derive its diameter and search rectangle from `2R` plus the calculated margin.
- Use the probed WPOS origin as the approximate circle center. The first ray allows for center-placement error by searching inward to radius `max(0.1, R − 5 mm)`.
- Calculate angular sample count from circumference and requested sample spacing, with a 16-point minimum and a 360-point maximum.
- At the full-clearance Z, move to a radial approach point. Lower to the calculated perimeter height and use one bounded, continuous linear `G38.3` side touch for the complete ray; the controller itself stops the move at the first probe trigger. The first ray searches to `R − 5 mm`; later rays may search inward up to `R` from the predicted ball-center contact radius, stopping just before the center. This extra range is intended to find walls inside radial bays; never sweep with the probe held against the part.
- Offer Fast mode (one touch) and Precise mode (fast touch plus a slower bounded repeat touch). Predict each next radial contact from a linear fit to the last five measured radii, while bounding each prediction to at most two sample spacings from the last measurement. After each touch, move radially outward by 0.75 × tip diameter and require the controller status to show the probe clear (Pn:P absent after Pn reporting has been established). Move laterally to the predicted next angular approach at the same perimeter height; do not raise Z between samples. Raise Z for initial approach, normal completion, or recovery.
- Correct each ball-center contact inward by the entered tip radius and offer the points as CSV. On perimeter no contact, failed release, repeat-touch disagreement, unexpected pin activation, stale status, or controller alarm, stop the scan and retain already captured points. Interior probes must trigger before reaching the measured bed. A missing interior contact is retried once at the same point; after a second miss, retract to full clearance and pause for the operator to check the probe, then continue to retry that point or cancel.
- After the perimeter, raise to `0.75 × D + (Hmax − Hmin)` above part-top WPOS Z0. Derive interior ring XY from the measured edge radii. Start `0.75 × D` inside the perimeter and step each complete 360-degree ring inward by the configured perimeter spacing, then probe the center. Probe each point down to the previously measured bed height. Fast records one Z contact. Precise releases by `0.75 × D` and makes one slower confirming touch for part-surface contacts; it skips that second downward touch at bed level. Retract to the calculated clearance before moving XY. Preflight all points against machine travel and stop before the interior phase if the plan would exceed 12,000 points.
- Present the measured top surface in an isometric viewer with an adjustable vertical exaggeration control. Generate an open ASCII STL from the measured rings and center, with XY relative to the WPOS origin and Z relative to the first interior probe; the viewer's exaggeration does not alter exported STL dimensions.

This circle path is a deliberate limited first test. It does not infer an unknown center, resolve arbitrary non-circular geometry, or close an arbitrary contour. The inward search can find a bay wall when that wall intersects the radial ray within the configured `R` search distance, but it does not disambiguate multiple candidate walls along one ray. Future contour following still needs local direction estimation, multiple candidate search directions, and robust ambiguity handling.

### 6. Review and save the perimeter

Show perimeter and interior point counts, XY extents, measured surface range, the isometric surface, a CSV perimeter export, and copyable ASCII STL. A future version can report low-confidence sections, allow accept/discard, and persist a map record with its setup assumptions.

## Initial assumptions for user documentation

1. The probe is a 3D touch probe and its input changes state for XY as well as Z contact.
2. The user verifies that the probe input starts released and reliably releases after each touch.
3. The part is stable on a bed whose local height is represented adequately by the bed touch-off at the rectangle origin.
4. One perimeter is captured at one calculated Z height; it represents the part's cross-section at that height.
5. `L` is the thin shaft length from the top of the ball to the first section wider than `D`.
6. Features narrower than `4 × D` may be missed. Perimeter spacing must provide at least four samples across the smaller part dimension; its calculated maximum is `min(part X, part Y) / 4` and is independent of tip diameter. Tighter spacing is allowed, subject to the 360-point and total interior-point safety limits.
7. A bay with a narrow mouth and wider interior is a concavity in the XY outline. It is traceable only if the probe tip and shaft can physically pass through the mouth and the local search resolves the correct wall. The probe's usable shaft length is a vertical reach constraint, not horizontal reach into the bay.
8. One connected outer boundary is in scope initially. Holes and disconnected islands require additional seeds/traces.
9. The plugin uses bounded moves, verifies idle/release/position between moves, and pauses on ambiguity, alarm, lost position, or missing probe reports.
10. The current automated scan is configured by an approximate circle radius and WPOS center. The first inward ray searches to `R − 5 mm`; each later ray may search up to `R` inward from the predicted ball-center contact radius. Concave bay walls are only found when they intersect those rays and the probe can physically enter the opening.
11. The perimeter release distance is 0.75 × tip diameter. Between angular points the probe travels laterally at the calculated perimeter height, so the entered geometry, release distance, and clear radial path must be valid for the complete rotation.

## Decisions still to resolve

- Whether later machines should offer a configurable side-probe release distance; this prototype uses 0.75 × tip diameter.
- Whether automatic mapping should generalize from the centered-cylinder test to arbitrary convex and concave outlines.
- Search-ray count, angular spacing, search radius, and rules for choosing between multiple candidate walls.
- How the user may resume after a deliberate pause or manually reposition the probe.
- Minimum allowed perimeter spacing based on controller repeatability, probe repeatability, and motion/report timing.
- Whether non-GRBL controllers are in scope for the first implementation.
