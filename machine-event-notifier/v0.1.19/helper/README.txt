gSender Machine Event Notification Helper 0.1.17

Install:
1. Double-click Install Helper.cmd and approve the administrator prompt.
2. Copy the one-time pairing code from the installer window into the Machine Event Notifications plugin.
3. Keep gSender Wireless Control enabled and reachable at the address entered in the plugin.
4. Configure email, ntfy phone push, or both in the plugin. Select Save settings.

For ntfy, install the ntfy app on your phone, generate a computer topic in the plugin, and subscribe to that exact server and topic in the app. Use the test push button before relying on alerts. The generated computer-name topic is predictable. Anyone who knows it can publish or subscribe on ntfy.sh; do not send confidential information through ntfy.sh.

The services are gSender Machine Event Email API and gSender Machine Event Monitor. View or control them in services.msc. The desktop shortcut opens Services. Run Uninstall-Helper.cmd as administrator to remove the services. Credentials and logs remain unless you explicitly run Uninstall-Helper.ps1 -PurgeData.

The helper sends no CNC commands. It requires no external PowerShell, Node.js, or NSSM installation; the runtime files are bundled.


