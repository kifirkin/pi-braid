---
name: tunnel-control
description: "Use when traffic through a VPN or tunnel client fails while other traffic works: one service times out, a network extension reports disconnected, or a stale route survives an app restart. Refuses any client or platform whose facts were not derived from a real install, so the probe runs before the repair."
validated: 2026-11-03
verdict: UNVALIDATED
triggers:
  - "tunnel is down"
  - "vpn is down"
  - "vpn connects but nothing loads"
  - "tunnel disconnected"
  - "network extension died"
  - "reconnect the vpn"
  - "stale utun route"
  - "one service times out but other sites load"
  - "telegram times out"
  - "times out but other sites load"
---

# Tunnel Control

A GUI tunnel client is an app plus a system-level network extension that embeds a proxy core. The
extension can die while the app stays up: the routes it installed keep pointing at a device that no
longer carries traffic, so one service times out while everything else resolves. The client's own
status is not evidence in that state, because it reports the app, not the route.

Two consequences drive the whole procedure. Reachability is the only ground truth, and a repair runs
through the client's own control surface, never through process or extension surgery.

## Arm state

An arm is one (platform, client) pair. A row is usable only when its facts were derived from a real
install and the date is in the row; an unvalidated arm is probe-only and is never toggled.

| Platform | Client   | State                | Facts derived from                                       |
| -------- | -------- | -------------------- | -------------------------------------------------------- |
| macOS    | v2RayTun | VALIDATED 2026-11-03 | app bundle, URL schemes, extension processes, profiles   |
| macOS    | Happ     | UNVALIDATED          | vendor docs name no link that starts or stops the tunnel |
| macOS    | Incy     | UNVALIDATED          | vendor docs name the control links; no install here      |
| Windows  | any      | UNVALIDATED          | no install here                                          |
| Linux    | any      | UNVALIDATED          | no install here                                          |

Adding a row means deriving its facts with the recipe below and writing the date. Do not promote a
row by editing this table: an arm whose facts came from a documentation page is `UNVALIDATED` until
somebody derives them from the binary and the system's own state.

## 1. Probe, cheapest first

Run all three rungs before any repair, and record each answer.

| Rung          | macOS                                                                   | Windows                                                   | Linux                                           |
| ------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Reachability  | `curl -sS --max-time 6 -o /dev/null -w '%{http_code}' <known-endpoint>` | `Test-NetConnection <host> -Port 443`                     | `curl` as on macOS                              |
| Client status | `scutil --nc list` then `scutil --nc status "<profile>"`                | `Get-VpnConnection` then `netsh interface show interface` | `nmcli connection show --active` then `ip link` |
| Processes     | `pgrep -x <AppName>` and `pgrep -f <extension-bundle-id>`               | `Get-Process <name>`                                      | `pgrep -x <name>`                               |

Interpretation:

- Reachability is ground truth. Client says connected plus probe returns `000` or times out means a
  stale route, and the route only changes at a tunnel restart.
- A client may keep a stale anchor profile beside the live one. Enumerate every profile the client
  owns and report the connected one; the first row in the roster is not the answer.
- App alive, extension alive, status connected, probe answering means healthy. Do nothing.
- Never declare the tunnel down while the probe answers, whatever the client says.

## 2. Recover through the client's own surface

| Platform | Control surface                                                                     |
| -------- | ----------------------------------------------------------------------------------- |
| macOS    | `open "<scheme>://disconnect"`, wait about two seconds, `open "<scheme>://connect"` |
| Windows  | `rasdial "<name>" /disconnect` then `rasdial "<name>"`, or the client's own CLI     |
| Linux    | `nmcli connection down "<name>"` then `nmcli connection up "<name>"`                |

Verify within thirty seconds: the client reports connected and the probe returns a real status. The
clients in this table persist their configuration and regenerate the tunnel on connect, so a
recovery needs no re-authentication and no config edit.

If the client exposes no control surface you can derive, stop and hand the machine to its owner.
Opening the app by hand is a recovery step a person takes, not one an agent invents.

## Guardrails

- Never kill the app or its extension process as an automated step. A killed extension can leave the
  routes behind, which is the failure being repaired.
- Never toggle, reload or remove the system network extension. It can wedge the whole subsystem and
  take unrelated tunnels with it.
- Never edit a tunnel configuration file. The client rewrites it on connect, so the edit has no
  effect and fights the app's model.
- Never touch a profile the client does not own. A machine can carry several tunnel products, and
  they do not share a lifecycle.
- Never retry in a loop. If the rungs do not recover within a few minutes, report the probe output
  and escalate.
- Never act on an unvalidated arm. A guessed bundle id or deep link is worse than a refusal.

## Derive an arm before using it

Read the facts from the installed product and the system, never from a marketing page.

macOS:

```bash
plutil -extract CFBundleIdentifier raw /Applications/<App>.app/Contents/Info.plist
plutil -extract CFBundleURLTypes json -o - /Applications/<App>.app/Contents/Info.plist
ps aux | grep -i <name>          # app path and extension path
scutil --nc list                 # profiles, owning bundle id, state
strings -a /Applications/<App>.app/Contents/MacOS/<binary> | grep -i '<scheme>://'
```

Windows:

```powershell
Get-VpnConnection | Format-List Name,ServerAddress,ConnectionStatus
Get-Process | Where-Object { $_.Name -like '<name>*' }
Get-ChildItem 'HKLM:\SOFTWARE\Classes' | Where-Object { $_.PSChildName -like '<scheme>*' }
```

Linux:

```bash
nmcli -f NAME,TYPE,DEVICE connection show
ip link show
systemctl list-units --type=service | grep -i <name>
```

Write the derived facts into the arm table with the date. A row without a date is not an arm.

## What this does not cover

It does not install or configure a client, does not bypass a captive portal or an authentication
page, and does not diagnose a server-side outage. If reachability fails for every service and every
device, the tunnel is working and the far end is not, which is a different investigation.
