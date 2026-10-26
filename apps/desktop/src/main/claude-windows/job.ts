import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { ClaudeWindowBackgroundState, ClaudeWindowState, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { execFileAsync, logEventCatalog } from '@caxri/system';
import { app } from 'electron';

import type { DesktopServerConnection } from '../server-connection';
import { claudeWindowLaunchAgent, claudeWindowLaunchAgentPlist } from './launch-agent';

export interface ClaudeWindowJobOptions {
    supervisor: Pick<DesktopServerConnection, 'onEvent' | 'request'>;
    isPackaged: boolean;
    platform: NodeJS.Platform;
    home: string;
    resourcesPath: string;
    userDataPath: string;
    uid: number;
    logger: () => StructuredLogger | undefined;
    /**
     * Runs `launchctl` with structured arguments; rejects when it exits non-zero.
     */
    launchctl(arguments_: readonly string[]): Promise<void>;
}

/**
 * Keeps the launchd job that wakes the Claude 5-hour window keeper while Caxri is closed in step with the keeper: it is
 * written while `Keep 5-hour windows rolling` is on, rewritten when the wake times change, and removed when the keeper
 * turns off. Only a packaged macOS build registers one, because the job runs the bundled CLI. Desktop reports the
 * result to Server Core, which shows it beside the setting.
 */
export function createClaudeWindowJob(options: ClaudeWindowJobOptions): { start(): void } {
    const agent = claudeWindowLaunchAgent(options.home, options.userDataPath);
    const domain = `gui/${options.uid}`;
    let running: Promise<void> | undefined;
    let isPending = false;
    /**
     * Whether this Desktop loaded the current plist. An unchanged plist proves nothing on its own: a failed bootstrap
     * leaves it written but not loaded, and a plist from an earlier launch may never have loaded either.
     */
    let isLoaded = false;

    async function readPlist(): Promise<string | undefined> {
        try {
            return await readFile(agent.plistPath, 'utf8');
        } catch {
            return undefined;
        }
    }

    async function unload(): Promise<void> {
        try {
            await options.launchctl(['bootout', `${domain}/${agent.label}`]);
        } catch {
            // Not loaded is the common case; there is nothing to report for it.
        }
    }

    async function apply(state: ClaudeWindowState): Promise<ClaudeWindowBackgroundState> {
        if (options.platform !== 'darwin') return 'unsupportedPlatform';
        if (!options.isPackaged) return 'unpackaged';
        const current = await readPlist();
        if (!state.account?.keepRolling || state.wakeTimes.length === 0) {
            if (current === undefined) return 'notRegistered';
            await unload();
            isLoaded = false;
            await rm(agent.plistPath, { force: true });
            log('removed', state.wakeTimes.length);
            return 'notRegistered';
        }
        const plist = claudeWindowLaunchAgentPlist({
            label: agent.label,
            launcherPath: join(options.resourcesPath, 'bin', 'caxri'),
            userDataPath: options.userDataPath,
            wakeTimes: state.wakeTimes,
        });
        if (current === plist && isLoaded) return 'registered';
        try {
            await mkdir(dirname(agent.plistPath), { recursive: true });
            await writeFile(agent.plistPath, plist, 'utf8');
            await unload();
            await options.launchctl(['bootstrap', domain, agent.plistPath]);
            isLoaded = true;
        } catch {
            isLoaded = false;
            log('failed', state.wakeTimes.length);
            return 'registerFailed';
        }
        log(current === undefined ? 'registered' : 'updated', state.wakeTimes.length);
        return 'registered';
    }

    function log(
        outcome: 'registered' | 'updated' | 'removed' | 'failed',
        wakeTimes: number,
    ): void {
        options
            .logger()
            ?.write(
                outcome === 'failed' ? 'warn' : 'info',
                logEventCatalog.claudeWindow.backgroundJob,
                {
                    fields: { outcome, wakeTimes },
                },
            );
    }

    async function sync(): Promise<void> {
        const state = await options.supervisor.request('claudeWindow.status', { refresh: false });
        const background = await apply(state);
        if (background !== state.background)
            await options.supervisor.request('claudeWindow.reportBackground', {
                state: background,
            });
    }

    /**
     * One sync at a time; changes that arrive during one run a single follow-up.
     */
    function schedule(): void {
        if (running) {
            isPending = true;
            return;
        }
        running = (async () => {
            try {
                await sync();
            } catch {
                // Server Core is restarting or the request failed; the next change or restart syncs again.
            } finally {
                running = undefined;
                if (isPending) {
                    isPending = false;
                    schedule();
                }
            }
        })();
    }

    return {
        start: () => {
            options.supervisor.onEvent((event: ServerEvent) => {
                // A restarted Server Core starts with the background state unknown, so it hears it again.
                if (
                    event.event === 'claudeWindow.changed' ||
                    (event.event === 'runtime.status' && event.payload.status === 'ready')
                )
                    schedule();
            });
            schedule();
        },
    };
}

/**
 * Starts the job controller for this Desktop with the real launchd, once Server Core is attached.
 */
export function startClaudeWindowJob(
    options: Pick<ClaudeWindowJobOptions, 'supervisor' | 'logger' | 'userDataPath'>,
): void {
    createClaudeWindowJob({
        ...options,
        isPackaged: app.isPackaged,
        platform: process.platform,
        home: homedir(),
        resourcesPath: process.resourcesPath,
        uid: process.getuid?.() ?? 0,
        launchctl: async (arguments_) => {
            await execFileAsync('/bin/launchctl', [...arguments_], { timeout: 10_000 });
        },
    }).start();
}
