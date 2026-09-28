---
kind: living
status: current
---

# Hook turn recovery

A lifecycle hook can establish a running turn even when provider metadata is temporarily absent.
Caxri preserves that state through isolated unknown readings. A successful CLI `agent control
interrupt` and a standalone Terminal Escape use the same coordinator entry: release the in-flight
hook turn and immediately request current provider evidence. A stale Endpoint or failed signal
does not change hook ownership. Neither interruption fabricates completion.

A turn with at least three consecutive unknown observations and two minutes without hook or
trustworthy running evidence releases its hook protection. The interval starts no earlier than
the first unknown observation. Accepted tool and subagent hooks reset the unknown sequence too.
After an unknown observation, the coordinator schedules further observations at one-minute
intervals until it has enough evidence; recovery does not depend on further Terminal output.
The existing 30-minute hard bound remains active. Each expiry logs `agent.hook_turn_expired`
with a closed reason (`unknownEvidence` or `hardTimeout`), count, and duration.

Expiry requests fresh metadata and may display unknown; it never publishes a completed turn,
adds unread attention, sends a completion notification, or kills an Agent. New lifecycle activity
can immediately establish running again. Launch replacement, interruption, settlement, removal,
and coordinator shutdown cancel the old turn's timer.

A real generation that stays silent for two minutes without hooks or readable metadata may lose
its running cue under this policy. Unknown reports insufficient evidence; it does not claim the
work ended. Both interruption paths also clear compaction, and an actual hook-turn interruption
logs `agent.hook_turn_interrupted` with `escape` or `signal`. Escape without a protected turn or
compaction does not trigger a fresh metadata scan.
