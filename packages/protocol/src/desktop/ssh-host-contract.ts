import { z } from 'zod';

import { projectIconColors } from '../domain/project-customization.js';
import { commandPolicy } from '../transport/method-spec.js';

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const noParameters = z.object({}).default({});

/**
 * Upper bound for a typed SSH destination such as `user@build-box:2222` or a `~/.ssh/config` alias.
 */
const MAX_SSH_DESTINATION_LENGTH = 255;

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
const sshHostConnectionPhases = [
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

const sshHostConnectionPhaseSchema = z.enum(sshHostConnectionPhases);
export type SshHostConnectionPhase = z.infer<typeof sshHostConnectionPhaseSchema>;

/**
 * Closed causes for a failed or interrupted SSH Host connection. `authentication` and `hostKey` stop automatic
 * reconnects because only the user can resolve them. `cancelled` means the user cancelled a prompt or the connection
 * itself; it stops retries too, but it is the user's own choice rather than something left for them to answer.
 * `takenOver` means another Caxri Desktop attached to the same Server and replaced this window's lease; nothing retries
 * it, because reconnecting would take the Server back from that window.
 */
const sshHostFailureReasons = [
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
    'updateDeferred',
    'connectionLost',
    'unknown',
] as const;

const sshHostFailureReasonSchema = z.enum(sshHostFailureReasons);

/**
 * Prefix of the one stderr line a Server prints when a Server on another host sharing the home directory holds its
 * profile, followed by ` host=<hostname>`. The SSH Host launch script reads it from the Server's stdio log to report
 * `profileInUse` with the holder's name instead of a generic `launchFailed`.
 */
export const SSH_HOST_PROFILE_IN_USE_MARKER = 'CAXRI_PROFILE_IN_USE';
export type SshHostFailureReason = z.infer<typeof sshHostFailureReasonSchema>;

const sshHostAskpassKindSchema = z.enum(['secret', 'confirm', 'text']);
export type SshHostAskpassKind = z.infer<typeof sshHostAskpassKindSchema>;

const sshHostAskpassRequestSchema = z.object({
    requestId: z.string().min(1).max(64),
    kind: sshHostAskpassKindSchema,
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

export type SshHostAskpassRequest = z.infer<typeof sshHostAskpassRequestSchema>;

const sshHostProgressSchema = z.object({
    completedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
});

const sshHostFailureSchema = z.object({
    reason: sshHostFailureReasonSchema,
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

const sshHostPlatformSchema = z.object({
    architecture: z.enum(['x64', 'arm64']),
    hostname: z.string().max(255),
    system: z.enum(['linux', 'macos']),
    /**
     * The glibc version on Linux, the macOS version on macOS.
     */
    systemVersion: z.string().max(32),
    /**
     * On Linux, the os-release `ID` (`ubuntu`, `debian`, ...), which picks the Host mark's system logo.
     */
    distribution: z
        .string()
        .regex(/^[a-z0-9._-]{1,64}$/)
        .optional(),
});

export const sshEnvironmentStateSchema = z.object({
    kind: z.literal('ssh'),
    /**
     * The destination this SSH Host was connected with, exactly as entered or chosen.
     */
    destination: sshDestinationSchema,
    /**
     * Main's identity for the SSH Host (`ssh -G`'s resolved `user@hostname:port`, or the spelling when that fails), the
     * same key that makes two aliases of one account share one connection. It is also the environment id Renderer
     * requests name. Device-local state that must follow the SSH Host across aliases and relaunches (unsent composer
     * drafts and images) is keyed by it, not by `destination`.
     */
    hostIdentity: z.string().min(1).max(1024),
    phase: sshHostConnectionPhaseSchema,
    /**
     * Bytes of the application layer (and, when the SSH Host cannot download it, the runtime) uploaded so far.
     */
    progress: sshHostProgressSchema.optional(),
    /**
     * While `reconnecting`: which automatic attempt is running since the connection dropped, starting at 1.
     */
    attempt: z.number().int().positive().optional(),
    failure: sshHostFailureSchema.optional(),
    /**
     * True when automatic reconnection stopped because the user must act (a password, 2FA code, or host key).
     */
    needsUserAction: z.boolean(),
    /**
     * The OpenSSH prompt waiting for the user, if any. It is part of the state rather than a separate event so a window
     * that loads after the prompt was raised still shows it.
     */
    askpass: sshHostAskpassRequestSchema.optional(),
    /**
     * The remote machine as reported by the probe, once known.
     */
    platform: sshHostPlatformSchema.optional(),
});

export const environmentStateSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }),
    sshEnvironmentStateSchema,
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
 * The system logos a Host mark can show: picked automatically from the platform an SSH Host reported, or chosen.
 */
const hostSystemIconNames = [
    'macos',
    'windows',
    'linux',
    'ubuntu',
    'debian',
    'fedora',
    'arch',
    'redhat',
] as const;

/**
 * Every Host mark icon, in the picker's order: System (what it runs), Place (where it is), and Device (what it is).
 */
const hostIconNames = [
    ...hostSystemIconNames,
    'house',
    'building',
    'map-pin',
    'cloud',
    'laptop',
    'monitor',
    'server',
    'gpu',
] as const;

const hostIconSchema = z.strictObject({
    name: z.enum(hostIconNames),
    color: z.enum(projectIconColors).optional(),
});

export type HostIcon = z.infer<typeof hostIconSchema>;
export type HostIconName = HostIcon['name'];
export type HostSystemIconName = (typeof hostSystemIconNames)[number];

/**
 * The system logo for a platform an SSH Host reported: a known Linux distribution's own, else the generic one.
 */
export function detectedSystemOf(platform: {
    system: 'linux' | 'macos';
    distribution?: string;
}): HostSystemIconName {
    if (platform.system === 'macos') return 'macos';
    const distribution = platform.distribution === 'rhel' ? 'redhat' : platform.distribution;
    return hostSystemIconNames.find((name) => name === distribution) ?? 'linux';
}

/**
 * The id Host preferences use for this Mac; an SSH Host uses its `hostIdentity`.
 */
export const LOCAL_HOST_PREFERENCE_ID = 'local';

const MAX_HOST_NAME_LENGTH = 80;

export const hostPreferenceSchema = z.object({
    /**
     * The destination this SSH Host last connected with, so Settings › Hosts can connect it again while it is offline.
     * Absent for this Mac.
     */
    destination: sshDestinationSchema.optional(),
    /**
     * The display name every Host mark shows; absent shows the destination (or "This Mac").
     */
    name: z.string().trim().min(1).max(MAX_HOST_NAME_LENGTH).optional(),
    /**
     * The chosen icon; absent is Auto, the detected system's logo.
     */
    icon: hostIconSchema.optional(),
    /**
     * The system logo Auto shows, remembered from the last connection so an offline SSH Host keeps it.
     */
    detectedSystem: z.enum(hostSystemIconNames).optional(),
    /**
     * Whether Caxri connects this SSH Host when it starts. Absent means on.
     */
    reconnectOnLaunch: z.boolean().optional(),
});

export type HostPreference = z.infer<typeof hostPreferenceSchema>;

/**
 * This Mac's display preferences for every machine it knows, kept by Desktop Main so they are readable exactly when a
 * Host is offline (docs/adr/0022-multi-environment-window.md).
 */
export const hostPreferencesSchema = z.object({
    /**
     * Shows the name beside every Host mark that would otherwise show its icon alone.
     */
    shouldShowHostNames: z.boolean(),
    /**
     * Keyed by `LOCAL_HOST_PREFERENCE_ID` or an SSH Host's `hostIdentity`, in first-connection order.
     */
    hosts: z.record(z.string().min(1).max(1024), hostPreferenceSchema),
});

export type HostPreferences = z.infer<typeof hostPreferencesSchema>;

/**
 * Main-owned methods for SSH Host environments. `environment.get`, `sshHost.environments.list`, `sshHost.connect`, and
 * the host list answer for the local Workbench; the remaining methods act on the SSH Host a request names with its
 * `environmentId` (docs/adr/0022-multi-environment-window.md).
 */
export const sshHostDesktopMethods = {
    'environment.get': {
        ...desktopRead,
        params: noParameters,
        result: environmentStateSchema,
    },
    'sshHost.hosts.list': {
        ...desktopRead,
        params: noParameters,
        result: z.object({
            hosts: z.array(sshHostEntrySchema).max(512),
            recent: z.array(sshDestinationSchema).max(20),
        }),
    },
    /**
     * Every SSH Host this Desktop is connected to or connecting to, in connection order. `sshHost.environmentsChanged`
     * pushes the same list whenever it changes.
     */
    'sshHost.environments.list': {
        ...desktopRead,
        params: noParameters,
        result: z.array(sshEnvironmentStateSchema).max(64),
    },
    /**
     * Connects an SSH Host, or reuses the connection to the same account under another spelling, and answers its
     * environment id (the resolved host identity) once the connection attempt has started.
     */
    'sshHost.connect': {
        ...desktopControl,
        params: z.object({ destination: sshDestinationSchema }),
        result: z.object({ environmentId: z.string().min(1).max(1024) }),
    },
    /**
     * Detaches the named SSH Host. Its Server keeps its Terminals and Agents and exits on its own once idle.
     */
    'sshHost.disconnect': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    'sshHost.reconnect': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    /**
     * Ends the calling window's automatic reconnect backoff so the next attempt starts now. Answers `true` when a wait
     * was ended and `false` when none was pending (an attempt is already running, or the window is not reconnecting).
     */
    'sshHost.retryNow': {
        ...desktopControl,
        params: noParameters,
        result: z.boolean(),
    },
    /**
     * Stops the calling window's in-flight connect, install, or reconnect. The window stays open in the `failed` phase
     * with a `cancelled` failure, and `sshHost.reconnect` starts again.
     */
    'sshHost.cancel': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    /**
     * Shows this Mac's SSH config file (the one every `ssh` call reads) in Finder, or its folder when the file does not
     * exist yet.
     */
    'sshHost.sshConfig.reveal': {
        ...desktopControl,
        params: noParameters,
        result: z.null(),
    },
    'sshHost.stopServer': {
        ...desktopWrite,
        params: noParameters,
        result: z.object({ canceled: z.boolean() }),
    },
    'sshHost.preferences.get': {
        ...desktopRead,
        params: noParameters,
        result: hostPreferencesSchema,
    },
    /**
     * Changes one machine's display name, icon, or Reconnect on Launch; `null` clears a name or icon. Answers the new
     * preferences, which `sshHost.preferencesChanged` also pushes to every window.
     */
    'sshHost.preferences.update': {
        ...desktopWrite,
        params: z.object({
            hostId: z.string().min(1).max(1024),
            name: z.string().max(MAX_HOST_NAME_LENGTH).nullable().optional(),
            icon: hostIconSchema.nullable().optional(),
            reconnectOnLaunch: z.boolean().optional(),
        }),
        result: hostPreferencesSchema,
    },
    'sshHost.preferences.setShowHostNames': {
        ...desktopWrite,
        params: z.object({ shouldShowHostNames: z.boolean() }),
        result: hostPreferencesSchema,
    },
    'sshHost.askpass.reply': {
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
