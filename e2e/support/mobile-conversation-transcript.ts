/**
 * Synthetic provider-shaped records only; no host Agent transcript is read by mobile Acceptance.
 */
export function conversationBaselineRecords(): unknown[] {
    return [
        {
            type: 'user',
            uuid: 'synthetic-user-1',
            timestamp: '2026-01-01T00:00:00.000Z',
            message: {
                id: 'synthetic-message-user-1',
                content: [{ type: 'text', text: 'Summarize this synthetic sample.' }],
            },
        },
        {
            type: 'assistant',
            uuid: 'synthetic-agent-1',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
                id: 'synthetic-message-agent-1',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'Synthetic private reasoning must stay hidden.',
                    },
                    {
                        type: 'text',
                        text: [
                            '## Synthetic result',
                            '',
                            '```ts',
                            `const sample = "synthetic-left-${'x'.repeat(160)}-synthetic-right";`,
                            '```',
                        ].join('\n'),
                    },
                ],
            },
        },
        {
            type: 'assistant',
            uuid: 'synthetic-tools-1',
            timestamp: '2026-01-01T00:00:02.000Z',
            message: {
                id: 'synthetic-message-tools-1',
                content: [
                    {
                        type: 'tool_use',
                        id: 'synthetic-tool-1',
                        name: 'Bash',
                        input: { command: 'printf ready' },
                    },
                    {
                        type: 'tool_use',
                        id: 'synthetic-tool-2',
                        name: 'Bash',
                        input: { command: 'printf done' },
                    },
                    {
                        type: 'tool_use',
                        id: 'synthetic-tool-3',
                        name: 'Read',
                        input: { file_path: 'src/synthetic.ts' },
                    },
                    {
                        type: 'tool_use',
                        id: 'synthetic-tool-4',
                        name: 'Grep',
                        input: { pattern: 'synthetic' },
                    },
                ],
            },
        },
        {
            type: 'user',
            uuid: 'synthetic-results-1',
            timestamp: '2026-01-01T00:00:03.000Z',
            message: {
                id: 'synthetic-message-results-1',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-tool-1',
                        content: 'ready',
                        is_error: false,
                    },
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-tool-2',
                        content: 'done',
                        is_error: false,
                    },
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-tool-3',
                        content: 'synthetic',
                        is_error: false,
                    },
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-tool-4',
                        content: 'synthetic',
                        is_error: false,
                    },
                ],
            },
        },
        {
            type: 'system',
            subtype: 'turn_duration',
            timestamp: '2026-01-01T00:00:04.000Z',
            durationMs: 4_000,
        },
    ];
}

export function conversationAgentRecords(start: number, count: number): unknown[] {
    return Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        return {
            type: 'assistant',
            uuid: `synthetic-agent-${index}`,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(),
            message: {
                id: `synthetic-message-agent-${index}`,
                content: [{ type: 'text', text: `Synthetic update ${index}.` }],
            },
        };
    });
}

/**
 * Agent replies whose rendered heights differ by an order of magnitude, like a real Conversation, so list positioning
 * cannot rely on uniform row estimates.
 */
export function conversationVariedAgentRecords(start: number, count: number): unknown[] {
    return Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        const paragraphs = Array.from(
            { length: 1 + (index % 5) },
            (__, paragraph) =>
                `Synthetic paragraph ${paragraph + 1} of update ${index} describes a bounded step in enough words to wrap across several lines on a phone.`,
        );
        const code =
            index % 3 === 0
                ? `\n\n\`\`\`ts\n${Array.from({ length: 6 }, (__, line) => `const value${line} = ${index + line};`).join('\n')}\n\`\`\``
                : '';
        return {
            type: 'assistant',
            uuid: `synthetic-varied-agent-${index}`,
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, 2, index)).toISOString(),
            message: {
                id: `synthetic-varied-message-agent-${index}`,
                content: [{ type: 'text', text: `${paragraphs.join('\n\n')}${code}` }],
            },
        };
    });
}

/**
 * One finished Bash call whose output is several sheet heights long, so the tool detail body must scroll. Eighty short
 * lines stay under the 2,048-character detail cap of the mobile timeline contract, so none of them is cut off.
 */
export function conversationLongToolRecords(): unknown[] {
    const output = Array.from(
        { length: 80 },
        (_, index) => `Synthetic output line ${String(index + 1).padStart(2, '0')}`,
    ).join('\n');
    return [
        {
            type: 'user',
            uuid: 'synthetic-long-tool-user',
            timestamp: '2026-01-01T00:00:00.000Z',
            message: {
                id: 'synthetic-long-tool-message-user',
                content: [{ type: 'text', text: 'Run the synthetic long command.' }],
            },
        },
        {
            type: 'assistant',
            uuid: 'synthetic-long-tool-call',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
                id: 'synthetic-long-tool-message-call',
                content: [
                    {
                        type: 'tool_use',
                        id: 'synthetic-long-tool',
                        name: 'Bash',
                        input: { command: 'seq 80' },
                    },
                ],
            },
        },
        {
            type: 'user',
            uuid: 'synthetic-long-tool-result',
            timestamp: '2026-01-01T00:00:02.000Z',
            message: {
                id: 'synthetic-long-tool-message-result',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'synthetic-long-tool',
                        content: output,
                        is_error: false,
                    },
                ],
            },
        },
        {
            type: 'assistant',
            uuid: 'synthetic-long-tool-reply',
            timestamp: '2026-01-01T00:00:03.000Z',
            message: {
                id: 'synthetic-long-tool-message-reply',
                content: [{ type: 'text', text: 'The synthetic command printed eighty lines.' }],
            },
        },
        {
            type: 'system',
            subtype: 'turn_duration',
            timestamp: '2026-01-01T00:00:04.000Z',
            durationMs: 4_000,
        },
    ];
}
