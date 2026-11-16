# gSender Machine Simulator 0.1.0

The gSender Machine Simulator provides a local GRBL or grblHAL controller over TCP so gSender can connect as though a machine were attached. It simulates controller settings, machine coordinates, homing, jogging, motion timing, G-code, and probing against reusable stock geometry.

## Install on Windows

1. Download and extract `gSender-Machine-Simulator-v0.1.0.zip`.
2. Run **Install Machine Simulator.cmd**. The installer needs Node.js 20 or newer with npm. If it cannot find Node.js, install the current LTS release from [nodejs.org](https://nodejs.org/) and run the installer again.
3. The installer copies the simulator to `%LOCALAPPDATA%\Programs\gSender Machine Simulator`, installs its Node packages, and creates Start Menu shortcuts for Start, Stop, Launch UI, and Uninstall.
4. At the prompt, choose whether to start the simulator automatically each time you sign in. The installer registers a per-user Windows scheduled task; no administrator access is needed.

The simulator stores machine profiles, stock library items, and other settings in `%LOCALAPPDATA%\gSender Machine Simulator\Data`. Logs are in `%LOCALAPPDATA%\gSender Machine Simulator\Logs`.

## Start, stop, and open the UI

- **Start Machine Simulator** starts the local service in the background.
- **Launch Machine Simulator UI** starts the service if needed and opens the configuration page in your browser.
- **Stop Machine Simulator** stops the service. If sign-in startup is enabled, it starts again at your next Windows sign-in.
- You can also run the matching `.cmd` controls in the extracted package folder.

The configuration page is at [http://127.0.0.1:4176/machine](http://127.0.0.1:4176/machine). The TCP controller listens at **127.0.0.1:2327**. In gSender, choose an Ethernet/TCP connection and enter that address. Port 2323 is left for the Makera TCP bridge; port 4173 is left for the other simulator.

## Configure a simulated machine

1. Open **Machine Configs**.
2. Create or select a named profile, choose **GRBL** or **GRBLHAL**, and upload a controller `$$` text dump if you have one.
3. Edit EEPROM values in the table and choose **Save & use this profile**. The running TCP controller will use that profile.
4. Connect gSender to `127.0.0.1:2327`. If the simulator was restarted, reconnect gSender.

Machine profiles store firmware identity and EEPROM settings. Stock is stored separately and can be reused with any profile.

## Create and reuse stock

1. Open **Stock Library** and enter a descriptive name.
2. Choose **Import STL / STEP** to load an STL, STEP, or STP file, or choose **Enter dimensions** to create a cube or cylinder.
3. Set Z rotation, the probe tip diameter, and global X/Y/Z placement in machine coordinates. Imported models use their file origin; cubes use the lower corner; cylinders use the base center.
4. Choose **Import and save stock** or **Create and save stock**. The item is added to the library and becomes active immediately.
5. Use **Load** on another library row to activate saved stock. **Apply placement** saves the current placement with that entry. **Clear active stock** leaves library items available for later.

G38.2–G38.5 probing uses the active stock mesh and probe tip size to find contact and release positions. This is simulated feedback for sender development; it does not model an electrical probe or physical machine behavior.

## Restart, update, and uninstall

Use the **Restart server** button in the configuration page after changing simulator code or environment settings. gSender will disconnect briefly and must reconnect. To update, stop the service, extract the new release, and run its installer again. Existing data under `%LOCALAPPDATA%\gSender Machine Simulator\Data` is kept.

Use the **Uninstall Machine Simulator** shortcut to stop the service, remove its sign-in task and shortcuts, and delete the installed application. The uninstaller asks whether to keep or remove the separate Data folder.

## Developer files

The `app` folder contains the simulator source. From that folder, run `npm ci` and then `npm start`; set `SIMULATOR_PORT=4176` and `MACHINE_SIM_TCP_PORT=2327` when running it beside the plugin simulator. Set `SIMULATOR_STATE_DIR` to keep runtime data outside the source tree.

The TCP listener binds to loopback (`127.0.0.1`) for local gSender connections. It is not exposed to other computers on the LAN.
