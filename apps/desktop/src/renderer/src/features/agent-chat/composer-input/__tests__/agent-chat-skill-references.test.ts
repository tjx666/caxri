import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatSkillIndex, agentChatSkillMatch } from '../agent-chat-skill-references';

function action(invocation: string, kind: AgentAction['kind']): AgentAction {
    return { invocation, kind, requiresArguments: false, source: 'project' };
}

describe('Agent Chat skill references', () => {
    const index = agentChatSkillIndex([
        action('$commit', 'skill'),
        action('$deep-review', 'skill'),
        action('/compact', 'command'),
    ]);

    it('matches a skill name written bare or with either sigil', () => {
        expect(agentChatSkillMatch(index, 'commit')).toBe('$commit');
        expect(agentChatSkillMatch(index, '$commit')).toBe('$commit');
        expect(agentChatSkillMatch(index, '/deep-review')).toBe('$deep-review');
    });

    it('leaves commands, unknown names, and longer code unmatched', () => {
        expect(agentChatSkillMatch(index, 'compact')).toBeUndefined();
        expect(agentChatSkillMatch(index, '/compact')).toBeUndefined();
        expect(agentChatSkillMatch(index, 'commit --amend')).toBeUndefined();
        expect(agentChatSkillMatch(index, '$$commit')).toBeUndefined();
        expect(agentChatSkillMatch(index, 'Commit')).toBeUndefined();
    });

    it('matches a skill hidden from user invocation, which the Agent still names', () => {
        const withHidden = agentChatSkillIndex([action('$commit', 'skill')], ['$testing']);

        expect(agentChatSkillMatch(withHidden, 'testing')).toBe('$testing');
        expect(agentChatSkillMatch(withHidden, 'commit')).toBe('$commit');
    });

    it('builds an empty index before discovery answers', () => {
        expect(agentChatSkillIndex(undefined).size).toBe(0);
    });
});
