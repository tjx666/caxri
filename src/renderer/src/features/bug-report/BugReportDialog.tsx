import { useEffect, useMemo, useState } from 'react';

import { agentProviderCatalog } from '@shared/agents';
import { errorMessage, type MethodResult } from '@shared/ipc';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Textarea } from '../../components/ui/textarea';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utils';
import { setBugReportOpen, useDialogStore } from '../../stores/dialogs';
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
type Screenshot = MethodResult<'bugReport.captureScreenshot'>;

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

function BugReportDialogContent() {
    const [initial] = useState(initialReportState);
    const bootstrap = useWorkbenchStore((state) => state.bootstrap);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const source = initial.source;
    const [diagnostics, setDiagnostics] = useState<DiagnosticsContext>();
    const [contextError, setContextError] = useState(initial.contextError);
    const [selectedTargetId, setSelectedTargetId] = useState(initial.selectedTargetId);
    const [includeScreenshot, setIncludeScreenshot] = useState(false);
    const [screenshot, setScreenshot] = useState<Screenshot>();
    const [screenshotError, setScreenshotError] = useState<string>();
    const [captureHidden, setCaptureHidden] = useState(false);
    const [report, setReport] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [sendError, setSendError] = useState<string>();

    useEffect(() => {
        if (!source) return;
        let current = true;
        void caxri
            .request('bugReport.context')
            .then((value) => {
                if (current) setDiagnostics(value);
            })
            .catch((error: unknown) => {
                if (current) setContextError(errorMessage(error, 'Unable to load Caxri context.'));
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
        setDraft((current) => ({ ...current, [field]: value }));
    };

    const preview = async (): Promise<void> => {
        if (!source || !diagnostics || !canPreview) return;
        const context: BugReportContext = { ...diagnostics, ...source };
        setBusy(true);
        setSendError(undefined);
        setScreenshot(undefined);
        setScreenshotError(undefined);
        if (includeScreenshot) {
            setCaptureHidden(true);
            await afterPaint();
            try {
                setScreenshot(await caxri.request('bugReport.captureScreenshot'));
            } catch (error) {
                setScreenshotError(errorMessage(error, 'Unable to capture the Caxri window.'));
            } finally {
                setCaptureHidden(false);
            }
        }
        setReport(buildBugReport(draft, context));
        setBusy(false);
    };

    const copyReport = async (): Promise<void> => {
        if (!report) return;
        try {
            await navigator.clipboard.writeText(report);
            pushToast('success', 'Bug report copied');
        } catch (error) {
            setSendError(errorMessage(error, 'Unable to copy the bug report.'));
        }
    };

    const send = async (): Promise<void> => {
        if (!report || !source) return;
        const current = getBootstrap();
        if (current?.selectedSessionId !== source.session.id) {
            setSendError('The selected Session changed. Copy the report or reopen this flow.');
            return;
        }
        const liveTarget = runningAgentTargets(current.terminals, source.session.id).find(
            (item) => item.id === selectedTargetId,
        );
        if (!liveTarget) {
            setSendError(
                'The selected Agent is no longer running. Choose another Agent or copy the report.',
            );
            return;
        }
        setBusy(true);
        setSendError(undefined);
        try {
            await caxri.request('bugReport.send', {
                report,
                sessionId: source.session.id,
                terminalId: liveTarget.id,
            });
            setBugReportOpen(false);
            pushToast('success', `Bug report sent to ${liveTarget.title}`);
        } catch (error) {
            setSendError(errorMessage(error, 'Unable to send the bug report.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <DialogContent
            backdropClassName={captureHidden ? 'invisible' : undefined}
            className={cn('w-[min(680px,calc(100vw-32px))]', captureHidden && 'invisible')}
            data-bug-report-dialog
        >
            <DialogHeader>
                <DialogTitle>Report Bug to Agent</DialogTitle>
                <DialogDescription>
                    Preview a redacted Markdown report before sending it to one running Agent in the
                    current Session.
                </DialogDescription>
            </DialogHeader>
            {!report ? (
                <div className="grid gap-3 p-4">
                    {contextError && (
                        <p className="m-0 rounded border border-danger px-3 py-2 text-[12px] text-danger">
                            {contextError}
                        </p>
                    )}
                    <label className="grid gap-1 text-[12px]">
                        <span>Actual behavior</span>
                        <Textarea
                            autoFocus
                            maxLength={12_000}
                            placeholder="What happened?"
                            value={draft.actual}
                            onChange={(event) => updateDraft('actual', event.target.value)}
                        />
                    </label>
                    <label className="grid gap-1 text-[12px]">
                        <span>Expected behavior</span>
                        <Textarea
                            maxLength={12_000}
                            placeholder="What should have happened?"
                            value={draft.expected}
                            onChange={(event) => updateDraft('expected', event.target.value)}
                        />
                    </label>
                    <label className="grid gap-1 text-[12px]">
                        <span>Reproduction steps</span>
                        <Textarea
                            maxLength={12_000}
                            placeholder="1. …"
                            value={draft.steps}
                            onChange={(event) => updateDraft('steps', event.target.value)}
                        />
                    </label>
                    <div className="grid gap-1 text-muted">
                        <label className="flex items-center gap-2 text-[12px]">
                            <input
                                checked={includeScreenshot}
                                className="size-4 accent-[var(--accent)]"
                                type="checkbox"
                                onChange={(event) => setIncludeScreenshot(event.target.checked)}
                            />
                            Capture a screenshot of the current Caxri window for preview
                        </label>
                        <p className="m-0 pl-6 text-[11px]">{imageFallbackNotice}</p>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button disabled={!canPreview || busy} onClick={() => void preview()}>
                            {busy ? 'Preparing…' : 'Preview Report'}
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="grid gap-3 p-4">
                    <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-3 text-[11px] leading-relaxed text-foreground">
                        {report}
                    </pre>
                    {screenshot && (
                        <div className="grid gap-2">
                            <img
                                alt="Current Caxri window screenshot"
                                className="max-h-48 w-full rounded border border-border object-contain bg-background"
                                height={screenshot.height}
                                src={screenshot.dataUrl}
                                width={screenshot.width}
                            />
                            <p className="m-0 text-[11px] text-warning">{imageFallbackNotice}</p>
                        </div>
                    )}
                    {screenshotError && (
                        <p className="m-0 text-[11px] text-warning">{screenshotError}</p>
                    )}
                    <div className="grid gap-1">
                        <label className="text-[12px]" htmlFor="bug-report-target">
                            Target Agent
                        </label>
                        <Select
                            value={selectedTargetId}
                            onValueChange={(value) => setSelectedTargetId(value ?? undefined)}
                        >
                            <SelectTrigger
                                id="bug-report-target"
                                aria-label="Target Agent"
                                disabled={targets.length === 0}
                            >
                                <SelectValue>
                                    {target
                                        ? `${agentProviderCatalog[target.provider!].displayName} — ${target.title}`
                                        : 'No running Agent in this Session'}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {targets.map((item) => (
                                    <SelectItem key={item.id} value={item.id}>
                                        {agentProviderCatalog[item.provider!].displayName} —{' '}
                                        {item.title}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {(sessionChanged || !target) && (
                        <p className="m-0 text-[11px] text-warning">
                            {sessionChanged
                                ? 'The selected Session changed. Copy the report or reopen this flow.'
                                : 'No running Agent is available. You can still copy the report.'}
                        </p>
                    )}
                    {sendError && (
                        <p className="m-0 rounded border border-danger px-3 py-2 text-[12px] text-danger">
                            {sendError}
                        </p>
                    )}
                    <div className="flex justify-between gap-2">
                        <Button variant="secondary" onClick={() => setReport(undefined)}>
                            Back
                        </Button>
                        <div className="flex gap-2">
                            <Button variant="secondary" onClick={() => void copyReport()}>
                                Copy Report
                            </Button>
                            <Button
                                disabled={busy || sessionChanged || !target}
                                onClick={() => void send()}
                            >
                                {busy ? 'Sending…' : 'Send to Agent'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </DialogContent>
    );
}

export function BugReportDialog() {
    const open = useDialogStore((state) => state.bugReportOpen);
    const requestId = useDialogStore((state) => state.bugReportRequestId);
    return (
        <Dialog open={open} onOpenChange={setBugReportOpen}>
            {open && <BugReportDialogContent key={requestId} />}
        </Dialog>
    );
}
