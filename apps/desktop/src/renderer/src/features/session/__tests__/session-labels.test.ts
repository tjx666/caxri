import { DEFAULT_SESSION_TITLE } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { SessionLabelInput } from '../session-labels';
import { sessionLabels, sessionLabelTitle } from '../session-labels';

function input(id: string, overrides: Partial<SessionLabelInput> = {}): SessionLabelInput {
    return {
        agentLabel: 'Claude Code',
        createdAt: Number(id.replaceAll(/\D/g, '')) || 0,
        title: DEFAULT_SESSION_TITLE,
        id,
        projectId: 'p1',
        projectTitle: 'Alpha',
        ...overrides,
    };
}

const UNTITLED = 'Untitled';

describe('sessionLabelTitle', () => {
    it('prefers the stored title, then a prompt snippet, then Project and worktree, then the placeholder', () => {
        expect(sessionLabelTitle(input('s1', { title: 'Fix login' }), UNTITLED)).toBe('Fix login');
        expect(
            sessionLabelTitle(
                input('s1', { promptSnippet: 'refactor   the very long session store module' }),
                UNTITLED,
            ),
        ).toBe('refactor the very long…');
        expect(sessionLabelTitle(input('s1', { workingLocation: 'wt-a' }), UNTITLED)).toBe(
            'Alpha · wt-a',
        );
        expect(sessionLabelTitle(input('s1'), UNTITLED)).toBe(UNTITLED);
    });
});

describe('sessionLabels', () => {
    it('adds no suffix when every title is unique', () => {
        const labels = sessionLabels(
            [input('s1', { title: 'A' }), input('s2', { title: 'B' })],
            UNTITLED,
        );
        expect(labels.get('s1')).toEqual({ title: 'A' });
        expect(labels.get('s2')).toEqual({ title: 'B' });
    });

    it('uses the Project name when colliding Sessions belong to different Projects', () => {
        const labels = sessionLabels(
            [input('s1'), input('s2', { projectId: 'p2', projectTitle: 'Beta' })],
            UNTITLED,
        );
        expect(labels.get('s1')?.suffix).toBe('Alpha');
        expect(labels.get('s2')?.suffix).toBe('Beta');
    });

    it('uses the Agent kind and worktree inside one Project when they differ', () => {
        const labels = sessionLabels(
            [
                input('s1', { title: 'Fix' }),
                input('s2', { agentLabel: 'Codex', title: 'Fix' }),
                input('s3', { title: 'Fix', workingLocation: 'wt-a' }),
            ],
            UNTITLED,
        );
        expect(labels.get('s1')?.suffix).toBe('Claude Code');
        expect(labels.get('s2')?.suffix).toBe('Codex');
        expect(labels.get('s3')?.suffix).toBe('Claude Code · wt-a');
    });

    it('falls back to a creation-order ordinal when nothing else differs', () => {
        const labels = sessionLabels([input('s3'), input('s1'), input('s2')], UNTITLED);
        expect(labels.get('s1')?.suffix).toBe('#1');
        expect(labels.get('s2')?.suffix).toBe('#2');
        expect(labels.get('s3')?.suffix).toBe('#3');
    });

    it('keeps ordinals when a sibling leaves the visible set', () => {
        const before = sessionLabels([input('s1'), input('s2'), input('s3')], UNTITLED);
        const after = sessionLabels(
            [input('s1', { visible: false }), input('s2'), input('s3')],
            UNTITLED,
        );
        expect(before.get('s3')?.suffix).toBe('#3');
        expect(after.get('s2')?.suffix).toBe('#2');
        expect(after.get('s3')?.suffix).toBe('#3');
        expect(after.get('s1')?.suffix).toBeUndefined();
    });

    it('drops the suffix once only one visible Session carries the title', () => {
        const labels = sessionLabels(
            [input('s1', { visible: false }), input('s2'), input('s3', { title: 'X' })],
            UNTITLED,
        );
        expect(labels.get('s2')).toEqual({ title: UNTITLED });
    });

    it('is independent of input order', () => {
        const items = [
            input('s1'),
            input('s2'),
            input('s3', { projectId: 'p2', projectTitle: 'Beta' }),
        ];
        const forward = sessionLabels(items, UNTITLED);
        const reverse = sessionLabels(items.toReversed(), UNTITLED);
        for (const { id } of items) expect(reverse.get(id)).toEqual(forward.get(id));
    });

    it('matches titles case-insensitively', () => {
        const labels = sessionLabels(
            [input('s1', { title: 'Fix' }), input('s2', { title: 'fix' })],
            UNTITLED,
        );
        expect(labels.get('s1')?.suffix).toBe('#1');
    });
});
