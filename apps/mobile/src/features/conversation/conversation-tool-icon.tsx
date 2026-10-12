import type { ComponentType } from 'react';
import { View } from 'react-native';

import type { AgentChatItemStatus, AgentToolKind } from '@caxri/protocol';
import { agentChatItemStatusLabel, agentChatItemStatusTone } from '@caxri/protocol';
import type { LucideProps } from 'lucide-react-native';
import {
    Bot,
    Brain,
    Circle,
    CircleSlash,
    CircleStop,
    CircleX,
    FilePenLine,
    FilePlus,
    FileText,
    FolderOpen,
    Globe,
    Image,
    Layers,
    ListTodo,
    MessageCircleQuestionMark,
    Plug,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
} from 'lucide-react-native';

import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';

const TOOL_ICONS: Record<AgentToolKind, ComponentType<LucideProps>> = {
    agent: Bot,
    command: SquareTerminal,
    edit: FilePenLine,
    image: Image,
    list: FolderOpen,
    mcp: Plug,
    other: Wrench,
    plan: ListTodo,
    question: MessageCircleQuestionMark,
    read: FileText,
    search: Search,
    skill: Sparkles,
    stop: CircleStop,
    thought: Brain,
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
    theme,
}: {
    /**
     * `null` marks a group mixing several kinds.
     */
    kind: AgentToolKind | null;
    theme: MobileTheme;
}) => {
    const Icon = kind ? TOOL_ICONS[kind] : Layers;
    return (
        <View style={[styles.toolIcon, { backgroundColor: theme.elevated }]}>
            <Icon color={theme.muted} size={14} strokeWidth={2} />
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
    const Icon = STATUS_ICONS[status];
    if (!Icon) return null;
    const tone = agentChatItemStatusTone(status);
    return (
        <Icon
            accessibilityLabel={agentChatItemStatusLabel(status)}
            color={tone === 'danger' ? theme.danger : theme.warning}
            size={15}
        />
    );
};
