import type { App } from 'electron';

import { readArgvConfigAtBoot } from './argv-config';

/**
 * Agent-native observability: every launch exposes CDP on localhost so coding agents can attach to the live instance
 * (DOM inspection, screenshots) without a special launch path. Explicit debugging switches win — Playwright E2E
 * attaches via `--remote-debugging-pipe` and the Acceptance runner passes its own `--remote-debugging-port`. Chromium
 * binds the port to 127.0.0.1 only. The desktop-lease workflow serializes development instances, so one fixed default
 * port suffices; `CAXRI_DEV_CDP_PORT` overrides it. Must run before `app.whenReady()` so Chromium picks the switch up
 * at browser-process start.
 *
 * Packaged builds honor `remoteDebugging` from the Main-owned `argv.jsonc` (default-on during internal testing) so
 * operators can turn the endpoint off; unpackaged launches stay unconditional because dev CDP is a repository agent
 * contract. The toggle only takes effect on the next launch.
 */
export function enableRemoteDebugging(app: App, environment: NodeJS.ProcessEnv): void {
    if (
        app.commandLine.hasSwitch('remote-debugging-port') ||
        app.commandLine.hasSwitch('remote-debugging-pipe')
    )
        return;
    if (app.isPackaged && !readArgvConfigAtBoot(app.getPath('userData')).remoteDebugging) return;
    app.commandLine.appendSwitch('remote-debugging-port', environment.CAXRI_DEV_CDP_PORT ?? '9223');
}
