# Third-party notices

- **occt-import-js 0.0.23** — LGPL-2.1. The importer and OpenCascade license texts are included under `ui/occt/license.occt-import-js.txt` and `ui/occt/license.occt.txt` in the plugin package. Upstream source: [kovacsv/occt-import-js](https://github.com/kovacsv/occt-import-js). The WebAssembly module is shipped as a separate replaceable resource at `ui/occt/occt-import-js.wasm`.
- **clipper-lib 6.4.2** — Boost Software License 1.0. License text: [boost.org/LICENSE_1_0.txt](https://www.boost.org/LICENSE_1_0.txt). Upstream source: [junmer/clipper-lib](https://github.com/junmer/clipper-lib).
- **@sienci/gsender-plugin-sdk 0.2.2** — SDK used at build time; it is not bundled as an additional runtime library.

The plugin's own source is shipped alongside its packaged UI in the project workspace. The OCCT importer is a separate script and WebAssembly resource rather than being merged into the plugin application bundle.
