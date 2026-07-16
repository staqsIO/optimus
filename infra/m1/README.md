# M1 Satellite Runner — launchd wrapper

Wraps `node src/runner.js --agents=...` in a macOS LaunchAgent so it survives logout, reboot, and crashes — without anyone hand-starting iTerm tabs. Resolves [STAQPRO-291](https://linear.app/staqs/issue/STAQPRO-291).

## What this fixes

Before launchd:
- Eric started runners by hand in iTerm tabs (`node src/runner.js --agents=...`).
- Multiple tabs → multiple processes with overlapping agent sets → duplicate task claims and wasted ticks.
- Reboot or laptop sleep → runners gone with no auto-recovery.
- A 4-day-old orphaned runner survived a logout via `launchd` reparenting and went unnoticed for weeks (running stale code).

After:
- One canonical agent list lives in `runner.sh`.
- macOS auto-restarts the process on crash (`KeepAlive` + `ThrottleInterval=30s`).
- Logs in a known place (`~/Library/Logs/staqs-optimus-runner.{log,err}`).
- Restart from anywhere is one command.

## Install

From the M1, after pulling latest `main`:

```sh
bash infra/m1/install.sh
```

Idempotent — re-run after editing `runner.sh` or the plist template to apply changes. The script:
1. Renders `staqs.optimus.runner.plist.template` with your `$HOME`.
2. Boots out any existing `staqs.optimus.runner` instance.
3. Kills stray manually-started `runner.js` processes (defends against duplicate claimers).
4. Bootstraps the new service.
5. Verifies the PID and prints the operator commands.

## Operate

| What | Command |
|---|---|
| Status | `launchctl print gui/$(id -u)/staqs.optimus.runner` |
| Restart | `launchctl kickstart -k gui/$(id -u)/staqs.optimus.runner` |
| Stop (until next reboot/login) | `launchctl bootout gui/$(id -u)/staqs.optimus.runner` |
| Tail logs | `tail -f ~/Library/Logs/staqs-optimus-runner.log` |
| Tail errors | `tail -f ~/Library/Logs/staqs-optimus-runner.err` |
| Uninstall | `bash infra/m1/uninstall.sh` |

Any restart can also be triggered remotely once STAQPRO-290 Phase 2 lands a board control — that PR depends on this one.

## Change the agent set

To change the persistent agent set, edit the default agent list in `runner.sh` (or add an explicit `OPTIMUS_AGENTS=...` assignment there), commit, then re-run `install.sh`. The wrapper also accepts a one-off env override:

```sh
OPTIMUS_AGENTS=executor-coder,claw-workshop launchctl kickstart -k gui/$(id -u)/staqs.optimus.runner
```

## Env vars

`runner.sh` does not source `~/Optimus/autobot-inbox/.env`. Instead, `src/runner.js` loads env vars via `dotenv/config`, so `DATABASE_URL`, `ANTHROPIC_API_KEY`, etc. are still available to the runner. `RUNNER_ID` defaults to `m1-macbook` (the friendly identity surfaced on `/runners`).

## Crash test

Validate that KeepAlive actually respawns:

```sh
launchctl print gui/$(id -u)/staqs.optimus.runner | grep '^\tpid'
kill -9 <that-pid>
sleep 35      # exceeds ThrottleInterval=30
launchctl print gui/$(id -u)/staqs.optimus.runner | grep '^\tpid'   # different PID
```

## Why these specific plist keys

| Key | Reason |
|---|---|
| `RunAtLoad` | Start the runner when the LaunchAgent loads (login, install). |
| `KeepAlive: { SuccessfulExit: false, Crashed: true }` | Respawn on crash, but a clean exit (e.g. SIGTERM during uninstall) won't loop. |
| `ThrottleInterval: 30` | Crash loops back off — won't burn a host on rapid-restart pathologies. |
| `ProcessType: Background` | Hint to macOS that this is a long-running daemon, not interactive. |
| `Nice: 5` | Modest deprioritization so M1 stays responsive under runner load. |
| `EnvironmentVariables: PATH` | Subprocess `node` needs `/opt/homebrew/bin`; launchd defaults are sparse. |

## Out of scope (separate tickets)

- Auto `git pull` on launchd start — would need a deploy SSH key (macOS keychain doesn't work over headless launchd). Code updates remain manual via `git pull` from a logged-in shell.
- Multi-runner topology (one launchd label per host or per agent group) — not needed until we have more than one mac running spawnCLI agents.
- Dashboard restart button — STAQPRO-290 Phase 2.
