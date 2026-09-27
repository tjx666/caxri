import type { AgentTimelineItem } from '@caxri/protocol';
import { AGENT_REPLY_SUMMARY_MAX_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { summarizeLatestAgentReply } from '../reply-summary';

const user = (text: string): AgentTimelineItem => ({ id: `u-${text}`, type: 'userMessage', text });
const agent = (text: string): AgentTimelineItem => ({
    id: `a-${text}`,
    type: 'agentMessage',
    text,
});
const tool: AgentTimelineItem = {
    id: 'tool',
    type: 'toolCall',
    name: 'Bash',
    summary: 'bun test',
    status: 'succeeded',
};

describe('summarizeLatestAgentReply', () => {
    it('returns the closing Agent message of the latest turn as one plain line', () => {
        expect(
            summarizeLatestAgentReply([
                user('hello'),
                agent('first'),
                tool,
                agent(
                    '## Done\n\n- Fixed **the bug** in `app.ts`\n- See [PR](https://example.com)',
                ),
            ]),
        ).toBe('Done Fixed the bug in app.ts See PR');
    });

    it('drops fenced code and truncates long replies on a character boundary', () => {
        const summary = summarizeLatestAgentReply([
            user('go'),
            agent(`Result:\n\`\`\`ts\nconst a = 1;\n\`\`\`\n${'好'.repeat(400)}`),
        ]);
        expect(summary).toMatch(/^Result: 好+…$/u);
        expect([...summary!]).toHaveLength(AGENT_REPLY_SUMMARY_MAX_LENGTH);
    });

    it('never falls back to a previous turn when the latest turn has no text reply', () => {
        expect(
            summarizeLatestAgentReply([agent('old answer'), user('next'), tool]),
        ).toBeUndefined();
        expect(summarizeLatestAgentReply([])).toBeUndefined();
    });
});
