import type { CommandExecutionContext } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { assertOwnerOnlyMethod } from '../principal-project-scope';

const contextFor = (kind: string): CommandExecutionContext =>
    ({ principal: { kind, projectIds: [] } }) as unknown as CommandExecutionContext;

describe('assertOwnerOnlyMethod', () => {
    it('refuses spec-declared owner-only methods for Agent principals', () => {
        for (const method of [
            'bot.session.handOver',
            'bot.session.takeBack',
            'bot.conversations',
            'bot.managedSessions',
            'session.permissionAutoAllowStatus',
        ])
            expect(() => assertOwnerOnlyMethod(contextFor('agent'), method)).toThrow(/owner/);
    });

    it('allows the owner clients and unrestricted methods', () => {
        expect(() =>
            assertOwnerOnlyMethod(contextFor('desktop'), 'bot.session.handOver'),
        ).not.toThrow();
        expect(() =>
            assertOwnerOnlyMethod(contextFor('human-cli'), 'bot.conversations'),
        ).not.toThrow();
        expect(() => assertOwnerOnlyMethod(contextFor('agent'), 'agent.list')).not.toThrow();
    });
});
