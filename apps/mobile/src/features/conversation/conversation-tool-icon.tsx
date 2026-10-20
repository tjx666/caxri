import type { ComponentType } from 'react';
import { View } from 'react-native';

import type { AgentChatItemStatus, AgentToolKind } from '@caxri/protocol';
import { agentChatItemStatusLabel, agentChatItemStatusTone } from '@caxri/protocol';
import type { LucideProps } from 'lucide-react-native';
import {
    BookOpen,
    Bot,
    Brain,
    Circle,
    CircleSlash,
    CircleStop,
    CircleX,
    Command,
    FilePenLine,
    FilePlus,
    FolderOpen,
    Globe,
    Hourglass,
    Image,
    Layers,
    ListTodo,
    MessageCircleQuestionMark,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
} from 'lucide-react-native';

import { McpConnectorIcon } from '../../components/mcp-connector-icon';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationMcpServerIcon } from './conversation-mcp-server-icon';
import { conversationStyles as styles } from './conversation-styles';

const TOOL_ICONS: Record<AgentToolKind, ComponentType<LucideProps>> = {
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

/**
 * A tile carrying the tool's kind, matching Desktop's work glyphs. Running work keeps its glyph and sweeps a highlight
 * across its title instead, so a column of rows does not flicker as each one starts and ends; how a settled tool ended
 * is the trailing {@link ConversationStatusGlyph}'s job.
 */
export const ConversationToolIcon = ({
    kind,
    mcpIconUrls,
    theme,
}: {
    /**
     * `null` marks a group mixing several kinds.
     */
    kind: AgentToolKind | null;
    /**
     * The icon URLs of the MCP server a `mcp` row belongs to (`agentChatMcpIconUrls`); the connector glyph stands in
     * while they load or when none is given.
     */
    mcpIconUrls?: readonly string[];
    theme: MobileTheme;
}) => {
    const Icon = kind ? TOOL_ICONS[kind] : Layers;
    return (
        <View style={[styles.toolIcon, { backgroundColor: theme.elevated }]}>
            {kind === 'mcp' && mcpIconUrls && mcpIconUrls.length > 0 ? (
                <ConversationMcpServerIcon theme={theme} urls={mcpIconUrls} />
            ) : (
                <Icon color={theme.muted} size={14} strokeWidth={2} />
            )}
        </View>
    );
};

const STATUS_ICONS: Partial<Record<AgentChatItemStatus, ComponentType<LucideProps>>> = {
    declined: CircleSlash,
    failed: CircleX,
    interrupted: Circle,
};

/**
 * How a tool that did not complete ended, with Desktop's glyph, tone, and accessible name: failed (`danger`), declined,
 * or interrupted (`warning`). Running and completed work draw nothing here.
 */
export const ConversationStatusGlyph = ({
    status,
    theme,
}: {
    status: AgentChatItemStatus;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const Icon = STATUS_ICONS[status];
    if (!Icon) return null;
    const tone = agentChatItemStatusTone(status);
    return (
        <Icon
            accessibilityLabel={agentChatItemStatusLabel(status, t)}
            color={tone === 'danger' ? theme.danger : theme.warning}
            size={15}
        />
    );
};
