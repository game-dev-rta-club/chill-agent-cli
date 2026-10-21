---
keyPoints: >-
  More → Public link opens access controls and a QR. The QR opens the link; the device
  connects once with the panel's 6-digit access code, hidden until Show. Connected
  devices are listed and disconnect one by one. Fixed URLs and Access are prepared in the
  user's own Cloudflare CLI.
---

# Open the workspace from another device

On your computer, choose **More → Public link** and turn it On. Confirm the
scope, then scan the QR with your phone's camera, or send the address with
**Copy link** to another computer. The device asks for the 6-digit access
code. The panel hides the code so a glance at your screen does not give it
away; press **Show** to read it, and type it on the device. After connecting,
the device opens the Goal the link pointed to. The **More** link inside that
panel explains access and custom URLs.

## Who can open it

A device opens the workspace only after it connects with the access code. The
code has six digits, like the one-time codes of two-step sign-in, and exists
only while the panel on the computer shows it. It works once, changes after 10
minutes, stops working after five wrong tries and ends when you turn the link On or Off; opening the panel then shows a new one. No account is
created: the device keeps a cookie, and the panel lists it under **Connected
devices** with its system, browser and time of connection. **Disconnect** on a
row removes that device; **Disconnect all** removes every device. A removed
device needs a new code to come back. The computer running chill-agent never
needs to connect.

The skill checks for `cloudflared` during first setup and asks before installing
it. If you chose local-only use, ask your agent to prepare Public link when you
need it. A failed link does not mean your local workspace has stopped; ask the
agent to check the tool and connection instead of repeatedly toggling On.

Temporary links need `cloudflared` installed. Connected devices can view and
reply to every Goal in this workspace, and confirm a prepared update. Turning the
link On or Off and disconnecting devices stay on the computer. Off closes the tunnel
while the local Web stays available. It preserves the saved custom connection
and notification registrations. A connection failure leaves local Web usable
and does not silently switch a custom connection to a temporary one.

The computer and server must stay running. Prepared Web updates use
`chill server restart --configured`: the public link stays the same while Web
restarts. Public Off, full server stop, or restarting the computer closes the
connection. The first update from the old server-owned connection changes the
URL once. A temporary URL changes when the
tunnel restarts; open the new QR and reconnect phone notifications. Use a fixed
URL to keep the address. Cloudflare's Quick Tunnel service is intended for
trying things, without an uptime guarantee.

## Keep a fixed URL

Prepare this in your own terminal and Cloudflare account. The Web never asks
for an account API token. You need a Cloudflare account, a domain managed there,
`cloudflared`, and a locally managed named tunnel. Dashboard token tunnels are
not supported by this connector.

1. Follow [Cloudflare's local tunnel guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/):
   run `cloudflared tunnel login`, then `cloudflared tunnel create chill-agent`.
   Keep the generated credentials file on this computer.
2. Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
   for your chosen hostname, with an Allow policy for the people who may enter.
   Configure the identity provider or email one-time PIN as needed. A tunnel
   alone does not restrict access. Record the Access team name and application AUD.
3. After Access is ready, connect DNS with
   `cloudflared tunnel route dns <TUNNEL-ID> chill.example.com`.
4. Run `chill settings remote --help` for the current JSON format. Save a local
   file containing the fixed HTTPS URL, tunnel ID, credentials-file **path**,
   Access team name and AUD, then apply it with
   `chill settings remote --file /absolute/path/to/remote.json`.
5. In the Public link panel, turn Off and On to use the saved connection. It should
   show your saved hostname. Verify the link on your phone and verify that an
   unauthorized signed-in user is denied before sharing it.

The account management certificate (`cert.pem`) and per-tunnel credentials
have different powers. Do not paste either file into a chat or Web form.
The connector uses the per-tunnel file path and checks Access JWTs at ingress.
See [Cloudflare's credential explanation](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/tunnel-permissions/).

A server launched with `--configured` resumes the saved public On/Off choice.
`--local` starts with public access Off. The panel can start or stop the tunnel
without restarting Web. CLI-only distributions use their own server lifecycle;
follow their installed help.

Public access and [notifications](notifications.md) are independent. Push can
still arrive while the public link is Off, but opening the Goal then needs the
public link to be running. Access-protected phone delivery and login may depend
on the browser; verify the end-to-end experience on your own device.
