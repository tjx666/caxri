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
import { useTranslation } from '../../i18n';
import { BUG_REPORT_SCREENSHOT_ALT_KEY } from './bug-report-screenshot-field';

interface BugReportPreviewProperties {
    busy: boolean;
    imageDeliveryNotice: string;
    onBack: () => void;
    onCopyReport: () => void;
    onOpenGithubIssue: () => void;
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
    onOpenGithubIssue,
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
    const { t } = useTranslation();
    return (
        <div className="grid gap-3 p-4">
            <pre className="m-0 max-h-72 overflow-auto rounded border border-border bg-background p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
                {report}
            </pre>
            {screenshotDataUrl && (
                <div className="grid gap-2">
                    <p className="m-0 text-[11px] text-warning">
                        {t('bugReport.preview.unredactedNotice')}
                    </p>
                    <img
                        alt={t(BUG_REPORT_SCREENSHOT_ALT_KEY)}
                        className="max-h-96 w-full rounded border border-border bg-background object-contain"
                        src={screenshotDataUrl}
                    />
                    <p className="m-0 text-[11px] text-muted">{imageDeliveryNotice}</p>
                </div>
            )}
            {screenshotError && <p className="m-0 text-[11px] text-warning">{screenshotError}</p>}
            <div className="grid gap-1">
                <label className="text-[12px]" htmlFor="bug-report-target">
                    {t('bugReport.preview.targetAgent')}
                </label>
                <Select
                    value={selectedTargetId}
                    onValueChange={(value) => onSelectedTargetChange(value ?? undefined)}
                >
                    <SelectTrigger
                        id="bug-report-target"
                        aria-label={t('bugReport.preview.targetAgent')}
                        disabled={targets.length === 0}
                    >
                        <SelectValue>
                            {target
                                ? `${agentProviderCatalog[target.provider!].displayName} — ${target.title}`
                                : t('bugReport.preview.noRunningAgent')}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {targets.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                                {agentProviderCatalog[item.provider!].displayName} — {item.title}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {(sessionChanged || !target) && (
                <p className="m-0 text-[11px] text-warning">
                    {t(
                        sessionChanged
                            ? 'bugReport.preview.sessionChanged'
                            : 'bugReport.preview.noAgentAvailable',
                    )}
                </p>
            )}
            {sendError && (
                <p className="m-0 rounded border border-danger px-3 py-2 text-[12px] text-danger">
                    {sendError}
                </p>
            )}
            <div className="flex justify-between gap-2">
                <Button variant="secondary" onClick={onBack}>
                    {t('common.back')}
                </Button>
                <div className="flex gap-2">
                    <Button variant="secondary" onClick={onCopyReport}>
                        {t('bugReport.preview.copyReport')}
                    </Button>
                    <Button variant="secondary" onClick={onOpenGithubIssue}>
                        {t('bugReport.preview.openGithubIssue')}
                    </Button>
                    <Button disabled={busy || sessionChanged || !target} onClick={onSend}>
                        {t(busy ? 'bugReport.preview.sending' : 'bugReport.preview.sendToAgent')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
