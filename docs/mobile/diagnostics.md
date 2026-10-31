---
kind: living
status: current
---

# Mobile diagnostics

A paired phone reports facts about its own health to the Desktop it is paired with, so a failure
that happened while nobody watched the phone still leaves a record in Desktop's Server log.

## Previous abnormal exit

When Caxri Mobile starts on Android 11 or later, it reads the most recent
[`ApplicationExitInfo`](https://developer.android.com/reference/android/app/ApplicationExitInfo)
Android kept for the app's main process. Once the gateway connects, the app reports that exit with
`mobile.diagnostics.reportExit` when its reason names a failure:

| Android reason                    | Reported `reason`          |
| --------------------------------- | -------------------------- |
| `REASON_CRASH`                    | `crash`                    |
| `REASON_CRASH_NATIVE`             | `crash-native`             |
| `REASON_ANR`                      | `anr`                      |
| `REASON_LOW_MEMORY`               | `low-memory`               |
| `REASON_INITIALIZATION_FAILURE`   | `initialization-failure`   |
| `REASON_EXCESSIVE_RESOURCE_USAGE` | `excessive-resource-usage` |

A user swipe, an app update, a permission change, or an ordinary background kill is not a failure
and is never reported. Earlier Android versions keep no exit history, so they report nothing.

The report carries only the reason, the exit time, the app version and build number, and for a
Java or Kotlin crash the fully qualified exception class. The app records that class in an
uncaught-exception handler just before the process dies, and attaches it only when the recorded
time is within a minute of Android's exit time. The exception message and stack never leave the
phone, since either may quote Session or file content.

The phone remembers the exit time of the last exit the Server accepted, so each exit is reported
once. A report whose reply was lost is sent again on the next connection; the Server keeps the
latest exit time per device and logs a repeated report only once per Server lifetime.

The Server writes one `warn` entry, `mobile_gateway.previous_exit`, with the device ID and the
reported fields. Find a phone's crashes with the Server log query, filtered by that event.

Every role may call `mobile.diagnostics.reportExit`, since it reads no Desktop data; see
[authorization.md](authorization.md).
