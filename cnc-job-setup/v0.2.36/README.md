# CNC Job Setup for gSender
**Latest release package:** [Download cnc-job-setup-v0.2.46.zip](https://github.com/bakstaaj/gSender-Plugins/releases/download/cnc-job-setup-v0.2.46/cnc-job-setup-v0.2.46.zip)

A configurable machine-profile page plus a per-job workflow launched from the gSender Carve visualizer. The included Makera Z1 profile is a starting point; duplicate it for other machines and configure their commands and offsets.

## Job workflow

1. Home the machine and wait for gSender to report Idle.
2. Choose job assists.
3. Enter stock dimensions and fixture placement. Press Next when stock is secured.
4. Set the origin. For the included Z1 Anchor1 profile, keep the machine at home; Next sends the configured G10 L20 P0 command to map home to X189.620 / Y192.790.
5. Run the required Z-height probe. The probe point is calculated from the loaded NC file. Whenever the controller requests a tool change before Run Job, a persistent prompt appears above the checklist. Install the requested tool and press “Tool changed · resume” to send M490.2 and release the firmware hold.
6. When the firmware reports that tool measurement is complete and gSender is Idle, continue to Run Job. Run Job sends the enabled assist commands and starts the loaded file. The tool-change prompt also appears if the controller is already in its Tool state when the checklist opens.

Configure and save profiles in Tools > CNC Job Setup. Open Job Setup from the Carve visualizer after loading an NC file. The plugin monitors the Z1 firmware responses for homing completion, tool-change prompts, and operation completion; it requires the machine:parse plugin permission.

## Makera Z1 profile notes

The default Z1 probe sequence sends M493.2 T-1 followed by M495 with the loaded file center and configured probe offsets. The firmware prompts for the probe, measures it, and probes the stock. After that operation completes, the wizard sends M493.2 T-1 followed by M6 Tn, where n is the first tool number found in the loaded job or the profile fallback. The firmware then prompts for the cutter and measures its height. These sequences are for manual tool changing only; do not use them with an ATC.

The Anchor1 origin defaults are X189.620 / Y192.790 mm. G10 L20 assigns those coordinates to the current machine position. The workflow homes first and expects the machine to remain at home until the origin command is applied. Do not jog away from home between those steps. The default assists use M331.x / M332.x commands; verify these commands against the controller profile. The plugin sends configured off commands when gSender reports that the job stopped.

Other controllers need commands and firmware responses compatible with the profile. In particular, automatic tool-change progression depends on the controller reporting its tool prompt and completion message. Verify configured motion and commands before machining.

## Build

Requires Node.js and npm.

```powershell
npm ci
npm run build
```

Package with package-plugin.ps1 and install the resulting ZIP through gSender Plugin Manager.
