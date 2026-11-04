import { describe, expect, it } from 'vitest';

import type { CoverageRequest, ParentEvidence } from '../coverage';
import { approvalCoverage } from '../coverage';

const hop = (fields: Partial<ParentEvidence> = {}): ParentEvidence => ({
    surface: 'chat',
    provider: 'codex',
    launchProven: true,
    taskState: 'intact',
    mode: 'fullAccess',
    ...fields,
});

const request = (fields: Partial<CoverageRequest> = {}): CoverageRequest => ({
    kind: 'command',
    hasNetworkHost: false,
    isExitPlan: false,
    takenOver: false,
    turnProven: true,
    acceptOffered: true,
    commandText: 'present',
    pathVerdict: 'inside',
    ...fields,
});

const judge = (
    fields: {
        enabled?: boolean;
        chain?: ParentEvidence[];
        lineageProven?: boolean;
        request?: Partial<CoverageRequest>;
    } = {},
) =>
    approvalCoverage({
        enabled: fields.enabled ?? true,
        chain: fields.chain ?? [hop()],
        lineageProven: fields.lineageProven ?? true,
        request: request(fields.request),
    });

describe('approvalCoverage', () => {
    it('covers a command under full access and a file change under accept edits', () => {
        expect(judge()).toEqual({ covered: true });
        expect(
            judge({
                chain: [hop({ mode: 'acceptEdits' })],
                request: { kind: 'fileChange', pathVerdict: 'inside' },
            }),
        ).toEqual({ covered: true });
    });

    it('provisionally covers a file change whose path check is still pending', () => {
        expect(judge({ request: { kind: 'fileChange', pathVerdict: 'pending' } })).toEqual({
            covered: true,
        });
    });

    it.each([
        ['the setting off', { enabled: false }, 'disabled'],
        ['a taken-over child', { request: { takenOver: true } }, 'taken_over'],
        ['an unproven turn', { request: { turnProven: false } }, 'turn_unproven'],
        ['unproven lineage', { lineageProven: false }, 'lineage_unproven'],
        ['an empty chain', { chain: [] }, 'lineage_unproven'],
        ['no accept offered', { request: { acceptOffered: false } }, 'accept_not_offered'],
        ['a tool', { request: { kind: 'tool' as const } }, 'kind_unsupported'],
        ['a question', { request: { kind: 'question' as const } }, 'kind_unsupported'],
        ['an exit-plan request', { request: { isExitPlan: true } }, 'kind_unsupported'],
        ['a network host', { request: { hasNetworkHost: true } }, 'network'],
        ['no command text', { request: { commandText: 'absent' as const } }, 'command_unproven'],
        [
            'clipped command text',
            { request: { commandText: 'unproven' as const } },
            'command_unproven',
        ],
        ['a Terminal parent', { chain: [hop({ surface: 'terminal' })] }, 'parent_not_chat'],
        ['a Grok parent', { chain: [hop({ provider: 'grok' })] }, 'parent_provider'],
        ['an unproven launch', { chain: [hop({ launchProven: false })] }, 'parent_launch_unknown'],
        ['an inactive hop', { chain: [hop({ taskState: 'inactive' })] }, 'lineage_unproven'],
        ['an unapplied mode', { chain: [hop({ modeUnapplied: true })] }, 'parent_mode_unapplied'],
        ['plan mode', { chain: [hop({ planMode: true })] }, 'parent_plan_mode'],
        ['an unresolved mode', { chain: [hop({ mode: undefined })] }, 'parent_mode_unresolved'],
        [
            'a command under accept edits',
            { chain: [hop({ mode: 'acceptEdits' })] },
            'parent_mode_insufficient',
        ],
        [
            'a command under ask permission',
            { chain: [hop({ mode: 'ask' })] },
            'parent_mode_insufficient',
        ],
        [
            'a file change without paths',
            { request: { kind: 'fileChange' as const, pathVerdict: 'absent' as const } },
            'path_missing',
        ],
        [
            'a file change outside the root',
            { request: { kind: 'fileChange' as const, pathVerdict: 'outside' as const } },
            'path_outside',
        ],
        [
            'a file change whose paths are unproven',
            { request: { kind: 'fileChange' as const, pathVerdict: 'unproven' as const } },
            'path_unproven',
        ],
    ])('refuses %s', (_name, fields, reason) => {
        expect(judge(fields)).toEqual({ covered: false, reason });
    });

    it('judges every hop of the chain and names an ancestor', () => {
        expect(judge({ chain: [hop(), hop({ surface: 'terminal' })] })).toEqual({
            covered: false,
            reason: 'ancestor_not_covering',
        });
        expect(judge({ chain: [hop(), hop({ taskState: 'taken_over' })] })).toEqual({
            covered: false,
            reason: 'ancestor_taken_over',
        });
        expect(judge({ chain: [hop(), hop({ mode: 'acceptEdits' })] })).toEqual({
            covered: false,
            reason: 'ancestor_not_covering',
        });
    });

    it('intersects the permission of the chain: the narrowest hop decides', () => {
        const edits = { request: { kind: 'fileChange' as const } };
        expect(judge({ chain: [hop(), hop({ mode: 'acceptEdits' })], ...edits })).toEqual({
            covered: true,
        });
        expect(judge({ chain: [hop({ mode: 'acceptEdits' }), hop()], ...edits })).toEqual({
            covered: true,
        });
    });

    it('reports the first reason in a fixed order', () => {
        expect(
            judge({
                enabled: false,
                lineageProven: false,
                request: { takenOver: true, acceptOffered: false },
            }),
        ).toEqual({ covered: false, reason: 'disabled' });
        expect(
            judge({ lineageProven: false, request: { takenOver: true, turnProven: false } }),
        ).toEqual({ covered: false, reason: 'taken_over' });
    });
});
