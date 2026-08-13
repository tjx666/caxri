import { useEffect, useMemo, useReducer } from 'react';

import { errorMessage, type MethodResult } from '@shared/ipc';

import { caxri } from '../../lib/caxri';
import { setBugReportOpen } from '../../stores/dialogs';
import { getResolvedActiveWork } from '../../stores/session-view';
import { getBootstrap } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    bugReportImageFallback,
    buildBugReport,
    chooseBugReportTarget,
    runningAgentTargets,
    type BugReportContext,
    type BugReportDraft,
} from './bug-report';

type DiagnosticsContext = MethodResult<'bugReport.context'>;
export type Screenshot = MethodResult<'bugReport.captureScreenshot'>;

interface ReportSource {
    project: BugReportContext['project'];
    session: BugReportContext['session'];
    visibleWork: BugReportContext['visibleWork'];
}

const EMPTY_DRAFT: BugReportDraft = { actual: '', expected: '', steps: '' };

function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'file';
}

function visibleWorkContext(): BugReportContext['visibleWork'] {
    const bootstrap = getBootstrap();
    const activeWork = getResolvedActiveWork();
    if (!activeWork) return { kind: 'none' };
    if (activeWork.kind === 'editor')
        return { kind: 'editor', fileName: basename(activeWork.path) };
    const terminal = bootstrap?.terminals.find((item) => item.id === activeWork.terminalId);
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
            getResolvedActiveWork(),
        ),
        source: {
            project: { id: project.id },
            session: { id: session.id },
            visibleWork: visibleWorkContext(),
        },
    };
}

interface BugReportDialogState {
    busy: boolean;
    captureHidden: boolean;
    contextError: string | undefined;
    diagnostics: DiagnosticsContext | undefined;
    draft: BugReportDraft;
    includeScreenshot: boolean;
    report: string | undefined;
    screenshot: Screenshot | undefined;
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
        busy: false,
        captureHidden: false,
        contextError: initial.contextError,
        diagnostics: undefined,
        draft: EMPTY_DRAFT,
        includeScreenshot: false,
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
 * Owns the Bug Report dialog's reducer state, diagnostics fetch, and preview/send flow so the
 * rendering component can stay focused on layout. Behavior — redaction, screenshot capture, and
 * Session/Agent liveness checks on send — is unchanged from the previous single-component version.
 */
export function useBugReportDialog() {
    const [state, updateState] = useReducer(
        bugReportDialogReducer,
        undefined,
        createBugReportDialogState,
    );
    const bootstrap = useWorkbenchStore((state) => state.bootstrap);
    const {
        busy,
        captureHidden,
        contextError,
        diagnostics,
        draft,
        includeScreenshot,
        report,
        screenshot,
        screenshotError,
        selectedTargetId,
        sendError,
        source,
    } = state;

    useEffect(() => {
        if (!source) return;
        let current = true;
        void caxri
            .request('bugReport.context')
            .then((value) => {
                if (current) updateState({ diagnostics: value });
            })
            .catch((error: unknown) => {
                if (current)
                    updateState({
                        contextError: errorMessage(error, 'Unable to load Caxri context.'),
                    });
            });
        return () => {
            current = false;
        };
    }, [source]);

    const targets = useMemo(
        () => runningAgentTargets(bootstrap?.terminals ?? [], source?.session.id ?? ''),
        [bootstrap?.terminals, source?.session.id],
    );
    const target = targets.find((item) => item.id === selectedTargetId);
    const imageFallbackNotice = bugReportImageFallback(target?.provider);
    const sessionChanged = Boolean(source && bootstrap?.selectedSessionId !== source.session.id);
    const canPreview = Boolean(
        source && diagnostics && draft.actual.trim() && draft.expected.trim() && draft.steps.trim(),
    );

    const updateDraft = (field: keyof BugReportDraft, value: string): void => {
        updateState((current) => ({ draft: { ...current.draft, [field]: value } }));
    };

    const setIncludeScreenshot = (checked: boolean): void => {
        updateState({ includeScreenshot: checked });
    };

    const setSelectedTargetId = (value: string | undefined): void => {
        updateState({ selectedTargetId: value ?? undefined });
    };

    const backToForm = (): void => {
        updateState({ report: undefined });
    };

    const preview = async (): Promise<void> => {
        if (!source || !diagnostics || !canPreview) return;
        const context: BugReportContext = { ...diagnostics, ...source };
        updateState({
            busy: true,
            screenshot: undefined,
            screenshotError: undefined,
            sendError: undefined,
        });
        try {
            if (includeScreenshot) {
                updateState({ captureHidden: true });
                await afterPaint();
                try {
                    updateState({
                        screenshot: await caxri.request('bugReport.captureScreenshot'),
                    });
                } catch (error) {
                    updateState({
                        screenshotError: errorMessage(error, 'Unable to capture the Caxri window.'),
                    });
                } finally {
                    updateState({ captureHidden: false });
                }
            }
            updateState({ report: buildBugReport(draft, context) });
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
                screenshot,
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
        backToForm,
        busy,
        canPreview,
        captureHidden,
        contextError,
        copyReport,
        draft,
        imageFallbackNotice,
        includeScreenshot,
        preview,
        report,
        screenshot,
        screenshotError,
        selectedTargetId,
        send,
        sendError,
        sessionChanged,
        setIncludeScreenshot,
        setSelectedTargetId,
        target,
        targets,
        updateDraft,
    };
}
