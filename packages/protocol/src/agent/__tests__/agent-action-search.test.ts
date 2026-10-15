import { describe, expect, it } from 'vitest';

import type { AgentAction } from '../agent-action-contract.js';
import { searchAgentActions } from '../agent-action-search.js';

const action = (invocation: string, description?: string): AgentAction => ({
    invocation,
    kind: invocation.startsWith('$') ? 'skill' : 'command',
    description,
    requiresArguments: false,
    source: 'project',
});

describe('searchAgentActions', () => {
    const actions = [
        action('$fix-ci', 'Make a Cloud or OSS PR mergeable'),
        action('$handoff', 'Compact the current conversation for another agent'),
        action('$harness-improvement', 'Improve the harness'),
        action('$pull-request', 'Publish the current branch'),
        action('$project-architecture', 'Navigate architecture boundaries'),
        action('/status', 'Show session configuration'),
    ];

    it('ranks every name match before a description-only match', () => {
        expect(searchAgentActions(actions, 'pr').map(({ invocation }) => invocation)).toEqual([
            '$project-architecture',
            '$pull-request',
            '$harness-improvement',
            '$fix-ci',
        ]);
    });

    it('keeps description-only matches discoverable without sparse unrelated matches', () => {
        expect(searchAgentActions(actions, 'mergeable')).toEqual([actions[0]]);
        expect(searchAgentActions(actions, 'zzzz')).toEqual([]);
        expect(searchAgentActions(actions, 'catalog')).toEqual([]);
        expect(searchAgentActions([action('$alpha', 'Only zebra')], 'z')).toEqual([
            action('$alpha', 'Only zebra'),
        ]);
    });

    it('matches invocations with or without their provider prefix', () => {
        expect(searchAgentActions(actions, 'sta')[0]).toBe(actions[5]);
        expect(searchAgentActions(actions, '/sta')).toEqual([actions[5]]);
        expect(searchAgentActions(actions, '$pr').map(({ invocation }) => invocation)).toEqual([
            '$project-architecture',
            '$pull-request',
            '$harness-improvement',
            '$fix-ci',
        ]);
    });

    it('matches case-insensitively and supports multi-word descriptions', () => {
        expect(searchAgentActions(actions, 'CLOUD OSS')).toEqual([actions[0]]);
    });

    it('preserves the catalog order for an empty query and stable ties', () => {
        expect(searchAgentActions(actions, '  ')).toBe(actions);
        expect(
            searchAgentActions(
                [action('$alpha-tool', 'shared phrase'), action('$beta-tool', 'shared phrase')],
                'shared phrase',
            ).map(({ invocation }) => invocation),
        ).toEqual(['$alpha-tool', '$beta-tool']);
    });

    it('handles actions without descriptions', () => {
        expect(searchAgentActions([action('$pull-request')], 'pr')).toEqual([
            action('$pull-request'),
        ]);
    });
});
