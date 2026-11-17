# gSender Machine Simulator v0.1.1

Adds profile-specific tool setter simulation to the gSender GRBL / grblHAL machine simulator.

- Installer with per-user program and data locations.
- Start, stop, launch UI, and uninstall controls in the Start menu.
- Optional automatic service start at Windows sign-in.
- Separate machine configuration and reusable stock library tabs.
- GRBL and grblHAL TCP simulation on `127.0.0.1:2327`.
- Machine setup UI on `http://127.0.0.1:4176/machine`.
- STL, STEP, and STP stock import; manual cube and cylinder stock; G38 probing against stock geometry.
- Keeps port 2323 for the Makera TCP bridge and 4173 for the other simulator.
- Adds an optional tool setter switch and global X/Y/Z contact-surface coordinates to each machine profile. Probe cycles can contact the setter as well as the active stock.

See [README.md](README.md) for installation and operating instructions.
