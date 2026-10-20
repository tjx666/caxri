import { useEffect, useMemo, useReducer, useRef } from 'react';

import type { AgentChatImageInput, MethodResult } from '@caxri/protocol';
import { BUG_REPORT_JPEG_DATA_URL_PREFIX, errorMessage } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { translate, useTranslation } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { setBugReportOpen } from '../../stores/dialogs';
import { getBootstrap } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { readAgentChatImage } from '../agent-chat/attachments/agent-chat-images';
import { activateTerminal } from '../terminal/terminal-commands';
import { getActivePaneTab } from '../workbench/pane-actions';
import type { BugReportContext, BugReportDraft, BugReportScreenshotReference } from './bug-report';
import {
    bugReportAgentTargets,
    bugReportImageDeliveryNotice,
    buildBugReport,
    canAttachBugReportScreenshot,
    chooseBugReportTarget,
} from './bug-report';
import {
    captureBugReportScreenshot,
    loadBugReportContext,
    saveBugReportScreenshot,
    sendBugReport,
} from './bug-report-client';
import type { BugReportDraftContent, BugReportScreenshot } from './bug-report-draft';
import {
    clearBugReportDraft,
    EMPTY_BUG_REPORT_DRAFT,
    hasBugReportDraftInput,
    openBugReportDraft,
    retainBugReportDraft,
} from './bug-report-draft';
import type { ScreenshotAnnotation } from './screenshot-annotations';

type DiagnosticsContext = MethodResult<'bugReport.context'>;

interface ReportSource {
    project: BugReportContext['project'];
    session: BugReportContext['session'];
    visibleWork: BugReportContext['visibleWork'];
}

function visibleWorkContext(): BugReportContext['visibleWork'] {
    const bootstrap = getBootstrap();
    const resource = getActivePaneTab()?.resource;
    if (!resource) return { kind: 'none' };
    if (resource.kind === 'file')
        // `pathBasename` falls back to its raw input (not 'file') when no non-empty segment exists,
        // e.g. an empty string; keep the original 'file' fallback for that case at this call site.
        return { kind: 'editor', fileName: pathBasename(resource.path) || 'file' };
    const terminal = bootstrap?.terminals.find((item) => item.id === resource.terminalId);
    if (!terminal) return { kind: 'none' };
    return { kind: 'terminal', provider: terminal.provider, terminalId: terminal.id };
}

/**
 * Encodes the annotated screenshot as a Chat image attachment. The report already carries the saved file's path, so a
 * capture that cannot be encoded (for example one that stays over the size limit after resizing) still sends as text.
 */
async function bugReportChatImage(dataUrl: string): Promise<AgentChatImageInput | undefined> {
    try {
        // Decoded by hand: the Renderer CSP's `connect-src` refuses `fetch` of a `data:` URL.
        const bytes = Uint8Array.from(
            atob(dataUrl.slice(BUG_REPORT_JPEG_DATA_URL_PREFIX.length)),
            (character) => character.codePointAt(0) ?? 0,
        );
        const { image } = await readAgentChatImage(
            new File([bytes], 'bug-report-screenshot.jpg', { type: 'image/jpeg' }),
        );
        return image;
    } catch {
        return undefined;
    }
}

function afterPaint(): Promise<void> {
    return new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
}

function initialReportState(): {
    contextError?: string;
    selectedTargetId?: string;
    source?: ReportSource;
} {
    const snapshot = getBootstrap();
    const session = snapshot?.sessions.find((item) => item.id === snapshot.selectedSessionId);
    const project = snapshot?.projects.find((item) => item.id === session?.projectId);
    if (!snapshot || !session || !project)
        return { contextError: translate('bugReport.flow.selectSession') };
    return {
        selectedTargetId: chooseBugReportTarget(
            snapshot.terminals,
            session.id,
            getActivePaneTab()?.resource,
        ),
        source: {
            project: { id: project.id },
            session: { id: session.id },
            visibleWork: visibleWorkContext(),
        },
    };
}

interface BugReportDialogState {
    annotatorOpen: boolean;
    busy: boolean;
    /**
     * Hides the dialog chrome so a capture shows the workbench, not this dialog.
     */
    captureHidden: boolean;
    capturing: boolean;
    contextError: string | undefined;
    diagnostics: DiagnosticsContext | undefined;
    draft: BugReportDraft;
    /**
     * True while the open dialog is showing a draft handed back by a previous close.
     */
    isRestoredDraft: boolean;
    report: string | undefined;
    screenshot: BugReportScreenshot | undefined;
    screenshotError: string | undefined;
    selectedTargetId: string | undefined;
    sendError: string | undefined;
    source: ReportSource | undefined;
}

type BugReportDialogUpdate =
    | Partial<BugReportDialogState>
    | ((state: BugReportDialogState) => Partial<BugReportDialogState>);

/**
 * Seeds a freshly mounted dialog. A draft retained by an earlier close is restored here rather than re-entered by the
 * user, and it suppresses the automatic capture: the retained screenshot and its annotations are part of the draft, and
 * a fresh capture would replace them with a picture of whatever is on screen now.
 */
function createBugReportDialogState(): BugReportDialogState {
    const initial = initialReportState();
    const retained = openBugReportDraft();
    return {
        annotatorOpen: false,
        busy: false,
        // The dialog mounts hidden so the automatic capture below never photographs itself.
        captureHidden: !retained.isRestored,
        capturing: !retained.isRestored,
        contextError: initial.contextError,
        diagnostics: undefined,
        draft: retained.draft,
        isRestoredDraft: retained.isRestored,
        report: undefined,
        screenshot: retained.screenshot,
        screenshotError: undefined,
        selectedTargetId: initial.selectedTargetId,
        sendError: undefined,
        source: initial.source,
    };
}

function bugReportDialogReducer(
    state: BugReportDialogState,
    update: BugReportDialogUpdate,
): BugReportDialogState {
    return { ...state, ...(typeof update === 'function' ? update(state) : update) };
}

/**
 * Owns the Bug Report dialog's reducer state, diagnostics fetch, screenshot lifecycle, and preview/send flow so the
 * rendering components stay focused on layout. The screenshot is captured once when the dialog opens: the owner's
 * dominant flow is "capture, mark the broken area, describe it", and an opt-in checkbox made the user reproduce the
 * problem a second time after they had already navigated away from it.
 */
export function useBugReportDialog() {
    const [state, updateState] = useReducer(
        bugReportDialogReducer,
        undefined,
        createBugReportDialogState,
    );
    const bootstrap = useWorkbenchStore((state) => state.bootstrap);
    const { t } = useTranslation();
    const {
        annotatorOpen,
        busy,
        captureHidden,
        capturing,
        contextError,
        diagnostics,
        draft,
        isRestoredDraft,
        report,
        screenshot,
        screenshotError,
        selectedTargetId,
        sendError,
        source,
    } = state;

    useEffect(() => {
        if (!source) return;
        let isCurrent = true;
        async function loadContext(): Promise<void> {
            try {
                const value = await loadBugReportContext();
                if (isCurrent) updateState({ diagnostics: value });
            } catch (error: unknown) {
                if (isCurrent)
                    updateState({
                        contextError: errorMessage(
                            error,
                            translate('bugReport.flow.contextLoadFailed'),
                        ),
                    });
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadContext();
        return () => {
            isCurrent = false;
        };
    }, [source]);

    /**
     * Hides the dialog, waits two frames so the compositor has actually painted without it, and captures. Both frames
     * are required: the first commits the `invisible` class, the second is the paint that class produces.
     */
    /**
     * `isRetaken` separates the capture the user asked for from the one the dialog takes on open, which is what lets a
     * screenshot-only draft survive a close without making every automatic capture look like unfinished work.
     */
    const captureScreenshot = async (isRetaken = true): Promise<void> => {
        updateState({
            capturing: true,
            captureHidden: true,
            screenshot: undefined,
            screenshotError: undefined,
        });
        await afterPaint();
        try {
            updateState({
                screenshot: {
                    annotatedDataUrl: undefined,
                    annotations: [],
                    isRetaken,
                    original: await captureBugReportScreenshot(),
                },
            });
        } catch (error) {
            updateState({
                screenshotError: errorMessage(error, translate('bugReport.flow.captureFailed')),
            });
        } finally {
            updateState({ captureHidden: false, capturing: false });
        }
    };

    /**
     * React StrictMode double-invokes mount effects in development; a ref (which survives that remount, unlike reducer
     * state, which has not re-rendered yet when the effect runs again) keeps the window from being captured twice. It
     * starts already-requested for a restored draft, whose screenshot (including the marks drawn on it) is the one the
     * user wants back, not a fresh photograph of the workbench they have since navigated away from.
     */
    const hasRequestedCapture = useRef(isRestoredDraft);
    useEffect(() => {
        if (hasRequestedCapture.current) return;
        hasRequestedCapture.current = true;
        // eslint-disable-next-line no-void -- intentional floating-promise discard, captureScreenshot() reports its own errors
        void captureScreenshot(false);
    }, []);

    /**
     * The draft as it stands right now, mirrored into a ref because the unmount below has to read it synchronously.
     * Escape, the close button, and an outside click all unmount this hook's owner in the same commit as the state
     * update that preceded them, so reducer state read from a closure can be one render stale; a ref cannot.
     */
    const latestContent = useRef<BugReportDraftContent>({ draft, screenshot });
    useEffect(() => {
        latestContent.current = { draft, screenshot };
    });

    /**
     * Whether closing should keep the draft. False only after a successful send, which is the one exit that already
     * delivered the work; everything else (Escape, the close button, an outside click) means "not now", not "delete
     * what I wrote". A ref rather than reducer state for the same commit-timing reason as {@link latestContent}.
     */
    const shouldRetainOnClose = useRef(true);
    useEffect(
        () => () => {
            if (shouldRetainOnClose.current) retainBugReportDraft(latestContent.current);
            else clearBugReportDraft();
        },
        [],
    );

    /**
     * The image bytes last written by `bugReport.saveScreenshot` and the file they landed in. Preview → Back → Preview
     * is a normal edit loop, and without this every pass would write another multi-megabyte copy of identical bytes
     * into the temp directory, all of them referenced by a report the user never sent. A ref rather than reducer state
     * because it must not re-render anything: it only ever answers "have I already saved exactly this?".
     */
    const savedScreenshot = useRef<{ dataUrl: string; path: string }>(undefined);

    const targets = useMemo(
        () => bugReportAgentTargets(bootstrap?.terminals ?? [], source?.session.id ?? ''),
        [bootstrap?.terminals, source?.session.id],
    );
    const target = targets.find((item) => item.id === selectedTargetId);
    const imageDeliveryNotice = bugReportImageDeliveryNotice(t, target);
    const isSessionChanged = Boolean(source && bootstrap?.selectedSessionId !== source.session.id);
    const canPreview = Boolean(
        source && diagnostics && draft.actual.trim() && draft.expected.trim(),
    );
    const previewDataUrl = screenshot
        ? (screenshot.annotatedDataUrl ?? screenshot.original.dataUrl)
        : undefined;

    const updateDraft = (field: keyof BugReportDraft, value: string): void => {
        updateState((current) => ({ draft: { ...current.draft, [field]: value } }));
    };

    const setSelectedTargetId = (value: string | undefined): void => {
        updateState({ selectedTargetId: value ?? undefined });
    };

    const backToForm = (): void => {
        updateState({ report: undefined });
    };

    const removeScreenshot = (): void => {
        updateState({ screenshot: undefined, screenshotError: undefined });
    };

    /**
     * The one path that actually throws the draft away. It is irreversible: the text, the capture, and every mark on it
     * go at once, so it asks first through the shared confirmation modal (DESIGN.md "Confirmations") instead of letting
     * a stray click do what closing the dialog deliberately no longer does.
     */
    const discardDraft = async (): Promise<void> => {
        const isConfirmed = await caxri.window.showConfirm({
            cancelLabel: t('bugReport.flow.keepDraft'),
            confirmLabel: t('bugReport.form.discardDraft'),
            message: t('bugReport.flow.discardConfirmMessage'),
            title: t('bugReport.flow.discardConfirmTitle'),
        });
        if (!isConfirmed) return;
        clearBugReportDraft();
        updateState({
            draft: EMPTY_BUG_REPORT_DRAFT,
            isRestoredDraft: false,
            report: undefined,
            screenshot: undefined,
            screenshotError: undefined,
            sendError: undefined,
        });
    };

    const openAnnotator = (): void => {
        updateState({ annotatorOpen: true });
    };

    const closeAnnotator = (): void => {
        updateState({ annotatorOpen: false });
    };

    const applyAnnotations = (
        annotations: ScreenshotAnnotation[],
        annotatedDataUrl: string | undefined,
    ): void => {
        updateState((current) => ({
            annotatorOpen: false,
            screenshot: current.screenshot && {
                ...current.screenshot,
                annotations,
                annotatedDataUrl,
            },
        }));
    };

    const preview = async (): Promise<void> => {
        if (!source || !diagnostics || !canPreview) return;
        const context: BugReportContext = { ...diagnostics, ...source };
        updateState({ busy: true, sendError: undefined });
        try {
            let reference: BugReportScreenshotReference | undefined;
            if (screenshot) {
                try {
                    const dataUrl = screenshot.annotatedDataUrl ?? screenshot.original.dataUrl;
                    const cached = savedScreenshot.current;
                    const path =
                        cached?.dataUrl === dataUrl
                            ? cached.path
                            : (await saveBugReportScreenshot({ dataUrl })).path;
                    savedScreenshot.current = { dataUrl, path };
                    reference = {
                        annotations: screenshot.annotations,
                        height: screenshot.original.height,
                        path,
                        width: screenshot.original.width,
                    };
                    updateState({ screenshotError: undefined });
                } catch (error) {
                    // A failed save must not block the report: the text half is still worth sending, it just cannot
                    // name a file the Agent can open.
                    updateState({
                        screenshotError: errorMessage(
                            error,
                            t('bugReport.flow.saveScreenshotFailed'),
                        ),
                    });
                }
            }
            updateState({ report: buildBugReport(draft, context, reference) });
        } finally {
            updateState({ busy: false });
        }
    };

    const copyReport = async (): Promise<void> => {
        if (!report) return;
        try {
            await navigator.clipboard.writeText(report);
            pushToast('success', t('bugReport.flow.copied'));
        } catch (error) {
            updateState({ sendError: errorMessage(error, t('bugReport.flow.copyFailed')) });
        }
    };

    const send = async (): Promise<void> => {
        if (!report || !source) return;
        const current = getBootstrap();
        if (current?.selectedSessionId !== source.session.id) {
            updateState({
                sendError: t('bugReport.preview.sessionChanged'),
            });
            return;
        }
        const liveTarget = bugReportAgentTargets(current.terminals, source.session.id).find(
            (item) => item.id === selectedTargetId,
        );
        if (!liveTarget) {
            updateState({
                sendError: t('bugReport.flow.agentStopped'),
            });
            return;
        }
        updateState({ busy: true, sendError: undefined });
        try {
            // The Agent-facing image is the annotated one; the original only exists so the marks stay editable.
            const agentScreenshot = screenshot && {
                dataUrl: screenshot.annotatedDataUrl ?? screenshot.original.dataUrl,
                height: screenshot.original.height,
                width: screenshot.original.width,
            };
            await sendBugReport({
                chatImage:
                    agentScreenshot && canAttachBugReportScreenshot(liveTarget)
                        ? await bugReportChatImage(agentScreenshot.dataUrl)
                        : undefined,
                report,
                screenshot: agentScreenshot,
                sessionId: source.session.id,
                terminalId: liveTarget.id,
            });
            // The draft has been delivered, so closing must not hand it back to the next open.
            shouldRetainOnClose.current = false;
            clearBugReportDraft();
            setBugReportOpen(false);
            // A Chat shows the delivered report as a message, so bring it forward like other sends to a Chat.
            if (liveTarget.surface === 'chat') activateTerminal(liveTarget.id);
            pushToast('success', t('bugReport.flow.sent', { title: liveTarget.title }));
        } catch (error) {
            updateState({ sendError: errorMessage(error, t('bugReport.flow.sendFailed')) });
        } finally {
            updateState({ busy: false });
        }
    };

    return {
        annotatorOpen,
        applyAnnotations,
        backToForm,
        busy,
        canDiscardDraft: hasBugReportDraftInput({ draft, screenshot }),
        canPreview,
        captureHidden,
        captureScreenshot,
        capturing,
        closeAnnotator,
        contextError,
        copyReport,
        discardDraft,
        draft,
        imageDeliveryNotice,
        isRestoredDraft,
        openAnnotator,
        preview,
        previewDataUrl,
        removeScreenshot,
        report,
        screenshot,
        screenshotError,
        selectedTargetId,
        send,
        sendError,
        sessionChanged: isSessionChanged,
        setSelectedTargetId,
        target,
        targets,
        updateDraft,
    };
}
