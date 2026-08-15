import type { App } from 'electron';

/**
 * Agent-native dev observability: every unpackaged launch exposes CDP on localhost so coding
 * agents can attach to the live instance (DOM inspection, screenshots) without a special launch
 * path. Explicit debugging switches win — Playwright E2E attaches via `--remote-debugging-pipe`
 * and the Acceptance runner passes its own `--remote-debugging-port` — and packaged builds never
 * enable it. Chromium binds the port to 127.0.0.1 only. The desktop-lease workflow serializes
 * development instances, so one fixed default port suffices; `CAXRI_DEV_CDP_PORT` overrides it.
 * Must run before `app.whenReady()` so Chromium picks the switch up at browser-process start.
 */
export function enableDevelopmentCdp(app: App, environment: NodeJS.ProcessEnv): void {
    if (app.isPackaged) return;
    if (
        app.commandLine.hasSwitch('remote-debugging-port') ||
        app.commandLine.hasSwitch('remote-debugging-pipe')
    )
        return;
    app.commandLine.appendSwitch('remote-debugging-port', environment.CAXRI_DEV_CDP_PORT ?? '9223');
}
