# Camera Align & Print Registration
**Latest release package:** [Download camera-align-print-registration-v0.2.11.zip](https://github.com/bakstaaj/gSender-Plugins/releases/download/camera-align-print-registration-v0.2.11/camera-align-print-registration-v0.2.11.zip)

**Prototype version 0.1.0 · gSender 1.7.0-Edge-2 · Plugin SDK 0.2.2**

This plugin provides a live USB camera view, camera-to-spindle XY calibration, safe jog controls, and crosshair-based work zero. Print-mark registration is planned for a later version.

## Screenshots

### Live camera view

The crosshair marks the visual point to place over the desired work origin. The camera image remains local and is not recorded by the plugin.

![Live USB camera view with the crosshair centered over a work mark](screenshots/camera-view.png)

### Verified work zero

After updating the selected work coordinate system, the plugin confirms the saved offset and the active-system position check.

![Work zero successfully stored and verified in G54](screenshots/work-zero-verified.png)

## Version 0.1 workflow

1. Mount the camera rigidly to the spindle carriage and start the live camera view.
2. Choose a calibration method:
   - **Enter X/Y offset manually:** enter the spindle/tool position relative to the camera crosshair in millimeters and save it.
   - **Measure using a reference mark:** make a small mark in scrap, record machine XY with the spindle over it, then move the camera crosshair onto the same mark and record again. The plugin stores spindle position minus camera position.
3. At a safe Z height, move the camera crosshair over the point that should become the work zero.
4. Choose the coordinate system to update (G54–G59), then choose **Set [selected WCS] work zero at crosshair**. The selector defaults to the active system. The plugin asks before changing the selected persistent X/Y offset and verifies the controller's offset table. If the selected system is active, it reloads it and verifies the live work position. If another system is selected, the current active system stays active; select the updated system in gSender before using that origin.

The on-screen jog buttons require the operator to confirm safe Z and clear XY travel. The jog step is limited to 0.1–10 mm. The plugin does not start a carve, change Z zero, or run the spindle.
## Camera and motion notes

- Live video uses the browser camera API from inside gSender's plugin view. The operating system may ask for camera access. USB camera access is expected on gSender Edge 1.7.0-Edge-2 or newer.
- The plugin declares `camera` for iframe policy and `media` for Electron's session permission handler. Approve both on the plugin permission review screen if shown. The plugin requests video only (`audio: false`). If access is denied afterward, expand **Camera access diagnostics** for browser permission state and plugin-frame policy.
- Camera video is shown in the plugin; no video is saved or transmitted.
- The calibration assumes the camera and spindle remain rigidly mounted and that the image crosshair center is the reference point.
- Jog with a clear, known safe Z. Slow spindle/camera cable routing should be checked over the full XY range before motion.
- The G54 crosshair work-zero flow has been confirmed on a live CNC. Updating a non-active work system through the dropdown and jogging across the machine's full travel still need machine-side validation.

## Planned next stage

Print registration will use selected marks or points in a camera image to align a G-code job to a printed pattern. Its transform, scale behavior, file-loading workflow, and preflight checks will be designed after the camera-zero workflow is validated.
