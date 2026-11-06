import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    autoCollapseThresholdMs,
    isProjectCollapsed,
    parseProjectCollapseState,
    projectCollapseAfterAutoPass,
    projectCollapseAfterReveal,
    projectCollapseAfterToggle,
    reconcileProjectCollapse,
} from '../project-collapse';

const project = (id: string, lastVisitedAt: number): ProjectRecord => ({
    id,
    rootPath: `/${id}`,
    title: id,
    orderIndex: 0,
    createdAt: lastVisitedAt,
    lastVisitedAt,
});

const session = (
    id: string,
    projectId: string,
    overrides: Partial<SessionRecord> = {},
): SessionRecord => ({
    id,
    projectId,
    workbenchRootProjectId: projectId,
    rootPath: `/${projectId}`,
    createdAt: 1,
    lastVisitedAt: 1,
    sidebarOrder: 0,
    sessionActivityAt: 1,
    sessionActivityReason: 'created',
    agentActivityState: 'idle',
    attentionGeneration: 0,
    acknowledgedAttentionGeneration: 0,
    resolvedAttentionGeneration: 0,
    hasPendingAttention: false,
    hasUnread: false,
    title: id,
    titleMode: 'automatic',
    ...overrides,
});

const policyInput = (overrides: Partial<Parameters<typeof projectCollapseAfterAutoPass>[0]> = {}) =>
    ({
        autoCollapseThresholdMs: 100,
        collapsedProjects: {},
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
            session('running-session', 'running', { agentActivityState: 'running' }),
            session('unread-session', 'unread', { hasUnread: true }),
            session('idle-session', 'idle'),
        ],
        ...overrides,
    }) satisfies Parameters<typeof projectCollapseAfterAutoPass>[0];

const policy = (overrides: Partial<Parameters<typeof projectCollapseAfterAutoPass>[0]> = {}) =>
    projectCollapseAfterAutoPass(policyInput(overrides));

const reconcile = (overrides: Partial<Parameters<typeof projectCollapseAfterAutoPass>[0]> = {}) =>
    reconcileProjectCollapse(policyInput(overrides));

describe('Project collapse policy', () => {
    it('ships auto-collapse off and maps enabled thresholds', () => {
        expect(autoCollapseThresholdMs('off')).toBeUndefined();
        expect(autoCollapseThresholdMs('30m')).toBe(30 * 60 * 1000);
        expect(autoCollapseThresholdMs('2h')).toBe(2 * 60 * 60 * 1000);
    });

    it('auto-collapses only stale unprotected Projects', () => {
        expect(policy()).toEqual({ idle: 'automatic' });
    });

    it('never auto-collapses a Project the user expanded by hand', () => {
        expect(policy({ collapsedProjects: { idle: 'user-expanded' } })).toEqual({
            idle: 'user-expanded',
        });
    });

    it('expands automatically collapsed Projects when they become protected but preserves a manual collapse', () => {
        expect(
            reconcile({ collapsedProjects: { active: 'automatic', running: 'user-collapsed' } }),
        ).toEqual({ running: 'user-collapsed' });
    });

    it('preserves persisted disclosure until the Project catalog has loaded', () => {
        expect(
            reconcile({ collapsedProjects: { persisted: 'user-collapsed' }, projects: undefined }),
        ).toEqual({ persisted: 'user-collapsed' });
    });

    it('drops disclosure for Projects that no longer exist', () => {
        expect(
            reconcile({ collapsedProjects: { gone: 'user-expanded', idle: 'user-collapsed' } }),
        ).toEqual({ idle: 'user-collapsed' });
    });

    it('does nothing automatic when the setting is off, and never on a plain reconciliation', () => {
        expect(policy({ autoCollapseThresholdMs: undefined })).toEqual({});
        expect(reconcile()).toEqual({});
    });

    it('restores only bounded, recognized persisted entries', () => {
        expect(
            parseProjectCollapseState(
                JSON.stringify({
                    alpha: 'user-collapsed',
                    beta: 'automatic',
                    delta: 'manual',
                    gamma: 'unknown',
                    epsilon: 'user-expanded',
                }),
            ),
        ).toEqual({ alpha: 'user-collapsed', beta: 'automatic', epsilon: 'user-expanded' });
        expect(parseProjectCollapseState('{ broken')).toEqual({});
    });
});

describe('Project collapse protection for delegated Sessions', () => {
    /**
     * A nested Session lives under its host, so the group that must stay open is the host's, not the Project the nested
     * Session itself belongs to.
     */
    const delegatedSessions = [
        session('host', 'host-project'),
        session('child', 'child-project', { agentActivityState: 'running' }),
        session('unread-consult', 'consult-project', { hasUnread: true }),
    ];
    const groupIdBySessionId = new Map([
        ['child', 'host-project'],
        ['unread-consult', 'host-project'],
    ]);
    const delegatedPolicy = (overrides: Partial<Parameters<typeof policy>[0]> = {}) =>
        policy({
            collapsedProjects: {
                'child-project': 'automatic',
                'consult-project': 'automatic',
                'host-project': 'automatic',
            },
            projects: [
                project('host-project', 0),
                project('child-project', 0),
                project('consult-project', 0),
            ],
            selectedSessionId: undefined,
            sessions: delegatedSessions,
            ...overrides,
        });

    it('protects the host group of a running nested Session and an unread hidden consult', () => {
        expect(delegatedPolicy({ groupIdBySessionId })).toEqual({
            'child-project': 'automatic',
            'consult-project': 'automatic',
        });
    });

    it('protects the host group of the selected nested Session', () => {
        expect(
            delegatedPolicy({
                groupIdBySessionId: new Map([['quiet-child', 'host-project']]),
                selectedSessionId: 'quiet-child',
                sessions: [session('quiet-child', 'child-project')],
            }),
        ).toEqual({ 'child-project': 'automatic', 'consult-project': 'automatic' });
    });

    it('does not protect the own Project of a Session hosted by a pinned Session', () => {
        // The Pinned group is not a Project and has no disclosure entry; the nested Session must simply stop protecting
        // the Project it only belongs to by record.
        expect(
            delegatedPolicy({
                groupIdBySessionId: new Map([
                    ['child', 'pinned-sessions'],
                    ['unread-consult', 'pinned-sessions'],
                ]),
            }),
        ).toEqual({
            'child-project': 'automatic',
            'consult-project': 'automatic',
            'host-project': 'automatic',
        });
    });

    it('falls back to the own Project when a Session is not nested', () => {
        expect(delegatedPolicy()).toEqual({ 'host-project': 'automatic' });
    });

    it('applies the same attribution to a plain reconciliation', () => {
        expect(
            reconcile({
                collapsedProjects: { 'child-project': 'automatic', 'host-project': 'automatic' },
                groupIdBySessionId,
                projects: [project('host-project', 0), project('child-project', 0)],
                selectedSessionId: undefined,
                sessions: delegatedSessions,
            }),
        ).toEqual({ 'child-project': 'automatic' });
    });
});

describe('Project disclosure toggle', () => {
    it('records both directions of the user decision', () => {
        expect(projectCollapseAfterToggle({}, 'alpha')).toEqual({ alpha: 'user-collapsed' });
        expect(projectCollapseAfterToggle({ alpha: 'user-collapsed' }, 'alpha')).toEqual({
            alpha: 'user-expanded',
        });
        expect(projectCollapseAfterToggle({ alpha: 'user-expanded' }, 'alpha')).toEqual({
            alpha: 'user-collapsed',
        });
        expect(projectCollapseAfterToggle({ alpha: 'automatic' }, 'alpha')).toEqual({
            alpha: 'user-expanded',
        });
    });

    it('leaves every other Project alone', () => {
        expect(projectCollapseAfterToggle({ beta: 'automatic' }, 'alpha')).toEqual({
            alpha: 'user-collapsed',
            beta: 'automatic',
        });
    });

    it('reads a Project as collapsed whoever collapsed it', () => {
        expect(isProjectCollapsed({ alpha: 'automatic' }, 'alpha')).toBe(true);
        expect(isProjectCollapsed({ alpha: 'user-collapsed' }, 'alpha')).toBe(true);
        expect(isProjectCollapsed({ alpha: 'user-expanded' }, 'alpha')).toBe(false);
        expect(isProjectCollapsed({}, 'alpha')).toBe(false);
    });
});

describe('Project disclosure reveal', () => {
    it('opens a Project the user had closed by hand', () => {
        const next = projectCollapseAfterReveal({ alpha: 'user-collapsed' }, 'alpha');
        expect(next).toEqual({ alpha: 'user-expanded' });
    });

    it('records the expansion so the next auto-collapse pass cannot close it again', () => {
        const next = projectCollapseAfterReveal({ alpha: 'automatic' }, 'alpha');
        expect(isProjectCollapsed(next, 'alpha')).toBe(false);
        expect(next.alpha).toBe('user-expanded');
    });

    it('answers with the same state when the Project is already open, so nothing re-renders', () => {
        const current = { alpha: 'user-expanded' } as const;
        expect(projectCollapseAfterReveal(current, 'alpha')).toBe(current);
        expect(projectCollapseAfterReveal(current, 'beta')).toBe(current);
    });
});

describe('a user decision outliving the machine', () => {
    /**
     * The regression this suite exists for: the expansion used to live in a `useRef` while the automatic collapse was
     * persisted, so a reload restored the machine's decision and discarded the user's.
     */
    const reload = (state: Parameters<typeof projectCollapseAfterToggle>[0]) =>
        parseProjectCollapseState(JSON.stringify(state));

    it('keeps a hand-expanded Project open across a reload and a later auto-collapse pass', () => {
        const expanded = projectCollapseAfterToggle({ idle: 'automatic' }, 'idle');
        const afterReload = reload(expanded);
        expect(isProjectCollapsed(afterReload, 'idle')).toBe(false);
        const afterPolicy = policy({ collapsedProjects: afterReload });
        expect(isProjectCollapsed(afterPolicy, 'idle')).toBe(false);
    });

    it('keeps a hand-collapsed Project closed across a reload even once it is no longer stale', () => {
        const collapsed = projectCollapseAfterToggle({}, 'idle');
        const afterPolicy = policy({
            collapsedProjects: reload(collapsed),
            projects: [project('idle', 1000)],
        });
        expect(isProjectCollapsed(afterPolicy, 'idle')).toBe(true);
    });

    it('still auto-collapses a Project the user has never had an opinion about', () => {
        const afterPolicy = policy({ collapsedProjects: reload({}) });
        expect(isProjectCollapsed(afterPolicy, 'idle')).toBe(true);
    });
});
