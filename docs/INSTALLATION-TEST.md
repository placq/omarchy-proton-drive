# Installation acceptance test

Status: **developer-preview path passed on the development workstation; clean-machine and writable-flow gates remain open — do not publish to the marketplace**.

The automated core suite, live fake-provider desktop test and read-only real-account path pass on Omarchy Quattro, including browser login, OS secret storage, Unix socket, session D-Bus bridge, FUSE mount, one Nautilus bookmark, account/storage bar panel, on-demand download and service restart recovery. A clean-system marketplace installation and conflict-safe real writes are not yet claimed.

Release gate:

1. fresh Omarchy Quattro with no source checkout;
2. install plugin from marketplace;
3. click Install integration;
4. complete browser login and 2FA/security key;
5. verify sidebar entry after reboot;
6. browse and open a real cloud-only file;
7. drag a file into Drive and verify remote content;
8. edit offline, reboot, reconnect and verify upload;
9. force a remote revision conflict and verify both copies;
10. uninstall with dirty staging and verify refusal.
