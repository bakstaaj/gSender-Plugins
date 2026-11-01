# CNC Camera Monitor Local Bridge
**Latest release package:** [Download camera-monitor-local-bridge-v0.1.0.zip](https://github.com/bakstaaj/gSender-Plugins/releases/download/camera-monitor-local-bridge-v0.1.0/camera-monitor-local-bridge-v0.1.0.zip)

**Prototype 0.1.0 · Windows 10+ 64-bit**

The Local Bridge runs separately from gSender and relays ONVIF/RTSP camera streams through go2rtc’s browser-compatible WebRTC viewer for CNC Camera Monitor. It runs on the same Windows computer as gSender and does not send video to a cloud service. Common H.264 feeds stay encoded as H.264; this package does not require FFmpeg transcoding.

## Install and start

1. Extract `camera-monitor-local-bridge-v0.1.0.zip` inside gSender's `gsender_plugins` folder. You can extract it anywhere convenient if you do not know that folder; the installer copies the bridge to `C:\rtsp_bridge`.
2. Double-click **Install Camera Bridge.cmd**. If Windows asks for administrator approval to create `C:\rtsp_bridge`, approve the prompt. The installer copies the bridge files, creates a **CNC Camera Bridge** shortcut on the Desktop, and starts the bridge.
3. Keep the bridge console window open while using the camera. To start it again later, double-click the Desktop shortcut. Close the console window to stop the bridge.
4. In Camera Monitor, choose **Local RTSP / ONVIF bridge** and click **Configure cameras** to open the go2rtc setup page inside the plugin. If needed, the same local page is available at **http://127.0.0.1:1984/**.

The console confirms the bridge server started; it does not list or create cameras. Camera discovery and stream setup happen in go2rtc's local page, which the plugin can display in its configuration panel. The bridge's web/API listener is bound to `127.0.0.1`, so it is available only on this computer.

## Camera view in gSender

After connecting the plugin to the local stream, the feed appears in the Camera Monitor view and can stay open over the Carve workspace:

![Camera Monitor overlay in gSender Carve, showing the camera feed alongside the visualizer](screenshots/carve-view.png)

This screenshot shows the plugin's Carve viewing area. The bridge supplies video through its local WebRTC viewer; the overlay itself remains view-only and does not control the CNC.

## Discover and save a camera stream

The go2rtc page has separate **add** and **config** pages. Use **add** to discover or test a camera. Use **config** to create named streams that persist after the bridge restarts.

### ONVIF discovery

1. In the go2rtc page, click **add** in the top navigation.
2. Find the **ONVIF** discovery section and start discovery. The computer and camera need to be on the same local network/subnet, and the network must allow ONVIF discovery traffic.
3. Use the discovered camera address to identify the camera. Discovery is for finding/testing the device; it does not by itself create a saved stream.
4. Click **config** in the top navigation. In the YAML editor, add a named stream under `streams:`. For example:

   ```yaml
   streams:
     cam1: "onvif://CAMERA_USER:CAMERA_PASSWORD@192.168.1.50:80"
   ```

5. Replace the example username, password, IP address, and ONVIF port with the camera's actual details. Click **Save & Restart**. The name before the colon (`cam1`) is the stream name the plugin will use.

If discovery does not find the camera, check its IP address and ONVIF settings in the camera's own app or documentation. You can also enter its RTSP URL manually as described below. ONVIF ports vary by camera; `80` is only an example.

### Enter an RTSP URL

If you know the camera's RTSP URL, skip discovery and create the stream directly in **config**. Replace all example values with the camera's real credentials, address, port, and path, then click **Save & Restart**:

```yaml
streams:
  cam1: "rtsp://CAMERA_USER:CAMERA_PASSWORD@192.168.1.50:554/stream1"
```

Use the exact path and credentials supplied by the camera manufacturer. If a username or password contains URL-reserved characters (such as `@`, `:`, `/`, or `#`), URL-encode those characters. The source URL is saved in the local go2rtc configuration, so protect the bridge folder as you would a file containing a camera password.

### Use two cameras

Give each camera a distinct stream name in go2rtc. For example:

```yaml
streams:
  cam1: "rtsp://CAMERA_USER:CAMERA_PASSWORD@192.168.1.50:554/stream1"
  cam2: "rtsp://CAMERA_USER:CAMERA_PASSWORD@192.168.1.51:554/stream1"
```

The names `cam1` and `cam2` are examples; you choose them. You can use ONVIF sources instead of RTSP URLs if your cameras support ONVIF:

```yaml
streams:
  cam1: "onvif://CAMERA1_USER:CAMERA1_PASSWORD@192.168.1.50:80"
  cam2: "onvif://CAMERA2_USER:CAMERA2_PASSWORD@192.168.1.51:80"
```

Put both entries under the single `streams:` heading in **config**, then click **Save & Restart**. In Camera Monitor, set each profile's stream path to the matching name:

| Plugin profile | Stream name | Stream URL path |
| --- | --- | --- |
| Camera 1 | `cam1` | `/stream.html?src=cam1&mode=webrtc&background=false` |
| Camera 2 | `cam2` | `/stream.html?src=cam2&mode=webrtc&background=false` |

The **Use local RTSP bridge** preset fills in `cam` by default. After using it, change `src=cam` in the path field to `src=cam1` or `src=cam2` for the corresponding profile. The name in `src=` must exactly match the key under `streams:`.

## Connect CNC Camera Monitor

In the plugin's **Camera type** menu, choose **Local RTSP / ONVIF bridge**, then enter these settings for a stream named `cam1`:

| Setting | Value |
| --- | --- |
| Protocol | HTTP |
| Camera IP / host | `127.0.0.1` |
| Port | `1984` |
| Stream URL path | `/stream.html?src=cam1&mode=webrtc&background=false` |

Or click **Use local RTSP bridge** in the plugin to fill in the local host, port, and viewer path. Change `src=cam` to the exact stream name you saved, such as `src=cam1`, then click **Connect camera**. go2rtc’s built-in WebRTC viewer handles browser playback; stream errors appear in its viewer area.

The plugin can tell whether the local viewer page loaded, but does not inspect the video inside that page. Use the bridge viewer’s own status and go2rtc page to confirm the camera stream is producing frames.

## Limits and troubleshooting

- ONVIF discovery can fail when the camera is on a guest Wi-Fi, another VLAN/subnet, or a network that blocks multicast discovery. Try entering the camera's RTSP URL manually.
- Camera-specific RTSP authentication, encryption, and codec support vary. H.264 is the best starting choice for browser playback; H.265 support depends on browser and hardware.
- If the setup page does not open, open `http://127.0.0.1:1984/` manually and check the bridge console for a port conflict.
- This is a view-only video path. It does not start, stop, pause, or control CNC motion.

## Included third-party software

This package includes go2rtc v1.9.14 under the MIT License. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [LICENSE-go2rtc.txt](LICENSE-go2rtc.txt). The upstream project publishes Windows 10+ x64 binaries and documents its ONVIF discovery and stream endpoints: [go2rtc releases](https://github.com/AlexxIT/go2rtc/releases) · [ONVIF notes](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/internal/onvif/README.md).
