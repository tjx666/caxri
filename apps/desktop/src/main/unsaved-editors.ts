import { randomUUID } from 'node:crypto';

import type { DesktopRequest, ServerEvent } from '@caxri/protocol';
import { CaxriError, errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

import { translateMain } from './locale';
import { PRIMARY_WINDOW_KEY } from './window-presence-registry';

type UnsavedEditorsRequest = Extract<ServerEvent, { event: 'editor.unsavedRequest' }>['payload'];
type UnsavedEditorsReplyParameters = Extract<
    DesktopRequest,
    { method: 'editor.unsavedReply' }
>['params'];
type UnsavedEditorsReply = UnsavedEditorsReplyParameters['reply'];
export type UnsavedEditorsSummary = Extract<UnsavedEditorsReply, { kind: 'summary' }>;
export type UnsavedEditorsSaveResult = Extract<
    UnsavedEditorsReply,
    { kind: 'saveFailed' | 'saved' }
>;
export type UnsavedEditorsChoice = 'cancel' | 'discard' | 'save';
export type UnsavedEditorsPurpose = 'close' | 'quit';
/**
 * Closed outcome of one quit or close consultation, logged as `app.unsaved_editors_decided`.
 */
type UnsavedEditorsOutcome =
    | 'autoSaved'
    | 'cancelled'
    | 'discarded'
    | 'none'
    | 'promptFailed'
    | 'readFailed'
    | 'saveFailed'
    | 'saved';

/**
 * Asking is a local IPC round trip against an idle store; a Renderer that cannot answer within this window is hung or
 * mid-reload, and quitting must stay possible (fail-open, like `readPendingReviewComments`).
 */
const INSPECT_TIMEOUT_MS = 3000;
/**
 * Saving writes through Server Core for each buffer. Long enough for a slow disk, short enough that a wedged Renderer
 * cannot trap the user; a timed-out save keeps the app open rather than discarding the buffers.
 */
const SAVE_TIMEOUT_MS = 60_000;

interface PendingReply {
    resolve(reply: UnsavedEditorsReply): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

export interface UnsavedEditorsBridgeOptions {
    /**
     * Delivers the request to the Workbench Renderer. Returns false when no Workbench window can receive it, in which
     * case there is no Renderer document cache and so nothing unsaved.
     */
    send(payload: UnsavedEditorsRequest): boolean;
    createRequestId?: () => string;
    inspectTimeoutMs?: number;
    saveTimeoutMs?: number;
}

/**
 * Main's side of the quit-time question about unsaved Editor buffers (issue caxri#1631). The buffers only exist in the
 * Renderer, so Main sends a one-shot `editor.unsavedRequest` event and waits for the matching `editor.unsavedReply`.
 */
export function createUnsavedEditorsBridge(options: UnsavedEditorsBridgeOptions) {
    const pending = new Map<string, PendingReply>();
    const createRequestId = options.createRequestId ?? randomUUID;

    function ask(
        action: 'discardAll' | 'inspect' | 'saveAll',
        timeoutMs: number,
    ): Promise<UnsavedEditorsReply | undefined> {
        const requestId = createRequestId();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new CaxriError('UNAVAILABLE', `Workbench did not answer ${action}`));
            }, timeoutMs);
            pending.set(requestId, { resolve, reject, timer });
            if (options.send({ requestId, action })) return;
            clearTimeout(timer);
            pending.delete(requestId);
            resolve(undefined);
        });
    }

    return {
        async inspect(): Promise<UnsavedEditorsSummary> {
            const reply = await ask('inspect', options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS);
            if (!reply) return { kind: 'summary', count: 0, names: [], autoSave: false };
            if (reply.kind !== 'summary')
                throw new CaxriError('INTERNAL', 'Workbench answered inspect with a save result');
            return reply;
        },
        /**
         * Drops the Workbench's on-device backups after Don't Save. Bounded like `inspect`: a Renderer that cannot
         * answer still lets the quit continue, and at worst its next launch offers the discarded text back.
         */
        async discardAll(): Promise<void> {
            await ask('discardAll', options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS);
        },
        async saveAll(): Promise<UnsavedEditorsSaveResult> {
            const reply = await ask('saveAll', options.saveTimeoutMs ?? SAVE_TIMEOUT_MS);
            // The Workbench vanished between the prompt and the save, taking its buffers with it.
            if (!reply) return { kind: 'saveFailed', reason: 'writeFailed' };
            if (reply.kind !== 'saved' && reply.kind !== 'saveFailed')
                throw new CaxriError('INTERNAL', `Workbench answered saveAll with ${reply.kind}`);
            return reply;
        },
        reveal(): void {
            options.send({ requestId: createRequestId(), action: 'reveal' });
        },
        /**
         * Settles the matching request; a late or unknown reply is ignored because its decision already moved on.
         */
        reply(parameters: UnsavedEditorsReplyParameters): void {
            const entry = pending.get(parameters.requestId);
            if (!entry) return;
            pending.delete(parameters.requestId);
            clearTimeout(entry.timer);
            entry.resolve(parameters.reply);
        },
    };
}

/**
 * Builds the native quit/close prompt in the `workbench.language` locale through {@link translateMain}, so the dialog
 * matches the window it guards.
 */
export function unsavedEditorsPrompt(
    summary: UnsavedEditorsSummary,
    purpose: UnsavedEditorsPurpose,
): MessageBoxOptions {
    const isSingle = summary.count === 1 && summary.names.length === 1;
    const hidden = summary.count - summary.names.length;
    const listed =
        isSingle || summary.names.length === 0
            ? ''
            : `${summary.names.join('\n')}${hidden > 0 ? `\n${translateMain('desktop.unsaved.more', { count: hidden })}` : ''}\n\n`;
    let message: string;
    if (isSingle) {
        message = translateMain(
            purpose === 'quit' ? 'desktop.unsaved.quitOne' : 'desktop.unsaved.closeOne',
            { name: summary.names[0] ?? '' },
        );
    } else {
        message = translateMain(
            purpose === 'quit' ? 'desktop.unsaved.quitOther' : 'desktop.unsaved.closeOther',
            { count: summary.count },
        );
    }
    return {
        type: 'warning',
        title: translateMain('desktop.unsaved.title'),
        message,
        detail: `${listed}${translateMain('desktop.unsaved.detail')}`,
        buttons: [
            translateMain(isSingle ? 'desktop.unsaved.save' : 'desktop.unsaved.saveAll'),
            translateMain('desktop.unsaved.dontSave'),
            translateMain('desktop.dialog.cancel'),
        ],
        /**
         * Same convention as the per-tab `unsavedChangesPrompt`: Enter saves, Escape cancels, never the destructive
         * choice.
         */
        defaultId: 0,
        cancelId: 2,
    };
}

async function confirmUnsavedEditors(
    dialog: Dialog,
    window: BrowserWindow | undefined,
    summary: UnsavedEditorsSummary,
    purpose: UnsavedEditorsPurpose,
): Promise<UnsavedEditorsChoice> {
    const prompt = unsavedEditorsPrompt(summary, purpose);
    const result =
        window && !window.isDestroyed()
            ? await dialog.showMessageBox(window, prompt)
            : await dialog.showMessageBox(prompt);
    if (result.response === 0) return 'save';
    return result.response === 1 ? 'discard' : 'cancel';
}

export interface UnsavedEditorsDecisionOptions {
    confirm: (summary: UnsavedEditorsSummary) => Promise<UnsavedEditorsChoice>;
    /**
     * Tells the Workbench the user chose Don't Save, so its on-device backups of those buffers are dropped too.
     */
    discardAll: () => Promise<void>;
    inspect: () => Promise<UnsavedEditorsSummary>;
    /**
     * One structured record per consultation. `error` is set only for the failure outcomes.
     */
    log: (outcome: UnsavedEditorsOutcome, count: number, error?: string) => void;
    reveal: () => void;
    saveAll: () => Promise<UnsavedEditorsSaveResult>;
}

async function inspectOrFailOpen(
    options: UnsavedEditorsDecisionOptions,
): Promise<UnsavedEditorsSummary | undefined> {
    try {
        return await options.inspect();
    } catch (error) {
        options.log('readFailed', 0, errorMessage(error, 'Unknown unsaved editor read failure'));
        return undefined;
    }
}

/**
 * Saves without asking because `files.autoSave` is on, as VS Code does on quit. The save runs here under the `saveAll`
 * timeout rather than inside `inspect`, whose short timeout fails open and would let a slow write race the quit.
 */
async function didAutoSave(
    options: UnsavedEditorsDecisionOptions,
    count: number,
): Promise<boolean> {
    try {
        const result = await options.saveAll();
        if (result.kind === 'saved') {
            options.log('autoSaved', count);
            return true;
        }
        options.log('saveFailed', count, result.reason);
    } catch (error) {
        options.log(
            'saveFailed',
            count,
            errorMessage(error, 'Unknown unsaved editor save failure'),
        );
    }
    return false;
}

/**
 * Decides whether unsaved Editor buffers let a quit or window close continue. Reading the summary or showing the prompt
 * fails open: an unresponsive Renderer must not trap the user inside the app. Saving fails closed: once the user chose
 * Save, a failed write keeps the app open so the buffers survive, and the Renderer's own save toast names the reason.
 * Under auto save the buffers are saved first, and the prompt only asks about what that save left unsaved.
 */
export async function decideUnsavedEditors(
    options: UnsavedEditorsDecisionOptions,
): Promise<'cancel' | 'continue'> {
    let summary = await inspectOrFailOpen(options);
    if (!summary || summary.count === 0) return 'continue';
    if (summary.autoSave) {
        if (await didAutoSave(options, summary.count)) return 'continue';
        summary = await inspectOrFailOpen(options);
        if (!summary || summary.count === 0) return 'continue';
    }

    let choice: UnsavedEditorsChoice;
    try {
        choice = await options.confirm(summary);
    } catch (error) {
        options.log(
            'promptFailed',
            summary.count,
            errorMessage(error, 'Unknown unsaved editor prompt failure'),
        );
        return 'continue';
    }
    if (choice === 'cancel') {
        options.log('cancelled', summary.count);
        options.reveal();
        return 'cancel';
    }
    if (choice === 'discard') {
        options.log('discarded', summary.count);
        // Fails open like `inspect`: a backup left behind is offered back on the next launch, never written to disk.
        try {
            await options.discardAll();
        } catch {
            // Continue regardless; see above.
        }
        return 'continue';
    }
    try {
        const result = await options.saveAll();
        if (result.kind === 'saved') {
            options.log('saved', summary.count);
            return 'continue';
        }
        options.log('saveFailed', summary.count, result.reason);
    } catch (error) {
        options.log(
            'saveFailed',
            summary.count,
            errorMessage(error, 'Unknown unsaved editor save failure'),
        );
    }
    return 'cancel';
}

export interface WorkbenchUnsavedEditorsOptions {
    dialog: Dialog;
    /**
     * The live Workbench windows, primary first. A window that closed is absent, and so has nothing unsaved.
     */
    windows: () => ReadonlyArray<{ key: string; window: BrowserWindow }>;
    logger: () => StructuredLogger | undefined;
    /**
     * Delivers the question to exactly one window: its Editor buffers live only in that Renderer.
     */
    sendEvent: (
        event: Extract<ServerEvent, { event: 'editor.unsavedRequest' }>,
        windowKey: string,
    ) => void;
}

/**
 * Composes the bridge, the native prompt, and structured logging for the Workbench windows' quit and close paths. Each
 * window has its own bridge because its buffers are asked about separately; a quit asks every window and prompts once
 * with the merged summary, so a dirty Editor in a torn-off window is never lost to a quit or to a primary-window
 * close.
 */
export function createWorkbenchUnsavedEditors(options: WorkbenchUnsavedEditorsOptions) {
    const bridges = new Map<string, ReturnType<typeof createUnsavedEditorsBridge>>();
    const windowOf = (key: string): BrowserWindow | undefined =>
        options.windows().find((entry) => entry.key === key)?.window;
    const bridgeFor = (key: string) => {
        let bridge = bridges.get(key);
        if (!bridge) {
            bridge = createUnsavedEditorsBridge({
                send: (payload) => {
                    const window = windowOf(key);
                    if (!window || window.isDestroyed()) return false;
                    options.sendEvent({ event: 'editor.unsavedRequest', payload }, key);
                    return true;
                },
            });
            bridges.set(key, bridge);
        }
        return bridge;
    };
    return {
        /**
         * Decides for one window, or for every live window when `windowKey` is omitted (quit, and closing the primary
         * window, which takes the torn-off windows with it).
         */
        decide: (purpose: UnsavedEditorsPurpose, windowKey?: string) => {
            const keys = windowKey ? [windowKey] : options.windows().map((entry) => entry.key);
            const dirty = new Set<string>();
            return decideUnsavedEditors({
                confirm: (summary) =>
                    confirmUnsavedEditors(
                        options.dialog,
                        windowOf(windowKey ?? PRIMARY_WINDOW_KEY) ?? options.windows()[0]?.window,
                        summary,
                        purpose,
                    ),
                inspect: async () => {
                    const settled = await Promise.allSettled(
                        keys.map(async (key) => ({ key, summary: await bridgeFor(key).inspect() })),
                    );
                    const answers = settled.flatMap((result) =>
                        result.status === 'fulfilled' ? [result.value] : [],
                    );
                    // One unresponsive window must not hide another window's dirty buffers; fail open only when none answered.
                    if (answers.length === 0 && settled[0]?.status === 'rejected')
                        throw settled[0].reason;
                    dirty.clear();
                    for (const { key, summary } of answers) if (summary.count > 0) dirty.add(key);
                    const dirtyAnswers = answers.filter(({ summary }) => summary.count > 0);
                    return {
                        kind: 'summary',
                        count: answers.reduce((total, { summary }) => total + summary.count, 0),
                        names: answers.flatMap(({ summary }) => summary.names),
                        // Settings are shared, so the windows agree; requiring all keeps a prompt if one disagrees.
                        autoSave:
                            dirtyAnswers.length > 0 &&
                            dirtyAnswers.every(({ summary }) => summary.autoSave),
                    };
                },
                log: (outcome, count, error) =>
                    options
                        .logger()
                        ?.write(
                            outcome === 'readFailed' || outcome === 'promptFailed'
                                ? 'warn'
                                : 'info',
                            logEventCatalog.app.unsavedEditorsDecided,
                            { fields: { purpose, outcome, count, ...(error && { error }) } },
                        ),
                discardAll: async () => {
                    await Promise.allSettled([...dirty].map((key) => bridgeFor(key).discardAll()));
                },
                reveal: () => {
                    for (const key of dirty) bridgeFor(key).reveal();
                },
                saveAll: async () => {
                    const results = await Promise.all(
                        [...dirty].map((key) => bridgeFor(key).saveAll()),
                    );
                    return results.find((result) => result.kind !== 'saved') ?? { kind: 'saved' };
                },
            });
        },
        reply: (parameters: UnsavedEditorsReplyParameters) => {
            for (const bridge of bridges.values()) bridge.reply(parameters);
        },
    };
}
