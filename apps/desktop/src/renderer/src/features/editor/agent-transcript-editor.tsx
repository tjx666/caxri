import type { AgentTranscriptTab } from '@caxri/protocol';
import Editor from '@monaco-editor/react';

import { useEditorOptions } from '@/hooks/use-editor-options';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { applyEditorTheme } from '../../lib/editor-theme';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useTheme } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { useAgentTranscriptFollow } from './hooks/use-agent-transcript-follow';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const emptyWorkDangerClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-danger';

/**
 * Read-only viewer for an Agent Terminal's provider transcript (`caxri-agent-transcript://` tabs). Server/WatchHub
 * invalidation keeps the query fresh after its initial `terminal.agentTranscript` read; the Server derives the path, so
 * this surface never submits a filesystem path. Rendered as plain text: each jsonl line is an independent JSON record,
 * which Monaco's `json` mode would cover in bogus multi-root diagnostics.
 */
export function AgentTranscriptEditor({ tab }: { tab: AgentTranscriptTab }) {
    const { t } = useTranslation();
    const theme = useTheme();
    const editorOptions = useEditorOptions();
    const query = useCaxriQuery('terminal.agentTranscript', {
        terminalId: tab.terminalId,
        withContent: true,
    });
    const follow = useAgentTranscriptFollow(query.data?.path ?? tab.terminalId);
    if (!theme) return null;
    if (query.isPending)
        return <LoadingSkeleton variant="document" label={t('editor.load.loadingTranscript')} />;
    if (query.isError)
        return (
            <div className={emptyWorkDangerClassName}>
                {describeFailure(query.error, t('editor.transcript.loadFailed'))}
            </div>
        );
    if (!query.data)
        return <div className={emptyWorkClassName}>{t('editor.transcript.unbound')}</div>;
    if (!query.data.exists)
        return (
            <div className={emptyWorkClassName}>
                <span>{t('editor.transcript.notFound')}</span>
                <code className="max-w-full px-6 text-[11px] break-all">{query.data.path}</code>
            </div>
        );
    return (
        <div className="agent-transcript-editor flex h-full min-h-0 flex-col">
            <div className="flex h-7 flex-none items-center gap-2 bg-surface px-3 text-[11px] text-muted">
                <Tooltip content={query.data.path}>
                    <span className={cn('truncate', FOCUSABLE_TOOLTIP_TRIGGER_CLASS)} tabIndex={0}>
                        {query.data.path}
                    </span>
                </Tooltip>
                {query.data.truncated && (
                    <span className="ml-auto flex-none text-warning">
                        {t('editor.transcript.truncated')}
                    </span>
                )}
            </div>
            <div
                className="relative min-h-0 flex-1"
                data-transcript-content-length={query.data.content?.length ?? 0}
                data-transcript-following={follow.isFollowing}
            >
                <Editor
                    className="h-full w-full"
                    path={`caxri://agent-transcript/${encodeURIComponent(tab.terminalId)}.jsonl`}
                    value={query.data.content ?? ''}
                    theme="caxri-active"
                    beforeMount={() => applyEditorTheme(theme)}
                    onMount={follow.onMount}
                    options={{
                        ...editorOptions,
                        readOnly: true,
                        wordWrap: 'on',
                    }}
                />
                {!follow.isFollowing && (
                    <Button
                        className="absolute right-4 bottom-4 z-10 shadow-[0_4px_16px_var(--shadow)]"
                        size="sm"
                        variant="secondary"
                        onClick={follow.jumpToLatest}
                    >
                        {t('editor.transcript.jumpToLatest')}
                    </Button>
                )}
            </div>
        </div>
    );
}
