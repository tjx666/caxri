import type { SettingSpec } from './settings-spec.js';

/**
 * Agent Chat's General settings, kept beside the main catalog so `settingsSpec` stays within the source-size ratchet.
 * `settingsSpec` spreads them in place, so their order on the Settings page is unchanged.
 */
export const agentChatSettingsSpec = [
    {
        kind: 'integer',
        key: 'agentChat.longPasteThreshold',
        title: 'Chat long paste threshold',
        description:
            'Longer text pasted into a Chat is saved to a local file and the message cites it, so a log or a dump does not bury the message. Raise it to paste such text as is; text that would not fit in one message is still saved to a file.',
        category: 'general',
        keywords: ['chat', 'clipboard', 'paste', 'verbatim', 'file', 'context', 'tokens'],
        min: 1,
        /**
         * The message length limit (`MAX_AGENT_CHAT_MESSAGE_LENGTH`): a paste the message cannot hold always takes the
         * saved-file path, so a larger threshold would change nothing. The values are inlined to avoid a protocol
         * configuration import cycle; `settings-spec.test.ts` keeps them equal to the Chat contract.
         */
        max: 100_000,
        default: 32_768,
        display: { unit: 'characters', step: 1024 },
    },
    {
        kind: 'enum',
        key: 'agentChat.workingIndicator',
        title: 'Chat working indicator',
        description:
            'What a Chat shows while the Agent works on a reply. Buddy also takes the status line spinner and acts out the work: reading, searching, running a command. Reduce Motion stills every choice.',
        category: 'general',
        keywords: ['chat', 'loading', 'spinner', 'animation', 'buddy', 'placeholder', 'motion'],
        options: [
            { value: 'buddy', label: 'Buddy' },
            { value: 'dots', label: 'Dots' },
            { value: 'caret', label: 'Caret' },
            { value: 'braille', label: 'Braille' },
            { value: 'orbit', label: 'Orbit' },
        ],
        default: 'buddy',
    },
    {
        kind: 'boolean',
        key: 'agentChat.animatedToolIcons',
        title: 'Animated Chat tool icons',
        description:
            'A running tool row in a Chat animates its icon to act out the work, such as a bookworm inching along a book while it reads. Turn off to keep the still icon.',
        category: 'general',
        keywords: ['chat', 'tool', 'icon', 'glyph', 'animation', 'loading', 'motion'],
        default: true,
    },
    {
        kind: 'enum',
        key: 'agentChat.statusShimmer',
        title: 'Chat status shimmer',
        description:
            'How a light sweeps across running status text in a Chat, such as the working phrase and a running tool title.',
        category: 'general',
        keywords: ['chat', 'shimmer', 'loading', 'animation', 'status', 'motion'],
        options: [
            { value: 'dwell', label: 'Sweep, then rest' },
            { value: 'continuous', label: 'Continuous sweep' },
            { value: 'off', label: 'Off' },
        ],
        default: 'dwell',
    },
] as const satisfies readonly SettingSpec[];
