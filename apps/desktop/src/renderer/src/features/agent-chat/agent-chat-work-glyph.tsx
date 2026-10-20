import type { ComponentType } from 'react';
import { useState } from 'react';

import type { AgentToolKind } from '@caxri/protocol';
import {
    BookOpen,
    Bot,
    Brain,
    CircleStop,
    Command,
    FilePenLine,
    FilePlus,
    FolderOpen,
    Globe,
    Hourglass,
    Image,
    ListTodo,
    MessageCircleQuestionMark,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
} from 'lucide-react';

import { McpConnectorIcon } from '../../icons/mcp-connector-icon';
import { AgentChatMcpGlyph } from './agent-chat-mcp-glyph';
import { useAgentChatMcpServer } from './hooks/use-agent-chat-mcp-server';
import { ToolGlyph, useLoadingStyle } from './loading';

/**
 * One glyph per tool kind, following the Codex app's work glyphs: an open book for a read, and four connected nodes for
 * an MCP call whose server has no icon of its own (see `AgentChatMcpGlyph`). A new tool kind is added to the shared
 * table in `@caxri/protocol` and given its glyph here and in `loading/tool-glyph.tsx`.
 */
const WORK_ICONS: Record<AgentToolKind, ComponentType<{ className?: string }>> = {
    agent: Bot,
    manage: Bot,
    browser: Globe,
    command: SquareTerminal,
    computer: Command,
    edit: FilePenLine,
    image: Image,
    list: FolderOpen,
    mcp: McpConnectorIcon,
    other: Wrench,
    plan: ListTodo,
    question: MessageCircleQuestionMark,
    read: BookOpen,
    search: Search,
    skill: Sparkles,
    stop: CircleStop,
    thought: Brain,
    wait: Hourglass,
    web: Globe,
    write: FilePlus,
};

interface WorkGlyphProperties {
    kind: AgentToolKind;
    /**
     * The MCP tool the call named, so a settled MCP row shows its server's icon once the provider described the server.
     */
    mcpToolName?: string;
}

function StillWorkGlyph({ kind, mcpToolName }: WorkGlyphProperties) {
    const server = useAgentChatMcpServer(kind === 'mcp' ? mcpToolName : undefined);
    if (kind === 'mcp') return <AgentChatMcpGlyph server={server} />;
    const Icon = WORK_ICONS[kind];
    return <Icon aria-hidden="true" className="size-3.5" />;
}

/**
 * A row the user watched run: its live glyph while the tool runs, then the still icon with a one-shot settle (a small
 * stamp, or a shrug when the tool failed). The failure itself is the trailing status glyph's to say, so the shrug only
 * moves.
 */
function WatchedWorkGlyph({
    isFailed,
    isRunning,
    ...still
}: WorkGlyphProperties & { isFailed: boolean; isRunning: boolean }) {
    const { animatesToolIcons } = useLoadingStyle();
    if (!animatesToolIcons) return <StillWorkGlyph {...still} />;
    if (isRunning) {
        return (
            <span className="inline-flex text-foreground">
                <ToolGlyph kind={still.kind} size={16} />
            </span>
        );
    }
    return (
        <span
            className={
                isFailed
                    ? 'agent-chat-glyph-shrug inline-flex'
                    : 'agent-chat-glyph-stamp inline-flex'
            }
        >
            <StillWorkGlyph {...still} />
        </span>
    );
}

/**
 * A work row's glyph. Only a row that was running when it mounted animates, so a long settled history stays still icons
 * with no settings subscription, and reopening a finished turn does not replay every row's settle.
 */
export function AgentChatWorkGlyph({
    isFailed = false,
    isRunning,
    ...still
}: WorkGlyphProperties & { isFailed?: boolean; isRunning: boolean }) {
    // react-doctor-disable-next-line react-doctor/no-derived-useState -- deliberately latches the mount-time value; later `isRunning` changes must not swap the component.
    const [wasRunning] = useState(isRunning);
    return wasRunning ? (
        <WatchedWorkGlyph isFailed={isFailed} isRunning={isRunning} {...still} />
    ) : (
        <StillWorkGlyph {...still} />
    );
}
