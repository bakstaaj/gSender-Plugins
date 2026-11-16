# gSender Machine Simulator v0.1.0

First standalone Windows release of the gSender GRBL / grblHAL machine simulator.

- Installer with per-user program and data locations.
- Start, stop, launch UI, and uninstall controls in the Start menu.
- Optional automatic service start at Windows sign-in.
- Separate machine configuration and reusable stock library tabs.
- GRBL and grblHAL TCP simulation on `127.0.0.1:2327`.
- Machine setup UI on `http://127.0.0.1:4176/machine`.
- STL, STEP, and STP stock import; manual cube and cylinder stock; G38 probing against stock geometry.
- Keeps port 2323 for the Makera TCP bridge and 4173 for the other simulator.

See [README.md](README.md) for installation and operating instructions.
