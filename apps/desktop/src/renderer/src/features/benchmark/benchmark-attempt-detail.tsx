import { useMemo } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';
import type { BenchmarkAttempt } from '@caxri/protocol';
import { formatTokens } from '@caxri/protocol';
import { Square } from 'lucide-react';

import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { pushToast, tryCommand } from '../../stores/toasts';
import { cancelBenchmark } from './benchmark-commands';
import { attemptStatusLabel } from './benchmark-presentation';
import { isAttemptFinished } from './benchmark-results';

function openUrl(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports its own rejection through the callback
    void openExternalUrl(url, (message) => pushToast('error', message));
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section aria-label={title} className="flex min-w-0 flex-col gap-1.5">
            <h4 className="m-0 text-[11px] font-semibold text-muted">{title}</h4>
            {children}
        </section>
    );
}

function diffLineClass(line: string): string {
    if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted';
    if (line.startsWith('+')) return 'text-diff-stat-added';
    if (line.startsWith('-')) return 'text-diff-stat-removed';
    if (line.startsWith('@@') || line.startsWith('diff --git')) return 'text-muted';
    return '';
}

/**
 * The files an Attempt changed, read from its folder only once someone opens it.
 */
function AttemptDiff({ runId, attemptId }: { runId: string; attemptId: string }) {
    const { t } = useTranslation();
    const query = useCaxriQuery(
        'benchmark.attemptDiff',
        { runId, attemptId },
        { staleTime: Infinity },
    );
    if (query.isPending)
        return (
            <div className="flex items-center gap-2 text-[12px] text-muted">
                <Spinner aria-hidden="true" className="size-3" />
                {t('benchmark.detail.diffLoading')}
            </div>
        );
    if (query.isError)
        return <p className="m-0 text-[12px] text-danger">{t('benchmark.detail.diffFailed')}</p>;
    if (!query.data.diff)
        return <p className="m-0 text-[12px] text-muted">{t('benchmark.detail.noChanges')}</p>;
    return (
        <>
            <pre className="m-0 max-h-96 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-[1.5]">
                {query.data.diff.split('\n').map((line, index) => (
                    // Diff lines have no identity beyond their position, and the list never reorders.
                    <div key={index} className={cn('whitespace-pre', diffLineClass(line))}>
                        {line || ' '}
                    </div>
                ))}
            </pre>
            {query.data.truncated && (
                <p className="m-0 text-[11px] text-muted">{t('benchmark.detail.diffTruncated')}</p>
            )}
        </>
    );
}

/**
 * Everything one Attempt left behind: why it ended, the judge's reason, the check output, the final answer, and the
 * diff. A running Attempt offers Stop instead.
 */
export function BenchmarkAttemptDetail({
    runId,
    attempt,
}: {
    runId: string;
    attempt: BenchmarkAttempt;
}) {
    const { t } = useTranslation();
    const blocks = useMemo(() => parseMarkdownBlocks(attempt.finalText ?? ''), [attempt.finalText]);
    const isFinished = isAttemptFinished(attempt);
    return (
        <div className="flex min-w-0 flex-col gap-4" data-benchmark-attempt-detail={attempt.id}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                <span
                    className={cn(
                        attempt.status === 'completed'
                            ? 'text-foreground'
                            : attempt.status === 'cancelled'
                              ? 'text-muted'
                              : isFinished
                                ? 'text-danger'
                                : 'text-muted',
                    )}
                >
                    {attemptStatusLabel(t, attempt)}
                </span>
                {attempt.resolvedModel && (
                    <span className="text-muted">
                        {t('benchmark.detail.resolved', {
                            model: attempt.resolvedModel,
                            effort: attempt.resolvedEffort ?? t('benchmark.picker.defaultEffort'),
                        })}
                    </span>
                )}
                {attempt.tokens && (
                    <span className="text-muted tabular-nums">
                        {t('benchmark.detail.tokens', {
                            total: formatTokens(attempt.tokens.total),
                            output: formatTokens(attempt.tokens.output),
                        })}
                    </span>
                )}
                {isFinished && (
                    <span className="text-muted tabular-nums">
                        {t('benchmark.board.steps', { count: attempt.steps })}
                    </span>
                )}
                {attempt.cliVersion && (
                    <span className="truncate text-muted">{attempt.cliVersion}</span>
                )}
                {!isFinished && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            // eslint-disable-next-line no-void -- tryCommand reports its own failure
                            void tryCommand(t('benchmark.detail.stop'), () =>
                                cancelBenchmark(runId, attempt.id),
                            );
                        }}
                    >
                        <Square aria-hidden="true" size={11} />
                        {t('benchmark.detail.stop')}
                    </Button>
                )}
            </div>
            {attempt.failureMessage && (
                <p className="m-0 rounded-md border border-border bg-background p-2 text-[12px] whitespace-pre-wrap text-danger">
                    {attempt.failureMessage}
                </p>
            )}
            {attempt.judge && (
                <DetailSection title={t('benchmark.detail.judge', { score: attempt.judge.score })}>
                    <p className="m-0 text-[12px] leading-[1.5]">
                        {attempt.judge.reason || t('benchmark.detail.noReason')}
                    </p>
                </DetailSection>
            )}
            {attempt.check && (
                <DetailSection
                    title={t(`benchmark.detail.check.${attempt.check.status}`, {
                        code: attempt.check.exitCode ?? '',
                    })}
                >
                    {attempt.check.outputTail ? (
                        <pre className="m-0 max-h-60 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap">
                            {attempt.check.outputTail}
                        </pre>
                    ) : (
                        <p className="m-0 text-[12px] text-muted">
                            {t('benchmark.detail.checkNoOutput')}
                        </p>
                    )}
                </DetailSection>
            )}
            {isFinished && (
                <DetailSection title={t('benchmark.detail.answer')}>
                    {blocks.length > 0 ? (
                        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-background p-3 text-[13px] leading-[1.5] wrap-anywhere">
                            <MarkdownBlocks
                                blocks={blocks}
                                variant="transcript"
                                onOpenUrl={openUrl}
                            />
                        </div>
                    ) : (
                        <p className="m-0 text-[12px] text-muted">
                            {t('benchmark.detail.noAnswer')}
                        </p>
                    )}
                </DetailSection>
            )}
            {isFinished &&
                attempt.diff &&
                (attempt.diff.files > 0 || attempt.status === 'completed') && (
                    <DetailSection title={t('benchmark.detail.changes')}>
                        <AttemptDiff attemptId={attempt.id} runId={runId} />
                    </DetailSection>
                )}
        </div>
    );
}
