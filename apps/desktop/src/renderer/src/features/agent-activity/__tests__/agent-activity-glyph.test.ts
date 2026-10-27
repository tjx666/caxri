import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentActivityGlyph } from '../agent-activity-glyph';
import type { AgentActivitySelectionAnchor } from '../agent-activity-rows';
import { agentActivityGroups } from '../agent-activity-rows';

const NOW = 1_000_000_000;

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        attentionGeneration: 0,
        title: id,
        hasUnread: false,
        id,
        agentActivityState: 'idle',
        sessionActivityAt: NOW,
        projectId: 'alpha',
        acknowledgedAttentionGeneration: 0,
        sidebarOrder: 0,
        ...overrides,
    } as SessionRecord;
}

/**
 * Glyphs are read off real rows rather than hand-built ones: which state a row shows depends on the group it landed in,
 * and `agentActivityGroups` is what decides that.
 */
function glyphOf(
    record: SessionRecord,
    terminals: readonly TerminalRecord[] = [],
    selectionAnchor?: AgentActivitySelectionAnchor,
) {
    const groups = agentActivityGroups({
        now: NOW,
        projects: [{ title: 'alpha', id: 'alpha' } as ProjectRecord],
        selectionAnchor,
        sessions: [record],
        terminals,
    });
    expect(groups).toHaveLength(1);
    const row = groups[0].rows[0];
    return { ...agentActivityGlyph(row), groupId: row.groupId };
}

describe('agentActivityGlyph', () => {
    it('gives each state its own shape', () => {
        expect(glyphOf(session('waiting-one', { agentActivityState: 'waiting' })).id).toBe(
            'question',
        );
        expect(glyphOf(session('failed-one', { agentActivityState: 'failed' })).id).toBe('x');
        expect(glyphOf(session('running-one', { agentActivityState: 'running' })).id).toBe(
            'spinner',
        );
        expect(glyphOf(session('idle-one')).id).toBe('hollow');
        expect(glyphOf(session('finished-one', { agentActivityState: 'completed' })).id).toBe(
            'check',
        );
    });

    it('tints only the rows that ask the user for something', () => {
        // A read `waiting` row has already been seen, so it is quiet chrome despite its urgent-sounding state.
        expect(glyphOf(session('waiting-one', { agentActivityState: 'waiting' }))).toMatchObject({
            groupId: 'waiting',
            label: 'Waiting for you',
            toneClassName: 'text-muted',
        });
        expect(glyphOf(session('failed-one', { agentActivityState: 'failed' }))).toMatchObject({
            groupId: 'failed',
            toneClassName: 'text-danger',
        });
        expect(glyphOf(session('idle-one')).toneClassName).toBe('text-muted');
    });

    it('marks a live turn as progress rather than a loading placeholder', () => {
        expect(glyphOf(session('running-one', { agentActivityState: 'running' }))).toMatchObject({
            groupId: 'working',
            id: 'spinner',
            toneClassName: 'text-success',
        });
    });

    it('draws a turn waiting on background work as the quiet running glyph', () => {
        const terminal = {
            agentOperation: 'background',
            id: 'terminal-background-one',
            kind: 'claude',
            lastProcessState: 'running',
            sessionId: 'background-one',
        } as TerminalRecord;
        expect(
            glyphOf(session('background-one', { agentActivityState: 'running' }), [terminal]),
        ).toMatchObject({
            groupId: 'working',
            id: 'background',
            label: 'In background',
            toneClassName: 'text-muted',
        });
    });

    it('reads an unread row by why it is unread, not by what its Agent is doing now', () => {
        /*
         * The commonest attention row of all: a turn that finished. Its own `statusPresentation` tone is `neutral`,
         * which would leave it as grey as an Idle row under the "Needs attention" heading.
         */
        expect(
            glyphOf(
                session('unread-finished', {
                    hasUnread: true,
                    agentActivityState: 'completed',
                    lastAttentionKind: 'completed',
                }),
            ),
        ).toMatchObject({ groupId: 'attention', id: 'check', toneClassName: 'text-warning' });
        // Still running, so the live state would say "Working" in success green under "Needs attention".
        expect(
            glyphOf(
                session('unread-running', {
                    hasUnread: true,
                    agentActivityState: 'running',
                    lastAttentionKind: 'waiting',
                }),
            ),
        ).toMatchObject({ groupId: 'attention', id: 'question', toneClassName: 'text-warning' });
        expect(
            glyphOf(
                session('unread-failed', {
                    hasUnread: true,
                    agentActivityState: 'failed',
                    lastAttentionKind: 'failed',
                }),
            ),
        ).toMatchObject({ groupId: 'attention', id: 'x', toneClassName: 'text-danger' });
    });

    it('renders an anchored viewed row with its actual state and neutral tone', () => {
        const viewed = session('viewed', {
            attentionGeneration: 1,
            hasUnread: false,
            agentActivityState: 'completed',
            lastAttentionKind: 'waiting',
        });
        expect(
            glyphOf(viewed, [], {
                agentOperation: undefined,
                attentionGeneration: 1,
                agentActivityState: 'completed',
                sessionActivityAt: NOW,
                sessionId: 'viewed',
            }),
        ).toMatchObject({ groupId: 'attention', id: 'check', toneClassName: 'text-muted' });
    });

    it('labels a detached Agent as handed over rather than by its frozen state', () => {
        /*
         * Detaching stops the Terminal without rewriting `agentActivityState`, so this Session still claims to be
         * waiting on the user. It is not: it was handed to another client on purpose.
         */
        const detached = session('detached-one', { agentActivityState: 'waiting' });
        const terminal = {
            id: 'terminal-detached-one',
            lastProcessState: 'detached',
            sessionId: 'detached-one',
        } as TerminalRecord;
        expect(glyphOf(detached, [terminal])).toMatchObject({
            id: 'unplug',
            label: 'Detached',
            toneClassName: 'text-muted',
        });
    });
});
