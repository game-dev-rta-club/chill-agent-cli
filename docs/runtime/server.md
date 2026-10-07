---
keyPoints: >-
  Foreground Web and macOS background startup share one server. Real use renews its
  idle deadline; polling does not. Requests and extension-reported work can delay exit.
---

# Run the Web workspace

For foreground development, build Web assets and run `node server.mjs --local`.
After [setup](data-and-updates.md), the supported macOS background commands are:

```sh
chill server start --local
chill server status
chill server restart --configured
chill server stop
```

Use the same `PORT` and `CHILL_AGENT_DATA_DIR` for every command. The default port is
4173. Status reports the live URL and log path. Background startup uses launchd;
it does not install login autostart. Unexpected exits restart, while a successful
idle shutdown stays stopped.

The server listens on loopback. `--local` keeps access local; `--configured` uses
saved remote-access preferences. Settings default to off. Read `settings remote
--help` before configuring an external URL; account and phone setup belong to
the integrating application's setup guide.

## Keep the public URL during updates

On macOS, the background Web service and cloudflared connector have separate
launchd services. `server restart --configured` releases the connector, replaces
Web with the prepared runtime, and reattaches to the same connector. During this
short interval the URL may be temporarily unavailable but stays the same.
Public Off, `server stop`, `--local`, and idle shutdown stop the connector too.
An unexpected Web crash can restart and reattach; a connector exit reports failure
without silently creating a new URL. The first migration from the older server-owned
connector requires a new URL. Foreground development still owns its connector.
A Quick Tunnel URL is not durable across connector restart, logout or reboot.

## When the server exits

The default idle timeout is three days and can be changed with `--idle-timeout`.
Opening the Web page, user activity and CLI mutations renew the deadline.
Background reads, presence polling and extension checks do not.

Once the deadline expires, the host waits for active requests, CLI commands and
extension-reported work to finish. It rechecks the deadline before exiting.
An extension's `busy()` determines whether its own ongoing or eligible work
requires the server; simply being enabled is not a generic keep-alive rule.
The standalone host does not infer this from every native agent turn itself.

After an idle exit, start the server again to access Web. Stopping Web and pausing
an agent are separate operations; see [agent controls](../agent/feedback-and-controls.md).

Implementation: [background service](../../bin/chill-server.mjs),
[idle timer](../../lib/server-lifecycle.mjs), [host](../../server.mjs).
