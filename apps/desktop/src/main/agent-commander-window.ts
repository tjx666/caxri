import { join } from 'node:path';

import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';

import { AgentCommanderRendererPolicy } from './agent-commander-policy';
import { createAuxiliaryWindow, isAuxiliaryWindowRevealed } from './auxiliary-window';
import { resolveRendererEntryUrl } from './renderer-entry';
import type { E2EWindowMode } from './window-mode';
import type { CompanionRendererPolicy } from './workbench-ipc';

interface AgentCommanderWindowOptions {
    currentDirectory: string;
    detachTerminal: (terminalId: string) => Promise<unknown>;
    isPackaged: boolean;
    logger: () => StructuredLogger | undefined;
    rendererUrl?: string;
    stopCommander: () => Promise<unknown>;
    windowMode: E2EWindowMode;
}

/**
 * Owns the Agent Commander window: a second Renderer that loads the Workbench preload, shares Main's single Desktop
 * connection, and is admitted only for the requests `AgentCommanderRendererPolicy` allows. See
 * `docs/agent-commander.md`.
 */
export class AgentCommanderWindowController {
    private window?: BrowserWindow;
    private isEventsReady = false;
    readonly policy: AgentCommanderRendererPolicy;

    constructor(private readonly options: AgentCommanderWindowOptions) {
        this.policy = new AgentCommanderRendererPolicy((method) =>
            this.options.logger()?.write('warn', logEventCatalog.agentCommander.requestDenied, {
                fields: { code: 'FORBIDDEN', method },
            }),
        );
    }

    /**
     * A closing or reloading window never runs its React unmount, so Main releases the Server-side view attachment
     * itself; the Commander PTY keeps running and the next window re-attaches with a snapshot. A close cannot await
     * Server I/O, and a failed detach only leaves a view the next attach replaces, so it is fire-and-forget.
     */
    private releaseTerminal(): void {
        const terminalId = this.policy.viewedTerminalId();
        this.policy.reset();
        // eslint-disable-next-line unicorn/prefer-await -- see JSDoc above
        if (terminalId) this.options.detachTerminal(terminalId).catch(() => {});
    }

    /**
     * The Workbench IPC companion contract for this window.
     */
    companion(): CompanionRendererPolicy {
        return {
            renderer: () => this.renderer(),
            window: () => (this.window?.isDestroyed() ? undefined : this.window),
            admit: (raw) => this.policy.admit(raw),
            observeReply: (raw, reply) => this.policy.observeReply(raw, reply),
            onEventsReady: () => {
                this.isEventsReady = true;
            },
            onRendererError: (kind) =>
                this.options
                    .logger()
                    ?.write(
                        'error',
                        kind === 'page-exception'
                            ? logEventCatalog.agentCommander.pageException
                            : logEventCatalog.agentCommander.unhandledRejection,
                        {
                            fields: {
                                code:
                                    kind === 'page-exception'
                                        ? 'PAGE_EXCEPTION'
                                        : 'UNHANDLED_REJECTION',
                            },
                        },
                    ),
        };
    }

    /**
     * Sends one relay message to this window when `AgentCommanderRendererPolicy.route` assigns it here, once the window
     * has subscribed; earlier messages are recovered by the preload's own journal cursor. Returns whether the Workbench
     * should receive the message too.
     */
    relay(message: unknown): boolean {
        const route = this.policy.route(message);
        const renderer = this.renderer();
        if (renderer && route.commander && this.isEventsReady)
            renderer.send('caxri:event', message);
        return route.workbench;
    }

    renderer(): WebContents | undefined {
        if (!this.window || this.window.isDestroyed()) return undefined;
        return this.window.webContents;
    }

    processId(): number | undefined {
        return this.renderer()?.getOSProcessId();
    }

    close(): void {
        if (this.window && !this.window.isDestroyed()) this.window.close();
    }

    /**
     * Closes the window first so it never shows its own Terminal going away, then stops the Commander on the Server.
     * Reopening the window runs `commander.ensure`, which resumes the same Codex conversation.
     */
    async stop(): Promise<void> {
        this.close();
        try {
            await this.options.stopCommander();
        } catch (error) {
            this.options.logger()?.write('error', logEventCatalog.agentCommander.stopFailed, {
                fields: { code: isCaxriError(error) ? error.code : 'INTERNAL' },
            });
            throw error;
        }
    }

    open(): void {
        if (isAuxiliaryWindowRevealed(this.window, this.options.windowMode === 'visible')) return;
        const logger = this.options.logger();
        if (!logger) return;
        const window = createAuxiliaryWindow({
            browserWindow: {
                width: 1_320,
                height: 820,
                minWidth: 760,
                minHeight: 480,
                title: 'Agent Commander — Caxri',
                backgroundColor: '#282a36',
                titleBarStyle: 'hiddenInset',
                webPreferences: {
                    preload: join(this.options.currentDirectory, '../preload/index.cjs'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            },
            events: logEventCatalog.agentCommander,
            logger,
            rendererUrl: resolveRendererEntryUrl({
                currentDirectory: this.options.currentDirectory,
                isPackaged: this.options.isPackaged,
                page: 'agent-commander.html',
                rendererUrl: this.options.rendererUrl,
            }),
            showOnReady: this.options.windowMode === 'visible',
        });
        this.window = window;
        this.isEventsReady = false;
        /**
         * A reload (crash recovery) starts a new preload generation that must re-announce readiness and re-learn its
         * Terminal through `commander.ensure` before any PTY bytes are routed to it again.
         */
        window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            if (!isMainFrame || isInPlace) return;
            this.isEventsReady = false;
            this.releaseTerminal();
        });
        window.on('closed', () => {
            if (this.window !== window) return;
            this.window = undefined;
            this.isEventsReady = false;
            this.releaseTerminal();
        });
    }
}
