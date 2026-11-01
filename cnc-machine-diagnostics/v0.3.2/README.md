# CNC Machine Diagnostics for gSender
**Latest release package:** [Download cnc-machine-diagnostics-v0.3.3.zip](https://github.com/bakstaaj/gSender-Plugins/releases/download/cnc-machine-diagnostics-v0.3.3/cnc-machine-diagnostics-v0.3.3.zip)

A configurable diagnostics tool for CNC machines using gSender. Create and save machine profiles to show supported controls and sensors, assign each control its G-code commands, and map controller status fields to sensor indicators.

![CNC Machine Diagnostics page in gSender](screenshots/diagnostics-page.png)

## Features

- Machine profiles with configurable G-code toggles, sliders, and one-shot actions.
- Sensor mappings for GRBL `Pn:` tokens and controller-specific fields parsed by gSender.
- Live status polling every 700 ms while connected.
- Persistent profiles stored by gSender.
- A preconfigured **Makera Z1** profile as a working example of machine-specific controls and sensor mappings.

Commands are sent through gSender’s active controller connection. A successful send means gSender accepted the command; it does not confirm that an accessory physically changed state.

## Included Makera Z1 profile

The profile is configured for a Makera Z1 connected through the independent [CNC Machine TCP Bridge](https://github.com/bakstaaj/CNC-Machine-TCP-Bridge). It demonstrates how to configure controls and map the Z1’s standard GRBL signals and extended status fields. Other machines can use their own profiles with commands and status mappings appropriate to their controllers.

The example profile includes spindle and fan controls, extended output, light, anti-static, beeper, probe laser, laser mode, a laser beam test, and mappings for limit inputs, cover, E-stop, calibration, tool, ATC, rotary, and motor alarm signals.

### Laser controls in the Z1 profile

- **Laser mode** uses `M321.2` and `M322.2`; it changes controller mode and does not itself emit the beam.
- **Laser beam test** uses the Z1 firmware test path: enter laser mode, set test power with `M325 S…`, then enable the output with `M323`. `M324` turns the test output off.
- The slider selects 0–100% of firmware-configured test power. The Z1 firmware default is 10%, though the machine configuration may differ.
- The beam test is available only while gSender reports **Idle**. It emits a real laser beam. Use an appropriate enclosure and a safe beam path.

Other Z1 profile controls use commands confirmed for that machine, including `M3S{value}` / `M5` for spindle, `M811S{value}` / `M812` and `M801S{value}` / `M802` for fans, `M822` for light, and `M331.4` / `M332.4` for anti-static.

## Install

1. In gSender, open Plugin Manager and install `cnc-machine-diagnostics-v0.3.2.zip`.
2. Connect gSender to a controller and open **Tools → CNC Machine Diagnostics**.
3. Select the appropriate machine profile. Adjust and save its commands and sensor mappings as needed.
4. For the included Z1 profile, install and configure the CNC Machine TCP Bridge separately, connect gSender to `127.0.0.1:2323`, and select **Makera Z1** in the plugin.

A controller-specific sensor mapping works only if gSender receives that field in a parsed status report. Verify each output and sensor against the actual controller before relying on it.

## Build from source

Requires Node.js and npm.

```powershell
npm ci
npm run build
.\package-plugin.ps1
```

The build creates `cnc-machine-diagnostics-v0.3.2.zip` in this folder.

## Compatibility

Built for gSender `1.7.0-Edge-2`. Plugin packaging was verified. The included Z1 profile and outputs should be confirmed on the target machine before use.
