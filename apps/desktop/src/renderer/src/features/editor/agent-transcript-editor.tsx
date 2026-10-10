import type { AgentTranscriptTab } from '@caxri/protocol';
import Editor from '@monaco-editor/react';

import { useEditorOptions } from '@/hooks/use-editor-options';

import { Button } from '../../components/ui/button';
import { applyEditorTheme } from '../../lib/editor-theme';
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
    const theme = useTheme();
    const editorOptions = useEditorOptions();
    const query = useCaxriQuery('terminal.agentTranscript', {
        terminalId: tab.terminalId,
        withContent: true,
    });
    const follow = useAgentTranscriptFollow(query.data?.path ?? tab.terminalId);
    if (!theme) return null;
    if (query.isPending) return <div className={emptyWorkClassName}>Loading transcript…</div>;
    if (query.isError)
        return (
            <div className={emptyWorkDangerClassName}>
                {describeFailure(query.error, 'Unable to load transcript')}
            </div>
        );
    if (!query.data)
        return (
            <div className={emptyWorkClassName}>
                This terminal has no bound agent transcript to show.
            </div>
        );
    if (!query.data.exists)
        return (
            <div className={emptyWorkClassName}>
                <span>Transcript file not found.</span>
                <code className="max-w-full px-6 text-[11px] break-all">{query.data.path}</code>
            </div>
        );
    return (
        <div className="agent-transcript-editor flex h-full min-h-0 flex-col">
            <div
                className="flex h-7 flex-none items-center gap-2 bg-surface px-3 text-[11px] text-muted"
                title={query.data.path}
            >
                <span className="truncate">{query.data.path}</span>
                {query.data.truncated && (
                    <span className="ml-auto flex-none text-warning">
                        Truncated — showing the newest part
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
                        Jump to Latest
                    </Button>
                )}
            </div>
        </div>
    );
}
