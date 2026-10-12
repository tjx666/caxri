/**
 * SSH Host events of the structured-log registry (`logEventCatalog.remoteSsh` in `./logging.ts`), written by Desktop
 * Main while it connects to, installs, and launches a Server on an SSH Host. Records carry closed enums, durations, and
 * byte counts only: never a destination, prompt answer, or remote file content.
 */
export const remoteSshLogEvents = {
    /**
     * An askpass prompt settled. `fields.kind` is the `RemoteAskpassKind`, `fields.outcome` is `answered` or
     * `cancelled`, with the time the user took.
     */
    askpassPrompted: 'remote_ssh.askpass_prompted',
    /**
     * `ensure` failed. `fields.reason` is a closed `RemoteFailureReason` and `fields.phase` the phase that failed.
     */
    attachFailed: 'remote_ssh.attach_failed',
    /**
     * The local loopback forward to the remote Server endpoint was established, with attempts and duration.
     */
    forwarded: 'remote_ssh.forwarded',
    /**
     * An application layer was installed. `fields.runtimeSource` is `cached`, `remote-download`, or `local-upload`.
     */
    installed: 'remote_ssh.installed',
    /**
     * A remote Server is attachable. `fields.outcome` is `adopted` (already running) or `started`.
     */
    launched: 'remote_ssh.launched',
    /**
     * The ControlMaster exited. `fields.wasReady` separates a connection loss from a failed connect.
     */
    masterClosed: 'remote_ssh.master_closed',
    /**
     * The ControlMaster became ready, with the time from spawn to the first successful `-O check`.
     */
    masterReady: 'remote_ssh.master_ready',
    /**
     * An SSH Host window's connection phase changed. `fields.phase` and `fields.previousPhase` are
     * `RemoteConnectionPhase` values, `fields.reason` the failure's `RemoteFailureReason` (or null), and `durationMs`
     * the time spent in the previous phase.
     */
    phaseChanged: 'remote_ssh.phase_changed',
    /**
     * The SSH Host was probed: architecture, glibc version, and whether the build and runtime were already present.
     */
    probed: 'remote_ssh.probed',
} as const;
