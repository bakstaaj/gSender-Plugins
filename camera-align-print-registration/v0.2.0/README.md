# Camera Align & Print Registration
**Latest release package:** [Download camera-align-print-registration-v0.2.11.zip](https://github.com/bakstaaj/gSender-Plugins/releases/download/camera-align-print-registration-v0.2.11/camera-align-print-registration-v0.2.11.zip)

**Version 0.2.0 · gSender 1.7.0-Edge-2 · Plugin SDK 0.2.2**

Use a live USB camera and a calibrated camera-to-spindle offset to establish work zero or align a G-code toolpath to printed artwork. The camera panel and jog controls can pop out together into a compact floating window; drag its grip to place them beside the work-zero or registration controls, or dock them back into the page. Camera images and selected G-code files stay on the computer; the plugin does not upload or record them.

## Screenshots

### Live camera view

The crosshair marks the visual point placed over a work origin or printed registration mark.

![Live USB camera view with the crosshair centered over a work mark](screenshots/camera-view.png)

### Floating camera and jog controls

Pop out the camera panel to keep the live crosshair visible beside the registration controls. The jog card moves into the floating panel with it; drag the grip to reposition the window and use **Dock camera** to return both panels to the page.

![Floating camera view with jog controls attached below it](screenshots/camera-popout-jog.png)

### Verified work zero

The plugin reports when the selected work offset has been stored and verified.

![Work zero successfully stored and verified in G54](screenshots/work-zero-verified.png)

## Print registration workflow

1. Connect to the CNC, start the camera, and calibrate the camera-to-spindle XY offset.
2. Load the G-code file. The file is read locally in the plugin and is limited to 25 MB.
3. Identify two points in the file that correspond to visible printed marks. Enter each point's X/Y coordinates in millimeters. Choose marks that are far apart and easy to center accurately.
4. Raise Z to a safe height and confirm the existing safe-jog check. Center the camera crosshair on printed mark A and record it, then do the same for mark B. Captures are made in the current work coordinate system.
5. Select **Align and download G-code**. The plugin maps the source marks to the corresponding machine work positions, including the saved spindle-to-camera offset, and downloads a registered copy. It does not move the machine or start the job.
6. Load and review the downloaded file in gSender before running it. It begins with the work system used for capture and the controller's current units.

The alignment is a two-point similarity transform: uniform scale, rotation, and translation. It preserves orientation and does not infer mirroring. Both source points and printed points must be paired in the same order. The calculated scale must be between 0.5× and 2×.

## G-code support and limits

The aligner transforms plain numeric XY toolpath moves in the G17 plane. It supports G0/G1/G2/G3, absolute and incremental XY positioning, G20/G21 units, and I/J or R arc definitions. Z and non-XY feed/spindle commands are retained. The file's active coordinate system, if specified, must match the WCS used when the marks were recorded.

Files containing coordinate-changing features the aligner cannot preserve are rejected before download. This includes macros/expressions, checksums, subprograms, machine-coordinate moves, canned cycles, coordinate offsets, scaling, or rotation commands. Review the complete output and gSender preview before machining; firmware dialects and postprocessors vary.

## Camera offset and work zero

- Enter the spindle/tool offset manually, or measure it from the same physical reference mark with the spindle and then the camera crosshair.
- The offset convention is spindle XY minus camera-crosshair XY.
- Select G54–G59 and use **Set work zero at crosshair** to update the selected persistent X/Y offset. The plugin confirms the write and checks the controller's offset table. A live position check is performed when changing the active system.
- The G54 crosshair work-zero flow has been confirmed on a live CNC. The non-active WCS branch, full-travel jogging, and print-registration output still need machine-side validation.

## Camera access and safety

- Approve Camera and media permissions when gSender prompts. The plugin requests video only, not microphone audio.
- If access is denied, expand **Camera access diagnostics** to inspect browser permission and plugin-frame camera policy.
- The camera and spindle must remain rigidly mounted. Check camera, spindle, cable, and clamp clearance throughout the machine's full XY travel before jogging.
- Registration mark capture requires an idle CNC and the safe-Z/clear-travel acknowledgement. Recording a mark reads position only; it does not move the machine.
