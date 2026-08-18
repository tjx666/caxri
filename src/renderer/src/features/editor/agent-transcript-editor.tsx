import Editor from '@monaco-editor/react';
import type { AgentTranscriptTab } from '@shared/agent-transcript';

import { useEditorFontFamily } from '@/hooks/use-editor-font-family';

import { applyEditorTheme } from '../../lib/editor-theme';
import { useCaxriQuery } from '../../queries/client';
import { useTheme } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const emptyWorkDangerClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-danger';

/**
 * Read-only viewer for an Agent Terminal's provider transcript (`caxri-agent-transcript://` tabs). Content is fetched
 * fresh on mount through `terminal.agentTranscript`, whose path the Runtime derives itself — this surface never submits
 * a filesystem path. Rendered as plain text: each jsonl line is an independent JSON record, which Monaco's `json` mode
 * would cover in bogus multi-root diagnostics.
 */
export function AgentTranscriptEditor({ tab }: { tab: AgentTranscriptTab }) {
    const theme = useTheme();
    const fontFamily = useEditorFontFamily();
    const query = useCaxriQuery('terminal.agentTranscript', {
        terminalId: tab.terminalId,
        withContent: true,
    });
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
            <div className="min-h-0 flex-1">
                <Editor
                    className="h-full w-full"
                    path={`caxri://agent-transcript/${encodeURIComponent(tab.terminalId)}.jsonl`}
                    value={query.data.content ?? ''}
                    theme="caxri-active"
                    beforeMount={() => applyEditorTheme(theme)}
                    options={{
                        automaticLayout: true,
                        ...(fontFamily && { fontFamily }),
                        fontSize: 13,
                        minimap: { enabled: false },
                        readOnly: true,
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                    }}
                />
            </div>
        </div>
    );
}
