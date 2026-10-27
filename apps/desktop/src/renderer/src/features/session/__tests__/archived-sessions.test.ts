import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    deriveArchivedSessionView,
    pruneArchivedSelection,
    untitledArchivedSessionIds,
    visibleArchivedSessionIds,
} from '../archived-sessions';

function project(id: string, orderIndex: number): ProjectRecord {
    return {
        id,
        rootPath: `/projects/${id}`,
        displayTitle: id.toUpperCase(),
        orderIndex,
        createdAt: 1,
        lastOpenedAt: 1,
    };
}

function session(
    id: string,
    projectId: string,
    archivedAt: number | undefined,
    primaryAgentTerminalId?: string,
): SessionRecord {
    return {
        id,
        projectId,
        workbenchProjectId: projectId,
        rootPath: `/projects/${projectId}`,
        createdAt: 1,
        lastOpenedAt: 1,
        sidebarOrder: 0,
        lastSessionActivityAt: 1,
        lastSessionActivityReason: 'created',
        archivedAt,
        primaryAgentTerminalId,
        lastActivityState: 'unknown',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: id.replaceAll('-', ' '),
        titleMode: 'manual',
    };
}

function terminal(
    id: string,
    sessionId: string,
    kind: TerminalRecord['kind'],
    orderIndex = 0,
): TerminalRecord {
    return {
        id,
        sessionId,
        kind,
        cwd: `/projects/${sessionId}`,
        title: kind,
        icon: kind,
        orderIndex,
        lastProcessState: 'stopped',
        createdAt: 1,
        updatedAt: 1,
    };
}

const projects = [project('beta', 1), project('alpha', 0)];
const sessions = [
    session('alpha-old', 'alpha', 10),
    session('beta-review', 'beta', 20, 'beta-claude'),
    session('alpha-review', 'alpha', 30, 'alpha-codex'),
    session('alpha-active', 'alpha', undefined),
];
const terminals = [
    terminal('alpha-shell', 'alpha-old', 'shell'),
    terminal('beta-claude', 'beta-review', 'claude'),
    terminal('alpha-shell-first', 'alpha-review', 'shell', 0),
    terminal('alpha-codex', 'alpha-review', 'codex', 1),
];

describe('archived Session selector', () => {
    it('lists every Project in one newest-archive-first order regardless of Project order', () => {
        const view = deriveArchivedSessionView(projects, sessions, terminals, {
            agent: 'all',
            projectId: 'all',
            query: '',
        });

        expect(view.totalCount).toBe(3);
        expect(view.matchingCount).toBe(3);
        expect(view.items.map((item) => [item.session.id, item.project.id, item.agent])).toEqual([
            ['alpha-review', 'alpha', 'codex'],
            ['beta-review', 'beta', 'claude'],
            ['alpha-old', 'alpha', 'shell'],
        ]);
    });

    it('puts the latest archive from a later Project above older archives in the first Project', () => {
        const view = deriveArchivedSessionView(
            projects,
            [...sessions, session('beta-latest', 'beta', 50)],
            terminals,
            { agent: 'all', projectId: 'all', query: '' },
        );

        expect(view.items[0]?.session.id).toBe('beta-latest');
    });

    it('filters archived Sessions by title, Project, and Agent independently', () => {
        expect(
            deriveArchivedSessionView(projects, sessions, terminals, {
                agent: 'all',
                projectId: 'all',
                query: 'BETA REVIEW',
            }).items.map((item) => item.session.id),
        ).toEqual(['beta-review']);
        expect(
            deriveArchivedSessionView(projects, sessions, terminals, {
                agent: 'all',
                projectId: 'alpha',
                query: '',
            }).matchingCount,
        ).toBe(2);
        expect(
            deriveArchivedSessionView(projects, sessions, terminals, {
                agent: 'shell',
                projectId: 'all',
                query: '',
            }).items.map((item) => item.session.id),
        ).toEqual(['alpha-old']);
    });

    it('keeps filter options stable after the selected Project archive becomes empty', () => {
        const view = deriveArchivedSessionView(projects, sessions, terminals, {
            agent: 'codex',
            projectId: 'alpha',
            query: 'review',
        });

        expect(view.projectOptions.map((item) => item.id)).toEqual(['alpha', 'beta']);
        expect(view.agentOptions).toEqual(['shell', 'claude', 'codex']);

        const afterRestore = deriveArchivedSessionView(
            projects,
            sessions.filter((item) => item.projectId !== 'alpha' || item.archivedAt === undefined),
            terminals,
            { agent: 'all', projectId: 'alpha', query: '' },
        );
        expect(afterRestore.totalCount).toBe(1);
        expect(afterRestore.matchingCount).toBe(1);
        expect(afterRestore.projectId).toBe('all');
        expect(afterRestore.items.map((item) => item.project.id)).toEqual(['beta']);
        expect(afterRestore.projectOptions.map((item) => item.id)).toEqual(['beta']);
    });

    it('omits an Agent kind with zero archived Sessions instead of offering a dead-end filter', () => {
        const withoutCodex = deriveArchivedSessionView(
            projects,
            sessions.filter((item) => item.id !== 'alpha-review'),
            terminals,
            { agent: 'all', projectId: 'all', query: '' },
        );

        expect(withoutCodex.agentOptions).toEqual(['shell', 'claude']);
    });
});

describe('archived Session selection', () => {
    const untitled = (id: string, projectId: string, archivedAt: number): SessionRecord => ({
        ...session(id, projectId, archivedAt),
        displayTitle: 'Untitled',
        titleMode: 'automatic',
    });
    const withUntitled = [
        ...sessions,
        untitled('alpha-blank', 'alpha', 40),
        untitled('beta-blank', 'beta', 5),
    ];
    const filters = { agent: 'all' as const, projectId: 'all', query: '' };

    it('lists visible ids in display order and picks only default-titled Sessions as Untitled', () => {
        const view = deriveArchivedSessionView(projects, withUntitled, terminals, filters);

        expect(visibleArchivedSessionIds(view)).toEqual([
            'alpha-blank',
            'alpha-review',
            'beta-review',
            'alpha-old',
            'beta-blank',
        ]);
        expect(untitledArchivedSessionIds(view)).toEqual(['alpha-blank', 'beta-blank']);
    });

    it('scopes the Untitled shortcut to the active filters', () => {
        const view = deriveArchivedSessionView(projects, withUntitled, terminals, {
            ...filters,
            projectId: 'beta',
        });

        expect(untitledArchivedSessionIds(view)).toEqual(['beta-blank']);
    });

    it('drops selected ids that the current filters hide and keeps the same Set when nothing changed', () => {
        const full = deriveArchivedSessionView(projects, withUntitled, terminals, filters);
        const narrowed = deriveArchivedSessionView(projects, withUntitled, terminals, {
            ...filters,
            query: 'untitled',
        });
        const selection = new Set(['alpha-blank', 'alpha-review', 'beta-blank']);

        expect(pruneArchivedSelection(selection, full)).toBe(selection);
        expect([...pruneArchivedSelection(selection, narrowed)]).toEqual([
            'alpha-blank',
            'beta-blank',
        ]);
    });
});
