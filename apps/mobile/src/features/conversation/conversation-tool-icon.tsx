import type { ComponentType } from 'react';
import { ActivityIndicator, View } from 'react-native';

import type { LucideProps } from 'lucide-react-native';
import {
    Bot,
    CircleStop,
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
import type { ToolKind } from './tool-presentation';

const TOOL_ICONS: Record<ToolKind, ComponentType<LucideProps>> = {
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
    web: Globe,
    write: FilePlus,
};

/**
 * A tile carrying the tool's kind. A running tool swaps the glyph for a spinner so progress sits where the eye lands
 * first; a failed one keeps its glyph in the danger color, so the kind stays recognizable.
 */
export const ConversationToolIcon = ({
    kind,
    status,
    theme,
}: {
    /**
     * `null` marks a group mixing several kinds.
     */
    kind: ToolKind | null;
    status: 'failed' | 'running' | 'succeeded';
    theme: MobileTheme;
}) => {
    const Icon = kind ? TOOL_ICONS[kind] : Layers;
    return (
        <View style={[styles.toolIcon, { backgroundColor: theme.elevated }]}>
            {status === 'running' ? (
                <ActivityIndicator color={theme.muted} size={12} />
            ) : (
                <Icon
                    color={status === 'failed' ? theme.danger : theme.muted}
                    size={14}
                    strokeWidth={2}
                />
            )}
        </View>
    );
};
