# Skillar connection diagnostics

Run the diagnostic against the exact installed plugin:

```sh
cd server
node diagnose-codex-connection.mjs /path/to/installed/skillar upstream-close 2 /path/to/close.jsonl
node diagnose-codex-connection.mjs /path/to/installed/skillar idle 1800 /path/to/idle.jsonl
```

Each JSONL file contains connection metadata, timestamped bridge stderr, and
before/after `search_skills` and `load_skill` results. It records counts, URI, error,
and duration, without skill bodies. Existing output files are never overwritten.

To observe an actual MacBook sleep/resume without triggering power changes:

```sh
node diagnose-sleep-wake.mjs /path/to/installed/skillar 86400 /path/to/sleep-wake.jsonl
```

The probe first verifies search/load and remains connected. It checks search
every 60 seconds while awake. If the connection dies before any recorded
sleep/wake, it creates a fresh baseline instead of attributing that earlier
failure to sleep. This periodic traffic means it is not the separate idle test.
It accepts only a
`pmset` system Sleep followed by a full Wake after arming; sleep-prevention
assertions, process pauses and maintenance DarkWake do not count. It records
post-wake calls on the existing bridge and a fresh bridge, then exits. A timeout
leaves the scenario unexecuted. Schedule a real sleep with the machine's user;
the probe itself only reads power logs and never suspends the computer.

`upstream-close` terminates exactly one SSH child of the newly created diagnostic
bridge. It does not restart shared sshd or terminate other clients. `idle` performs
no MCP calls during the interval. The same idle command can bracket a separately
scheduled laptop sleep/resume or sshd restart; record the actual operation and
timestamps alongside the log. These are distinct scenarios, not interchangeable
proof of a root cause.

## 2026-09-16 observations

- Plugin `0.1.0+codex.20260916075355`, Mac mini server commit `aebeca48afff`.
- A fresh Codex app-server ephemeral thread connects and reads 32 skills with
  verified content. The earlier running conversation's MCP connection returned
  `Not connected`.
- Closing only the diagnostic bridge's SSH child reproduces `Not connected` for
  both subsequent search and load calls. The bridge process stays alive and does
  not reconnect. The before calls succeeded against the same server.
- This establishes a missing reconnection path after upstream closure. It does
  **not** establish why the earlier conversation lost its connection.
- The 30-minute idle run is recorded separately. Actual machine sleep/resume and
  shared sshd restart need a coordinated maintenance interval; they have not been
  executed by the isolated-connection test.

Evidence lives with the PRD implementation record:
`langfuse-review-20260915/implementation/{fresh-codex-smoke.json,upstream-close.jsonl,idle-30min.jsonl}`.

## 2026-09-17 observations

An isolated OpenSSH 10.3p1 daemon on Mac mini loopback was stopped and restarted
while the installed bridge retained its authenticated SSH session. Search/load
before and after succeeded with the same connection ID and release `20260917.2`;
a fresh connection also succeeded. Restarting this listener alone did not close
established sessions. This does not cover restarting macOS's shared launchd SSH
service or terminating its child sessions. The test listener and its ephemeral
private keys were removed afterward; public port 22 was unchanged.

The MacBook power log contains no system sleep/full-wake transition for Sep 16–17
as of 10:46 KST, so it cannot establish sleep/resume behavior. A dedicated
observer is available for the actual sleep. The original connection-loss cause
remains unknown; neither successful listener restart nor synthetic child closure
proves that cause. Evidence: `implementation/mvp-closure/isolated-sshd.jsonl`.

At 11:15 KST, a separate diagnostic attempted to restart the default macOS
`system/com.openssh.sshd` service. An independent launchd rescue job was armed
before the attempt. `launchctl bootout` returned exit 1, `Operation not permitted`.
A later audit found that `sudo launchctl submit` had targeted `gui/501`, where
the helper ran as UID 501. The initial error is therefore not evidence that a
root operation was denied by SIP. The service remained loaded throughout.

At 11:46 KST, the supported `systemsetup` Remote Login operation was tested with
each privileged command explicitly using sudo and command UID verified as 0.
Turning Remote Login off was rejected with "requires Full Disk Access privileges";
Remote Login stayed On. Existing and fresh bridge search/load calls succeeded.
No shared-service restart was executed and no privacy permission was changed.
Evidence: `implementation/mvp-closure/systemsetup-sshd-v2.jsonl` and
`implementation/mvp-closure/systemsetup-sshd-v2-journals.json`.

The submitted diagnostic jobs also had KeepAlive enabled. A system-domain-only
cleanup did not remove them. All six task-owned jobs were subsequently booted
out of their actual GUI domain, and absence was verified in system, user and
GUI domains while Remote Login remained On. The failed repeated operations did
not restart SSH. Evidence: `implementation/mvp-closure/remote-jobs-cleanup.json`.
Future service diagnostics must use an explicit one-shot plist with KeepAlive
false, verify the execution UID, and record the actual launchd domain.

The sleep observer was paused around SSH diagnostics and armed at
11:47 KST with a fresh connection and a new log,
`implementation/mvp-closure/sleep-wake-20260917-final.jsonl`. Initial search
and load succeeded. Its deadline is September 18 at 11:47 KST; until a real
system Sleep/full-Wake pair is recorded, sleep/resume remains untested.

At 12:05:24 KST that observer's SSH transport received "closed by remote host"
and "Broken pipe" without a MacBook Sleep/full-Wake transition. A fresh SSH
connection worked afterward; Mac mini uptime did not indicate a host reboot.
The available server power and SSH logs did not identify a cause. This is an
actual unexpected disconnect, but it cannot be attributed to laptop sleep.

At 12:44 KST the observer was replaced with the baseline-checking version;
`implementation/mvp-closure/sleep-wake-20260917-continuation.jsonl` is the active
log. Terminating only this diagnostic's SSH child verified that an awake failure
is recorded as `baseline-lost` and a new successful search/load baseline is
armed. The deadline remains September 18 at 12:44 KST across reconnections.
The diagnostic does not add reconnection to the production bridge.

E-03 in PRD §6.1 requires three diagnostic conditions and documented uncertainty.
The isolated, real Mac mini sshd restart supplies the listener-restart condition;
the PRD does not require taking down the shared production SSH service. That
broader service restart remains explicitly unexecuted. The remaining E-03 gate
is a real laptop Sleep/full-Wake plus the existing/fresh connection results,
whether those calls succeed or fail. Automatic reconnection is scoped to E-29.
