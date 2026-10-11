import { randomUUID } from 'node:crypto';

import type { DesktopRequest, ServerEvent } from '@caxri/protocol';
import { CaxriError, errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';

type UnsavedEditorsRequest = Extract<ServerEvent, { event: 'editor.unsavedRequest' }>['payload'];
type UnsavedEditorsReplyParameters = Extract<
    DesktopRequest,
    { method: 'editor.unsavedReply' }
>['params'];
type UnsavedEditorsReply = UnsavedEditorsReplyParameters['reply'];
export type UnsavedEditorsSummary = Extract<UnsavedEditorsReply, { kind: 'summary' }>;
export type UnsavedEditorsSaveResult = Exclude<UnsavedEditorsReply, { kind: 'summary' }>;
export type UnsavedEditorsChoice = 'cancel' | 'discard' | 'save';
export type UnsavedEditorsPurpose = 'close' | 'quit';
/**
 * Closed outcome of one quit or close consultation, logged as `app.unsaved_editors_decided`.
 */
export type UnsavedEditorsOutcome =
    'cancelled' | 'discarded' | 'none' | 'promptFailed' | 'readFailed' | 'saveFailed' | 'saved';

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
        action: 'inspect' | 'saveAll',
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
            if (!reply) return { kind: 'summary', count: 0, names: [] };
            if (reply.kind !== 'summary')
                throw new CaxriError('INTERNAL', 'Workbench answered inspect with a save result');
            return reply;
        },
        async saveAll(): Promise<UnsavedEditorsSaveResult> {
            const reply = await ask('saveAll', options.saveTimeoutMs ?? SAVE_TIMEOUT_MS);
            // The Workbench vanished between the prompt and the save, taking its buffers with it.
            if (!reply) return { kind: 'saveFailed', reason: 'writeFailed' };
            if (reply.kind === 'summary')
                throw new CaxriError('INTERNAL', 'Workbench answered saveAll with a summary');
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

export type UnsavedEditorsBridge = ReturnType<typeof createUnsavedEditorsBridge>;

export function unsavedEditorsPrompt(
    summary: UnsavedEditorsSummary,
    purpose: UnsavedEditorsPurpose,
): MessageBoxOptions {
    const action = purpose === 'quit' ? 'quitting' : 'closing the window';
    const isSingle = summary.count === 1 && summary.names.length === 1;
    const listed =
        isSingle || summary.names.length === 0
            ? ''
            : `${summary.names.join('\n')}${summary.count > summary.names.length ? `\nand ${summary.count - summary.names.length} more` : ''}\n\n`;
    return {
        type: 'warning',
        title: 'Unsaved Changes',
        message: isSingle
            ? `Save changes to '${summary.names[0]}' before ${action}?`
            : `Save changes to ${summary.count} files before ${action}?`,
        detail: `${listed}Your changes will be lost if you don't save them.`,
        buttons: [isSingle ? 'Save' : 'Save All', "Don't Save", 'Cancel'],
        /**
         * Same convention as the per-tab `unsavedChangesPrompt`: Enter saves, Escape cancels, never the destructive
         * choice.
         */
        defaultId: 0,
        cancelId: 2,
    };
}

export async function confirmUnsavedEditors(
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
    inspect: () => Promise<UnsavedEditorsSummary>;
    /**
     * One structured record per consultation. `error` is set only for the failure outcomes.
     */
    log: (outcome: UnsavedEditorsOutcome, count: number, error?: string) => void;
    reveal: () => void;
    saveAll: () => Promise<UnsavedEditorsSaveResult>;
}

/**
 * Decides whether unsaved Editor buffers let a quit or window close continue. Reading the summary or showing the prompt
 * fails open: an unresponsive Renderer must not trap the user inside the app. Saving fails closed: once the user chose
 * Save, a failed write keeps the app open so the buffers survive, and the Renderer's own save toast names the reason.
 */
export async function decideUnsavedEditors(
    options: UnsavedEditorsDecisionOptions,
): Promise<'cancel' | 'continue'> {
    let summary: UnsavedEditorsSummary;
    try {
        summary = await options.inspect();
    } catch (error) {
        options.log('readFailed', 0, errorMessage(error, 'Unknown unsaved editor read failure'));
        return 'continue';
    }
    if (summary.count === 0) return 'continue';

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
    getWindow: () => BrowserWindow | undefined;
    logger: () => StructuredLogger | undefined;
    sendEvent: (event: Extract<ServerEvent, { event: 'editor.unsavedRequest' }>) => void;
}

/**
 * Composes the bridge, the native prompt, and structured logging for the Workbench window's quit and close paths.
 */
export function createWorkbenchUnsavedEditors(options: WorkbenchUnsavedEditorsOptions) {
    const bridge = createUnsavedEditorsBridge({
        send: (payload) => {
            const window = options.getWindow();
            if (!window || window.isDestroyed()) return false;
            options.sendEvent({ event: 'editor.unsavedRequest', payload });
            return true;
        },
    });
    return {
        decide: (purpose: UnsavedEditorsPurpose) =>
            decideUnsavedEditors({
                confirm: (summary) =>
                    confirmUnsavedEditors(options.dialog, options.getWindow(), summary, purpose),
                inspect: () => bridge.inspect(),
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
                reveal: () => bridge.reveal(),
                saveAll: () => bridge.saveAll(),
            }),
        reply: (parameters: UnsavedEditorsReplyParameters) => bridge.reply(parameters),
    };
}
