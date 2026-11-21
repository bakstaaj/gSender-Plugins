# CNC Probe Offset Calibration for gSender

This plugin guides a two-surface Z calibration for grblHAL controllers. It probes the fixed tool sensor, moves to a user-selected bed point, prompts for the bed probe, and measures the signed difference. The result is placed in an editable offset field and saved in the plugin's gSender storage; the plugin does not write any controller setting.

The result is calculated as:

```text
Offset = fixed-sensor trigger Z - bed-probe trigger Z
```

## Workflow

1. Connect and home the machine. Confirm the fixed sensor location, bed touch point, probe travel, feeds, and retract values.
2. Run **Check probe signal**. The controller must report the probe clear, triggered, and clear again in `Pn:` status reports. The plugin will not begin motion if this check fails.
3. Start calibration. The machine moves to the fixed sensor start point and runs fast and slow Z probing.
4. The machine retracts to the configured Z start machine coordinate (default −5 mm) and moves to the selected bed XY point. Attach the electrical probe and touch plate when prompted, then continue.
5. Review or overwrite the offset field, then choose **Save offset in plugin**. The saved value remains available in this plugin on the same gSender installation.

The plugin attempts to read the fixed sensor location and probe values from gSender's Redux state. If the host does not expose them, the inputs remain editable. The initial values match the supplied screenshots: fixed sensor X6/Y-1/Z-5 mm, probe travel 50 mm, fast 500 mm/min, slow 25 mm/min, and retract 2 mm. Verify these against the live gSender settings before motion.

The offset is stored only in this plugin's gSender storage. It is not written to firmware or applied automatically to a probe routine.

## Install

Install `cnc-probe-offset-calibration-v0.1.0.zip` through gSender Plugin Manager. Open **Tools → Probe Offset Calibration**.

## Build

Requires Node.js and npm.

```text
npm install
npm run build
```

The UI bundle is written to `ui/`.

## Verification limits

The source and package build can be checked locally. The probe sequence, sign convention, movement, and controller input behavior have not been validated on a physical machine. Keep the spindle off, remain at the machine, and be ready to stop motion. The controller must already report probe transitions before calibration can run.
