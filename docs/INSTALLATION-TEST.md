# Installation acceptance test

Status: **not passed — do not publish to the marketplace**.

The automated core suite passes against the fake provider. The environment used for development was not Omarchy Quattro, prohibited opening a Unix-domain listening socket/FUSE mount, and had no safe public Proton auth bootstrap. RPC dispatch was tested in-process, but the required fresh-system test with a real account was not claimed.

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
