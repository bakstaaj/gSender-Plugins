# CNC Machine Diagnostics for gSender

A configurable diagnostics tool for CNC machines using gSender. Create and save machine profiles to show supported controls and sensors, assign each control its G-code commands, and map controller status fields to sensor indicators.

![CNC Machine Diagnostics page in gSender](screenshots/diagnostics-page.png)

## Features

- Machine profiles with configurable G-code toggles, sliders, and one-shot actions.
- Sensor mappings for GRBL `Pn:` tokens and controller-specific fields parsed by gSender.
- Both controller modes query status every 700 ms while connected and on the Diagnostics page, including when the controller is in Alarm. Makera Z1 mode also reads Z1 extended status fields; Standard GRBL mode reads the `Pn:` pin field.
- GRBL sensor cards distinguish a controller that has never reported `Pn:` from one with no triggered inputs. After `Pn:` support has been observed, a report that omits `Pn:` clears the triggered-pin indicators, matching GRBL's status-report behavior.
- Persistent profiles stored by gSender.
- A preconfigured **Makera Z1** profile as a working example of machine-specific controls and sensor mappings.

Commands are sent through gSender’s active controller connection. A successful send means gSender accepted the command; it does not confirm that an accessory physically changed state.

## Included Makera Z1 profile

The profile is configured for a Makera Z1 connected through the independent [CNC Machine TCP Bridge](https://github.com/bakstaaj/CNC-Machine-TCP-Bridge). It demonstrates how to configure controls and map the Z1’s standard GRBL signals and extended status fields. Other machines can use their own profiles with commands and status mappings appropriate to their controllers.

For a Genmitsu Cubiko or another standard GRBL machine, open **Configuration → Machine profiles**, select or create its profile, and set **Controller status mode** to **Standard GRBL**. While that profile's Diagnostics page is open and the controller is in Idle or Alarm, the plugin sends `?` every 700 ms and reads the returned GRBL `Pn:` pin field. Map inputs to the letters reported by the controller, such as `X`, `Y`, `Z`, or `P`. Once the controller has reported a `Pn:` field, later reports without `Pn:` are interpreted as no inputs triggered, matching GRBL's status-report behavior. If it never reports `Pn:`, the controller firmware may not expose pin states.

The example profile includes spindle and fan controls, extended output, light, anti-static, beeper, probe laser, laser mode, a laser beam test, and mappings for limit inputs, cover, E-stop, calibration, tool, ATC, rotary, and motor alarm signals.

### Cubiko laser mode (standard GRBL)

On a Genmitsu Cubiko using standard GRBL, use the `$32` setting to select the operating mode:

- Send `$32=1` to enable laser mode.
- Send `$32=0` to return to CNC/router mode.
- Send `$$` and check the `$32` line to confirm the current setting.

These are GRBL settings, not the Makera Z1's `M321.2` / `M322.2` commands. The Z1 commands are specific to Z1 firmware and will be rejected by standard GRBL, as will other unsupported machine-specific commands. Keep the laser output disabled while changing modes and verify the controller response before operating the machine.

### Laser controls in the Z1 profile

- **Laser mode** uses `M321.2` and `M322.2`; it changes controller mode and does not itself emit the beam.
- **Laser beam test** uses the Z1 firmware test path: enter laser mode, set test power with `M325 S…`, then enable the output with `M323`. `M324` turns the test output off.
- The slider selects 0–100% of firmware-configured test power. The Z1 firmware default is 10%, though the machine configuration may differ.
- The beam test is available only while gSender reports **Idle**. It emits a real laser beam. Use an appropriate enclosure and a safe beam path.

Other Z1 profile controls use commands confirmed for that machine, including `M3S{value}` / `M5` for spindle, `M811S{value}` / `M812` and `M801S{value}` / `M802` for fans, `M822` for light, and `M331.4` / `M332.4` for anti-static.

## Install

1. In gSender, open Plugin Manager and install `cnc-machine-diagnostics-v0.3.3.zip`.
2. Connect gSender to a controller and open **Tools → CNC Machine Diagnostics**.
3. Select the appropriate machine profile and controller status mode. Adjust and save its commands and sensor mappings as needed.
4. For the included Z1 profile, install and configure the CNC Machine TCP Bridge separately, connect gSender to `127.0.0.1:2323`, and select **Makera Z1** in the plugin.

Both modes query status while connected and on the Diagnostics page, including in Alarm. Makera Z1 profiles additionally parse Z1 extended fields. A controller-specific sensor mapping works only if the controller reports that field. Verify each output and sensor against the actual controller before relying on it.

## Build from source

Requires Node.js and npm.

```powershell
npm ci
npm run build
.\package-plugin.ps1
```

The build creates `cnc-machine-diagnostics-v0.3.3.zip` in this folder.

## Compatibility

Built for gSender `1.7.0-Edge-2`. Plugin packaging was verified. The included Z1 profile and outputs should be confirmed on the target machine before use.
