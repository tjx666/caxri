import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { RemoteDebuggingState } from '@caxri/protocol';
import { profileIdForPath } from '@caxri/system';
import type { App } from 'electron';

import { readArgvConfigAtBoot } from './argv-config';

type DesktopProfileKind = 'development-default' | 'explicit' | 'packaged-default';

type RemoteDebuggingIdentity =
    | { source: 'argv-config'; transport: 'disabled' }
    | { source: 'command-line'; transport: 'pipe' }
    | {
          port: string;
          source: 'command-line' | 'environment' | 'profile-default';
          transport: 'port';
      };

export interface DesktopProfile {
    id: string;
    kind: DesktopProfileKind;
    logDirectory: string;
    remoteDebugging: RemoteDebuggingIdentity;
    userDataPath: string;
}

function canonicalProfilePath(path: string): string {
    /**
     * This is the process bootstrap boundary: Electron, Chromium, the single-instance lock, and the Server must all see
     * the same canonical userData path before `app.whenReady()`. Async filesystem calls would let those consumers
     * capture different identities, so this deliberately performs the one synchronous directory/realpath resolution.
     */
    // oxlint-disable-next-line node/no-sync -- early process identity must settle before any Electron consumer starts
    mkdirSync(path, { mode: 0o700, recursive: true });
    // oxlint-disable-next-line node/no-sync -- same bootstrap identity boundary as the mkdir above
    return realpathSync(path);
}

function remoteDebuggingIdentity(
    app: App,
    environment: NodeJS.ProcessEnv,
    userDataPath: string,
): RemoteDebuggingIdentity {
    if (app.commandLine.hasSwitch('remote-debugging-port')) {
        return {
            port: app.commandLine.getSwitchValue('remote-debugging-port'),
            source: 'command-line',
            transport: 'port',
        };
    }
    if (app.commandLine.hasSwitch('remote-debugging-pipe'))
        return { source: 'command-line', transport: 'pipe' };
    if (app.isPackaged && !readArgvConfigAtBoot(userDataPath).remoteDebugging)
        return { source: 'argv-config', transport: 'disabled' };
    // An exported-but-empty `CAXRI_DEV_CDP_PORT=` is not a port: taken literally it would be appended as
    // `--remote-debugging-port=`, which makes Chromium pick an ephemeral port nothing can find.
    const configuredPort = environment.CAXRI_DEV_CDP_PORT;
    const hasConfiguredPort = configuredPort !== undefined && configuredPort !== '';
    return {
        port: hasConfiguredPort ? configuredPort : app.isPackaged ? '9224' : '9223',
        source: hasConfiguredPort ? 'environment' : 'profile-default',
        transport: 'port',
    };
}

/**
 * The Renderer-facing view of {@link RemoteDebuggingIdentity}. `source` stays in Main: which switch or environment
 * variable opened the port is implementation vocabulary, and the disclosure the user reads only needs to know whether
 * something is listening and where.
 */
export function remoteDebuggingState(profile: DesktopProfile): RemoteDebuggingState {
    const identity = profile.remoteDebugging;
    if (identity.transport !== 'port') return { transport: identity.transport };
    // A command line carrying `--remote-debugging-port` with no number asks Chromium for an ephemeral port it never
    // reports back. The disclosure then says a port is open without naming one, instead of naming an empty one.
    return identity.port ? { port: identity.port, transport: 'port' } : { transport: 'port' };
}

/**
 * Selects and installs the one runtime profile consumed by every Main-owned launch resource.
 */
export function configureDesktopProfile(app: App, environment: NodeJS.ProcessEnv): DesktopProfile {
    const explicitPath = environment.CAXRI_USER_DATA_DIR;
    const kind: DesktopProfileKind = explicitPath
        ? 'explicit'
        : app.isPackaged
          ? 'packaged-default'
          : 'development-default';
    const selectedPath =
        explicitPath ??
        (app.isPackaged ? app.getPath('userData') : join(app.getPath('appData'), 'caxri-dev'));
    const userDataPath = canonicalProfilePath(selectedPath);
    app.setPath('userData', userDataPath);
    const remoteDebugging = remoteDebuggingIdentity(app, environment, userDataPath);
    if (remoteDebugging.transport === 'port' && remoteDebugging.source !== 'command-line')
        app.commandLine.appendSwitch('remote-debugging-port', remoteDebugging.port);
    return {
        id: profileIdForPath(userDataPath),
        kind,
        logDirectory: join(userDataPath, 'logs'),
        remoteDebugging,
        userDataPath,
    };
}

/**
 * Electron scopes this lock by the canonical userData path installed by `configureDesktopProfile`; the explicit ID also
 * lets the primary process reject accidental cross-profile forwarding in tests and future launch payloads.
 */
export function hasProfileSingleInstanceLock(app: App, profile: DesktopProfile): boolean {
    return app.requestSingleInstanceLock({ profileId: profile.id });
}

/**
 * Coalesces second-instance requests received while the primary Desktop is still attaching to its Server. Once ready,
 * every request restores and focuses the existing window rather than creating a competing Desktop lease.
 */
export function installSecondInstanceFocus(
    app: App,
    focus: () => Promise<void>,
    onError: (error: unknown) => void,
): { ready(): void } {
    let isReady = false;
    let isPending = false;
    const focusExistingWindow = async (): Promise<void> => {
        try {
            await focus();
        } catch (error) {
            onError(error);
        }
    };
    const requestFocus = (): void => {
        if (!isReady) {
            isPending = true;
            return;
        }
        // The Electron event emitter cannot await listeners; this task catches its own failure above.
        void focusExistingWindow();
    };
    app.on('second-instance', requestFocus);
    return {
        ready: () => {
            if (isReady) return;
            isReady = true;
            if (!isPending) return;
            isPending = false;
            requestFocus();
        },
    };
}
