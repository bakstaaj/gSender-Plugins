gSender Machine Event Notification Helper 0.1.20

Install:
1. Double-click Install Helper.cmd and approve the administrator prompt.
2. Open Machine Event Notifications in gSender Edge and select Pair helper. The plugin pairs automatically on this computer; no code needs to be copied.
3. Keep gSender Wireless Control enabled and reachable at the address entered in the plugin.
4. Configure email, ntfy phone push, or both in the plugin. Select Save settings.

Automatic pairing is restricted to the gSender Edge plugin origin http://127.0.0.1:8000. If gSender is configured to use a different local UI origin, pairing will be refused rather than exposing the helper token to another website.

For ntfy, install the ntfy app on your phone, generate a computer topic in the plugin, and subscribe to that exact server and topic in the app. Use the test push button before relying on alerts. The generated computer-name topic is predictable. Anyone who knows it can publish or subscribe on ntfy.sh; do not send confidential information through ntfy.sh.

The services are gSender Machine Event Email API and gSender Machine Event Monitor. View or control them in services.msc. The desktop shortcut opens Services. Run Uninstall-Helper.cmd as administrator to remove the services. Credentials and logs remain unless you explicitly run Uninstall-Helper.ps1 -PurgeData.

The helper sends no CNC commands. It requires no external PowerShell, Node.js, or NSSM installation; the runtime files are bundled.
