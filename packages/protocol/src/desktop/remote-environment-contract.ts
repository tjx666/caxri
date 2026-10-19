import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const noParameters = z.object({}).default({});

/**
 * Upper bound for a typed SSH destination such as `user@build-box:2222` or a `~/.ssh/config` alias.
 */
export const MAX_SSH_DESTINATION_LENGTH = 255;

/**
 * An SSH destination as the user wrote it: a `~/.ssh/config` alias or `[user@]host[:port]`. A leading `-` is refused so
 * the value can never be parsed by OpenSSH as an option, and whitespace or control characters cannot split argv.
 */
export const sshDestinationSchema = z
    .string()
    .min(1)
    .max(MAX_SSH_DESTINATION_LENGTH)
    .regex(/^[^\s-]\S*$/u, 'SSH destination must not start with "-" or contain whitespace')
    .refine(
        // eslint-disable-next-line no-control-regex -- the rule exists to refuse control characters
        (value) => !/[\u{0}-\u{1F}\u{7F}]/u.test(value),
        'SSH destination contains a control character',
    );

/**
 * Ordered connection phases of an SSH Host window. `installing` is the only phase that reports transfer progress.
 */
export const remoteConnectionPhases = [
    'connecting',
    'probing',
    'installing',
    'starting',
    'connected',
    'reconnecting',
    'disconnected',
    'stopped',
    'failed',
] as const;

export const remoteConnectionPhaseSchema = z.enum(remoteConnectionPhases);
export type RemoteConnectionPhase = z.infer<typeof remoteConnectionPhaseSchema>;

/**
 * Closed causes for a failed or interrupted SSH Host connection. `authentication` and `hostKey` stop automatic
 * reconnects because only the user can resolve them. `cancelled` means the user cancelled a prompt or the connection
 * itself; it stops retries too, but it is the user's own choice rather than something left for them to answer.
 * `takenOver` means another Caxri Desktop attached to the same Server and replaced this window's lease; nothing retries
 * it, because reconnecting would take the Server back from that window.
 */
export const remoteFailureReasons = [
    'authentication',
    'hostKey',
    'unreachable',
    'unsupportedPlatform',
    'unsupportedGlibc',
    'missingTool',
    'installFailed',
    'launchFailed',
    'profileInUse',
    'takenOver',
    'cancelled',
    'connectionLost',
    'unknown',
] as const;

export const remoteFailureReasonSchema = z.enum(remoteFailureReasons);

/**
 * Prefix of the one stderr line a Server prints when a Server on another host sharing the home directory holds its
 * profile, followed by ` host=<hostname>`. The SSH Host launch script reads it from the Server's stdio log to report
 * `profileInUse` with the holder's name instead of a generic `launchFailed`.
 */
export const REMOTE_PROFILE_IN_USE_MARKER = 'CAXRI_PROFILE_IN_USE';
export type RemoteFailureReason = z.infer<typeof remoteFailureReasonSchema>;

export const remoteAskpassKindSchema = z.enum(['secret', 'confirm', 'text']);
export type RemoteAskpassKind = z.infer<typeof remoteAskpassKindSchema>;

export const remoteAskpassRequestSchema = z.object({
    requestId: z.string().min(1).max(64),
    kind: remoteAskpassKindSchema,
    /**
     * OpenSSH's prompt text, such as `user@host's password:` or the host-key fingerprint question.
     */
    prompt: z.string().max(4000),
    /**
     * How many answers this same secret prompt already received during the current connection attempt. OpenSSH only
     * asks again after rejecting the answer, so a value means the previous passphrase or password was wrong.
     */
    retry: z.number().int().positive().optional(),
});

export type RemoteAskpassRequest = z.infer<typeof remoteAskpassRequestSchema>;

const remoteProgressSchema = z.object({
    completedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
});

const remoteFailureSchema = z.object({
    reason: remoteFailureReasonSchema,
    /**
     * Short user-readable detail, such as OpenSSH's last stderr line. Never contains credentials: askpass replies are
     * not logged or echoed.
     */
    message: z.string().max(2000),
    /**
     * For `profileInUse`: the hostname of the other machine whose Server holds the shared profile.
     */
    holder: z.string().max(255).optional(),
    /**
     * For `hostKey`: the name `known_hosts` stores for this SSH Host (`host`, or `[host]:port` off port 22), resolved
     * through `ssh -G` so a `~/.ssh/config` alias names its real `HostName`.
     */
    knownHostsName: z.string().max(300).optional(),
});

const remotePlatformSchema = z.object({
    architecture: z.enum(['x64', 'arm64']),
    glibc: z.string().max(32),
    hostname: z.string().max(255),
});

export const environmentStateSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }),
    z.object({
        kind: z.literal('ssh'),
        /**
         * The destination this window was opened for, exactly as entered or chosen.
         */
        destination: sshDestinationSchema,
        /**
         * Main's identity for the SSH Host (`ssh -G`'s resolved `user@hostname:port`, or the spelling when that fails),
         * the same key that makes two aliases of one account share this window. Device-local state that must follow the
         * SSH Host across aliases and relaunches (unsent composer drafts and images) is keyed by it, not by
         * `destination`.
         */
        hostIdentity: z.string().min(1).max(1024),
        phase: remoteConnectionPhaseSchema,
        /**
         * Bytes of the application layer (and, when the SSH Host cannot download it, the runtime) uploaded so far.
         */
        progress: remoteProgressSchema.optional(),
        /**
         * While `reconnecting`: which automatic attempt is running since the connection dropped, starting at 1.
         */
        attempt: z.number().int().positive().optional(),
        failure: remoteFailureSchema.optional(),
        /**
         * True when automatic reconnection stopped because the user must act (a password, 2FA code, or host key).
         */
        needsUserAction: z.boolean(),
        /**
         * The OpenSSH prompt waiting for the user, if any. It is part of the state rather than a separate event so a
         * window that loads after the prompt was raised still shows it.
         */
        askpass: remoteAskpassRequestSchema.optional(),
        /**
         * The remote machine as reported by the probe, once known.
         */
        platform: remotePlatformSchema.optional(),
    }),
]);

export type EnvironmentState = z.infer<typeof environmentStateSchema>;
export type SshEnvironmentState = Extract<EnvironmentState, { kind: 'ssh' }>;

export const sshHostEntrySchema = z.object({
    /**
     * The `Host` alias from `~/.ssh/config`; never a wildcard pattern.
     */
    alias: sshDestinationSchema,
    hostName: z.string().max(255).optional(),
    user: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
});

export type SshHostEntry = z.infer<typeof sshHostEntrySchema>;

/**
 * Main-owned methods for SSH Host environments. Every Workbench window may call `environment.get`; the remaining
 * methods act on the calling window's own environment or open a new one.
 */
export const remoteEnvironmentDesktopMethods = {
    'environment.get': {
        ...desktopRead,
        params: noParameters,
        result: environmentStateSchema,
    },
    'remote.hosts.list': {
        ...desktopRead,
        params: noParameters,
        result: z.object({
            hosts: z.array(sshHostEntrySchema).max(512),
            recent: z.array(sshDestinationSchema).max(20),
        }),
    },
    'remote.connect': {
        ...desktopControl,
        params: z.object({ destination: sshDestinationSchema }),
        result: z.null(),
    },
    'remote.reconnect': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    /**
     * Ends the calling window's automatic reconnect backoff so the next attempt starts now. Answers `true` when a wait
     * was ended and `false` when none was pending (an attempt is already running, or the window is not reconnecting).
     */
    'remote.retryNow': {
        ...desktopControl,
        params: noParameters,
        result: z.boolean(),
    },
    /**
     * Stops the calling window's in-flight connect, install, or reconnect. The window stays open in the `failed` phase
     * with a `cancelled` failure, and `remote.reconnect` starts again.
     */
    'remote.cancel': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    /**
     * Shows this Mac's SSH config file (the one every `ssh` call reads) in Finder, or its folder when the file does not
     * exist yet.
     */
    'remote.sshConfig.reveal': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    'remote.stopServer': {
        ...desktopWrite,
        params: noParameters,
        result: z.object({ canceled: z.boolean() }),
    },
    'remote.askpass.reply': {
        ...desktopControl,
        params: z.object({
            requestId: z.string().min(1).max(64),
            /**
             * `null` cancels the prompt, which fails the SSH attempt as `authentication`.
             */
            response: z.string().max(4096).nullable(),
        }),
        result: z.null(),
    },
} as const;
