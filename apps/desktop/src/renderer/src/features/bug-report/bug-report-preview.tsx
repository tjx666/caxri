import type { TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { BUG_REPORT_SCREENSHOT_ALT } from './bug-report-screenshot-field';

interface BugReportPreviewProperties {
    busy: boolean;
    imageDeliveryNotice: string;
    onBack: () => void;
    onCopyReport: () => void;
    onSelectedTargetChange: (value: string | undefined) => void;
    onSend: () => void;
    report: string;
    /**
     * The annotated rasterization, or the untouched capture when nothing was drawn.
     */
    screenshotDataUrl: string | undefined;
    screenshotError: string | undefined;
    selectedTargetId: string | undefined;
    sendError: string | undefined;
    sessionChanged: boolean;
    target: TerminalRecord | undefined;
    targets: TerminalRecord[];
}

/**
 * The redacted-report review step of the Bug Report dialog, shown after a preview is built.
 */
export function BugReportPreview({
    busy,
    imageDeliveryNotice,
    onBack,
    onCopyReport,
    onSelectedTargetChange,
    onSend,
    report,
    screenshotDataUrl,
    screenshotError,
    selectedTargetId,
    sendError,
    sessionChanged,
    target,
    targets,
}: BugReportPreviewProperties) {
    return (
        <div className="grid gap-3 p-4">
            <pre className="m-0 max-h-72 overflow-auto rounded border border-border bg-background p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
                {report}
            </pre>
            {screenshotDataUrl && (
                <div className="grid gap-2">
                    <p className="m-0 text-[11px] text-warning">
                        This screenshot is unredacted: it captures everything currently visible in
                        the Caxri window, including open files and Terminal output.
                    </p>
                    <img
                        alt={BUG_REPORT_SCREENSHOT_ALT}
                        className="max-h-96 w-full rounded border border-border bg-background object-contain"
                        src={screenshotDataUrl}
                    />
                    <p className="m-0 text-[11px] text-muted">{imageDeliveryNotice}</p>
                </div>
            )}
            {screenshotError && <p className="m-0 text-[11px] text-warning">{screenshotError}</p>}
            <div className="grid gap-1">
                <label className="text-[12px]" htmlFor="bug-report-target">
                    Target Agent
                </label>
                <Select
                    value={selectedTargetId}
                    onValueChange={(value) => onSelectedTargetChange(value ?? undefined)}
                >
                    <SelectTrigger
                        id="bug-report-target"
                        aria-label="Target Agent"
                        disabled={targets.length === 0}
                    >
                        <SelectValue>
                            {target
                                ? `${agentProviderCatalog[target.provider!].displayName}: ${target.title}`
                                : 'No running Agent in this Session'}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {targets.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                                {agentProviderCatalog[item.provider!].displayName}: {item.title}
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
                <Button variant="secondary" onClick={onBack}>
                    Back
                </Button>
                <div className="flex gap-2">
                    <Button variant="secondary" onClick={onCopyReport}>
                        Copy Report
                    </Button>
                    <Button disabled={busy || sessionChanged || !target} onClick={onSend}>
                        {busy ? 'Sending…' : 'Send to Agent'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
