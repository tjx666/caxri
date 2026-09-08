import { useEffect, useMemo, useReducer, useRef } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { caxri } from '../../lib/caxri';
import { setBugReportOpen } from '../../stores/dialogs';
import { getBootstrap } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { getActivePaneTab } from '../workbench/pane-actions';
import type { BugReportContext, BugReportDraft, BugReportScreenshotReference } from './bug-report';
import {
    bugReportImageDeliveryNotice,
    buildBugReport,
    chooseBugReportTarget,
    runningAgentTargets,
} from './bug-report';
import type { ScreenshotAnnotation } from './screenshot-annotations';

type DiagnosticsContext = MethodResult<'bugReport.context'>;
type CapturedScreenshot = MethodResult<'bugReport.captureScreenshot'>;

/**
 * The original capture is never overwritten: re-opening the annotator has to redraw the marks over a clean image, so
 * `annotatedDataUrl` is a derived rasterization that is thrown away and rebuilt on every edit.
 */
interface BugReportScreenshot {
    annotatedDataUrl: string | undefined;
    annotations: ScreenshotAnnotation[];
    original: CapturedScreenshot;
}

interface ReportSource {
    project: BugReportContext['project'];
    session: BugReportContext['session'];
    visibleWork: BugReportContext['visibleWork'];
}

const EMPTY_DRAFT: BugReportDraft = { actual: '', expected: '', steps: '' };

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
        return { contextError: 'Select a Session before reporting a bug to an Agent.' };
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

function createBugReportDialogState(): BugReportDialogState {
    const initial = initialReportState();
    return {
        annotatorOpen: false,
        busy: false,
        // The dialog mounts hidden so the automatic capture below never photographs itself.
        captureHidden: true,
        capturing: true,
        contextError: initial.contextError,
        diagnostics: undefined,
        draft: EMPTY_DRAFT,
        report: undefined,
        screenshot: undefined,
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
 * rendering components stay focused on layout. The screenshot is captured once when the dialog opens — the owner's
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
    const {
        annotatorOpen,
        busy,
        captureHidden,
        capturing,
        contextError,
        diagnostics,
        draft,
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
                const value = await caxri.request('bugReport.context');
                if (isCurrent) updateState({ diagnostics: value });
            } catch (error: unknown) {
                if (isCurrent)
                    updateState({
                        contextError: errorMessage(error, 'Unable to load Caxri context.'),
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
    const captureScreenshot = async (): Promise<void> => {
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
                    original: await caxri.request('bugReport.captureScreenshot'),
                },
            });
        } catch (error) {
            updateState({
                screenshotError: errorMessage(error, 'Unable to capture the Caxri window.'),
            });
        } finally {
            updateState({ captureHidden: false, capturing: false });
        }
    };

    /**
     * React StrictMode double-invokes mount effects in development; a ref (which survives that remount, unlike reducer
     * state, which has not re-rendered yet when the effect runs again) keeps the window from being captured twice.
     */
    const hasRequestedCapture = useRef(false);
    useEffect(() => {
        if (hasRequestedCapture.current) return;
        hasRequestedCapture.current = true;
        // eslint-disable-next-line no-void -- intentional floating-promise discard, captureScreenshot() reports its own errors
        void captureScreenshot();
    }, []);

    /**
     * The image bytes last written by `bugReport.saveScreenshot` and the file they landed in. Preview → Back → Preview
     * is a normal edit loop, and without this every pass would write another multi-megabyte copy of identical bytes
     * into the temp directory, all of them referenced by a report the user never sent. A ref rather than reducer state
     * because it must not re-render anything: it only ever answers "have I already saved exactly this?".
     */
    const savedScreenshot = useRef<{ dataUrl: string; path: string }>(undefined);

    const targets = useMemo(
        () => runningAgentTargets(bootstrap?.terminals ?? [], source?.session.id ?? ''),
        [bootstrap?.terminals, source?.session.id],
    );
    const target = targets.find((item) => item.id === selectedTargetId);
    const imageDeliveryNotice = bugReportImageDeliveryNotice(target?.provider);
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
                            : (await caxri.request('bugReport.saveScreenshot', { dataUrl })).path;
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
                            'Unable to save the screenshot file. The report will not include an image path.',
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
            pushToast('success', 'Bug report copied');
        } catch (error) {
            updateState({ sendError: errorMessage(error, 'Unable to copy the bug report.') });
        }
    };

    const send = async (): Promise<void> => {
        if (!report || !source) return;
        const current = getBootstrap();
        if (current?.selectedSessionId !== source.session.id) {
            updateState({
                sendError: 'The selected Session changed. Copy the report or reopen this flow.',
            });
            return;
        }
        const liveTarget = runningAgentTargets(current.terminals, source.session.id).find(
            (item) => item.id === selectedTargetId,
        );
        if (!liveTarget) {
            updateState({
                sendError:
                    'The selected Agent is no longer running. Choose another Agent or copy the report.',
            });
            return;
        }
        updateState({ busy: true, sendError: undefined });
        try {
            await caxri.request('bugReport.send', {
                report,
                // The Agent-facing image is the annotated one; the original only exists so the marks stay editable.
                screenshot: screenshot && {
                    dataUrl: screenshot.annotatedDataUrl ?? screenshot.original.dataUrl,
                    height: screenshot.original.height,
                    width: screenshot.original.width,
                },
                sessionId: source.session.id,
                terminalId: liveTarget.id,
            });
            setBugReportOpen(false);
            pushToast('success', `Bug report sent to ${liveTarget.title}`);
        } catch (error) {
            updateState({ sendError: errorMessage(error, 'Unable to send the bug report.') });
        } finally {
            updateState({ busy: false });
        }
    };

    return {
        annotatorOpen,
        applyAnnotations,
        backToForm,
        busy,
        canPreview,
        captureHidden,
        captureScreenshot,
        capturing,
        closeAnnotator,
        contextError,
        copyReport,
        draft,
        imageDeliveryNotice,
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
