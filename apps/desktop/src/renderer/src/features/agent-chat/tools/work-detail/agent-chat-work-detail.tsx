import type { AgentChatWorkItem } from '@caxri/protocol';
import {
    agentChatOutputLanguage,
    agentChatReasoningTitle,
    agentChatToolCallArguments,
    describeAgentChatWorkRow,
    formatAgentChatJsonOutput,
    isAgentChatWorkRunning,
    stripLineNumberGutter,
    unwrapShellCommand,
} from '@caxri/protocol';

import { CodeView } from '../../../../components/markdown/code-view';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { AgentChatMessage } from '../../messages/agent-chat-message';
import { AgentChatFileChanges } from '../../turns/agent-chat-file-changes';
import { AgentChatToolArguments } from './agent-chat-tool-arguments';

/**
 * Output and command bodies are content in an otherwise `select-none` transcript, so they opt back into selection; the
 * code view's header stays chrome.
 */
const OUTPUT_CLASS_NAME = 'max-h-80 overflow-y-auto select-text';

/**
 * An expanded file change shows every file's diff when it touches only a few files; a wider change starts as headers.
 */
const TIMELINE_EXPANDED_FILE_LIMIT = 3;

/**
 * A command the row title can show in full is not repeated as its own block; a long or multi-line one is.
 */
const COMMAND_TITLE_LENGTH = 80;

/**
 * A tool's output. `isWrapped` starts it soft-wrapped: an MCP server answers in prose more often than in code, and a
 * paragraph on one scrolling line is unreadable.
 */
function OutputView({
    isRunning,
    isWrapped,
    language,
    text,
}: {
    /**
     * True while the output still grows: re-tokenizing the whole block on every append costs more than the colors show,
     * so a running item stays plain text and is painted once when it settles (as Markdown code blocks do). An empty
     * running output says none arrived yet rather than that there is none.
     */
    isRunning: boolean;
    isWrapped?: boolean;
    language: string | undefined;
    text: string;
}) {
    const { t } = useTranslation();
    const trimmed = text.replace(/\n+$/u, '');
    const output = language === 'json' ? formatAgentChatJsonOutput(trimmed) : trimmed;
    if (!output)
        return (
            <p className="m-0 text-muted">
                {t(isRunning ? 'agentChat.workGroup.noOutputYet' : 'agentChat.workGroup.noOutput')}
            </p>
        );
    return (
        <CodeView
            className={OUTPUT_CLASS_NAME}
            code={output}
            defaultWrapped={isWrapped}
            isPaintable={!isRunning}
            label={t('agentChat.workGroup.output')}
            language={language}
        />
    );
}

/**
 * A command's full text when the row title cannot show it, then its output, exit code, and background note.
 */
function CommandDetail({
    isRunning,
    item,
}: {
    isRunning: boolean;
    item: Extract<AgentChatWorkItem, { type: 'command' }>;
}) {
    const { t } = useTranslation();
    const command = unwrapShellCommand(item.command);
    return (
        <>
            {(item.description !== undefined ||
                describeAgentChatWorkRow(item).kind !== 'command' ||
                command.length > COMMAND_TITLE_LENGTH ||
                command.includes('\n')) && (
                <CodeView
                    className={OUTPUT_CLASS_NAME}
                    code={command}
                    label={t('agentChat.workGroup.command')}
                    language="shell"
                />
            )}
            <OutputView
                isRunning={isRunning}
                language={agentChatOutputLanguage(item)}
                text={item.output}
            />
            {item.exitCode !== undefined && (
                <p className={cn('m-0', item.exitCode === 0 ? 'text-muted' : 'text-danger')}>
                    {t('agentChat.workGroup.exitCode', { code: item.exitCode })}
                </p>
            )}
            {item.background && (
                <p className="m-0 text-muted">{t('agentChat.workGroup.movedToBackground')}</p>
            )}
        </>
    );
}

/**
 * A tool call's arguments, unless the row title already names them in full, then its output.
 */
function ToolCallDetail({
    isRunning,
    item,
}: {
    isRunning: boolean;
    item: Extract<AgentChatWorkItem, { type: 'toolCall' }>;
}) {
    const language = agentChatOutputLanguage(item);
    const output = item.output ?? '';
    const argumentsText = agentChatToolCallArguments(item);
    const { kind, subject } = describeAgentChatWorkRow(item);
    return (
        <>
            {/* Arguments the row title already names in full (a `wait` call's Agent) would only repeat it. */}
            {argumentsText && argumentsText !== subject && (
                <AgentChatToolArguments text={argumentsText} />
            )}
            <OutputView
                isRunning={isRunning}
                isWrapped={kind === 'mcp'}
                language={language}
                text={kind === 'read' ? stripLineNumberGutter(output) : output}
            />
        </>
    );
}

/**
 * What an expanded work row shows: the reasoning text, the full command and its output, a tool's arguments and output
 * painted in the output's language, or the diff.
 */
export function AgentChatWorkDetail({
    item,
    onOpenFile,
}: {
    item: AgentChatWorkItem;
    onOpenFile?: (target: string) => void;
}) {
    const isRunning = isAgentChatWorkRunning(item);
    switch (item.type) {
        case 'reasoning': {
            // Codex titles each summary part in bold; at full contrast those titles outshone the muted 12px row they
            // sit under, so they keep the thought's color and size and stand out by weight alone, as the Codex TUI dims
            // its whole reasoning cell.
            return (
                <AgentChatMessage
                    className="gap-2 text-[12px] text-muted select-text [&_strong]:text-inherit"
                    isStreaming={item.streaming}
                    text={agentChatReasoningTitle(item.text).body}
                    onOpenFile={onOpenFile}
                />
            );
        }
        case 'command': {
            return <CommandDetail isRunning={isRunning} item={item} />;
        }
        case 'toolCall': {
            return <ToolCallDetail isRunning={isRunning} item={item} />;
        }
        case 'fileChange': {
            // Diff text is selectable; the diff's own line-number and marker gutters stay `select-none`.
            return (
                <div className="select-text">
                    <AgentChatFileChanges
                        changes={item.changes}
                        expandAtMost={TIMELINE_EXPANDED_FILE_LIMIT}
                        status={item.status}
                    />
                </div>
            );
        }
    }
}
