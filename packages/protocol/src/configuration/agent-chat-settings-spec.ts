import type { SettingSpec } from './settings-spec.js';

/**
 * Agent Chat's settings, kept beside the main catalog so `settingsSpec` stays within the source-size ratchet.
 * `settingsSpec` spreads them in place, so their order on the Settings page is unchanged. Idle compaction is listed
 * under Agents, beside the other settings that decide what Caxri does with an idle Agent.
 */
export const agentChatSettingsSpec = [
    {
        kind: 'integer',
        key: 'agentChat.longPasteThreshold',
        title: 'Chat long paste threshold',
        description:
            'Longer text pasted into a Chat is saved to a local file and the message cites it, so a log or a dump does not bury the message. Raise it to paste such text as is; text that would not fit in one message is still saved to a file.',
        category: 'chat',
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
        category: 'chat',
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
        category: 'chat',
        keywords: ['chat', 'tool', 'icon', 'glyph', 'animation', 'loading', 'motion'],
        default: true,
    },
    {
        kind: 'enum',
        key: 'agentChat.statusShimmer',
        title: 'Chat status shimmer',
        description:
            'How a light sweeps across running status text in a Chat, such as the working phrase and a running tool title.',
        category: 'chat',
        keywords: ['chat', 'shimmer', 'loading', 'animation', 'status', 'motion'],
        options: [
            { value: 'dwell', label: 'Sweep, then rest' },
            { value: 'continuous', label: 'Continuous sweep' },
            { value: 'off', label: 'Off' },
        ],
        default: 'dwell',
    },
    {
        kind: 'boolean',
        key: 'agentChat.idleCompaction.enabled',
        title: 'Summarize idle Chats to keep replies fast',
        description:
            'When a long Claude or Grok Build Chat sits idle for a while, Caxri summarizes it in the background, so your next message is sent with the short summary instead of the whole conversation, which makes the reply faster and cheaper.',
        category: 'agents',
        keywords: [
            'agent',
            'chat',
            'compact',
            'compaction',
            'idle',
            'cache',
            'prompt cache',
            'cost',
        ],
        default: true,
    },
    /**
     * Named after Claude Code's own `autoContinueAtUsageLimit`, which its docs leave to the interactive CLI: a Chat
     * driven through the Agent SDK does not get it, so Server Core owns the wait for both providers.
     */
    {
        kind: 'boolean',
        key: 'agentChat.autoContinueAtUsageLimit',
        title: 'Continue automatically after a usage limit resets',
        description:
            'When a Claude or Codex Chat stops because your plan usage limit is used up, wait for the limit to reset (within 24 hours) and continue the task on its own. You can cancel the wait or continue right away from the Chat.',
        category: 'agents',
        keywords: [
            'agent',
            'chat',
            'usage',
            'limit',
            'rate limit',
            'reset',
            'continue',
            'resume',
            'quota',
        ],
        default: true,
    },
] as const satisfies readonly SettingSpec[];
