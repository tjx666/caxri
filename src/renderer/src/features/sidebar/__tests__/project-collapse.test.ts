import type { ProjectRecord, SessionRecord } from '@shared/types';
import { describe, expect, it } from 'vitest';

import {
    autoCollapseThresholdMs,
    parseProjectCollapseState,
    projectCollapseAfterPolicy,
} from '../project-collapse';

const project = (id: string, lastOpenedAt: number): ProjectRecord => ({
    id,
    rootPath: `/${id}`,
    displayTitle: id,
    orderIndex: 0,
    createdAt: lastOpenedAt,
    lastOpenedAt,
});

const session = (
    id: string,
    projectId: string,
    overrides: Partial<SessionRecord> = {},
): SessionRecord => ({
    id,
    projectId,
    workbenchProjectId: projectId,
    rootPath: `/${projectId}`,
    createdAt: 1,
    lastOpenedAt: 1,
    lastActivityState: 'idle',
    attentionEpoch: 0,
    readAttentionEpoch: 0,
    hasUnread: false,
    layoutVersion: 2,
    displayTitle: id,
    titleMode: 'automatic',
    ...overrides,
});

const policy = (overrides: Partial<Parameters<typeof projectCollapseAfterPolicy>[0]> = {}) =>
    projectCollapseAfterPolicy({
        autoCollapseThresholdMs: 100,
        collapsedProjects: {},
        manuallyExpandedProjectIds: new Set(),
        now: 1000,
        projects: [
            project('active', 0),
            project('running', 0),
            project('unread', 0),
            project('idle', 0),
        ],
        selectedSessionId: 'active-session',
        sessions: [
            session('active-session', 'active'),
            session('running-session', 'running', { lastActivityState: 'running' }),
            session('unread-session', 'unread', { hasUnread: true }),
            session('idle-session', 'idle'),
        ],
        shouldAutoCollapse: true,
        ...overrides,
    });

describe('Project collapse policy', () => {
    it('ships auto-collapse off and maps enabled thresholds', () => {
        expect(autoCollapseThresholdMs('off')).toBeUndefined();
        expect(autoCollapseThresholdMs('30m')).toBe(30 * 60 * 1000);
        expect(autoCollapseThresholdMs('2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('auto-collapses only stale unprotected Projects', () => {
        expect(policy()).toEqual({ idle: 'automatic' });
    });

    it('never auto-collapses a Project manually expanded in this Renderer lifetime', () => {
        expect(policy({ manuallyExpandedProjectIds: new Set(['idle']) })).toEqual({});
    });

    it('expands automatically collapsed Projects when they become protected but preserves manual collapse', () => {
        expect(
            policy({
                collapsedProjects: { active: 'automatic', running: 'manual' },
                shouldAutoCollapse: false,
            }),
        ).toEqual({ running: 'manual' });
    });

    it('does nothing automatic when the setting is off or the Sidebar is busy', () => {
        expect(policy({ autoCollapseThresholdMs: undefined })).toEqual({});
        expect(policy({ shouldAutoCollapse: false })).toEqual({});
    });

    it('restores only bounded, recognized persisted entries', () => {
        expect(
            parseProjectCollapseState(
                JSON.stringify({ alpha: 'manual', beta: 'automatic', gamma: 'unknown' }),
            ),
        ).toEqual({ alpha: 'manual', beta: 'automatic' });
        expect(parseProjectCollapseState('{ broken')).toEqual({});
    });
});
