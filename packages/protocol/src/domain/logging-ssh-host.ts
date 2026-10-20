/**
 * SSH Host events of the structured-log registry (`logEventCatalog.sshHost` in `./logging.ts`), written by Desktop Main
 * while it connects to, installs, and launches a Server on an SSH Host. Records carry closed enums, durations, and byte
 * counts only: never a destination, prompt answer, or remote file content.
 */
export const sshHostLogEvents = {
    /**
     * An askpass prompt settled. `fields.kind` is the `SshHostAskpassKind`, `fields.outcome` is `answered` or
     * `cancelled`, with the time the user took.
     */
    askpassPrompted: 'ssh_host.askpass_prompted',
    /**
     * `ensure` failed. `fields.reason` is a closed `SshHostFailureReason` and `fields.phase` the phase that failed.
     */
    attachFailed: 'ssh_host.attach_failed',
    /**
     * The local loopback forward to the remote Server endpoint was established, with attempts and duration.
     */
    forwarded: 'ssh_host.forwarded',
    /**
     * An application layer was installed. `fields.runtimeSource` is `cached`, `remote-download`, or `local-upload`.
     */
    installed: 'ssh_host.installed',
    /**
     * A remote Server is attachable. `fields.outcome` is `adopted` (already running) or `started`.
     */
    launched: 'ssh_host.launched',
    /**
     * The ControlMaster exited. `fields.wasReady` separates a connection loss from a failed connect.
     */
    masterClosed: 'ssh_host.master_closed',
    /**
     * The ControlMaster became ready, with the time from spawn to the first successful `-O check`.
     */
    masterReady: 'ssh_host.master_ready',
    /**
     * An SSH Host window's connection phase changed. `fields.phase` and `fields.previousPhase` are
     * `SshHostConnectionPhase` values, `fields.reason` the failure's `SshHostFailureReason` (or null), and `durationMs`
     * the time spent in the previous phase.
     */
    phaseChanged: 'ssh_host.phase_changed',
    /**
     * The SSH Host was probed: architecture, glibc version, and whether the build and runtime were already present.
     */
    probed: 'ssh_host.probed',
} as const;
