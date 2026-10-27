import { describe, expect, it } from 'vitest';

import { formatRelativeTime, formatTable, renderHumanRecords } from '../records-output';

const now = Date.UTC(2026, 9, 27, 12, 0, 0);

describe('human record output', () => {
    it('formats relative times', () => {
        expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
        expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
        expect(formatRelativeTime(now - 3_600_000, now)).toBe('1 hour ago');
        expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago');
        expect(formatRelativeTime(0, now)).toBe('-');
    });

    it('aligns table columns without trailing spaces', () => {
        expect(formatTable(['A', 'BB'], [['long', 'x']])).toBe('A     BB\nlong  x');
    });

    it('renders a session list as a table', () => {
        const output = renderHumanRecords(
            'session.query',
            'list',
            {
                view: 'human-cli',
                sessions: [
                    {
                        id: 's1',
                        projectId: 'p1',
                        title: 'Fix login',
                        agentActivityState: 'idle',
                        sessionActivityAt: now - 120_000,
                    },
                    {
                        id: 's2',
                        projectId: 'p1',
                        title: 'Old',
                        archivedAt: 1,
                        agentActivityState: 'idle',
                        sessionActivityAt: now - 3 * 86_400_000,
                    },
                ],
            },
            now,
        );
        expect(output).toContain('Fix login');
        expect(output).toContain('2 minutes ago');
        expect(output).toContain('archived');
        expect(output).not.toContain('view');
    });

    it('renders show as key: value lines and empty lists with a hint', () => {
        const project = renderHumanRecords(
            'project.query',
            'show',
            { projects: [{ id: 'p1', title: 'Demo', rootPath: '/work/demo' }] },
            now,
        );
        expect(project).toBe('Title: Demo\nPath:  /work/demo\nID:    p1\n');
        expect(renderHumanRecords('project.query', 'list', { projects: [] }, now)).toContain(
            'caxri project add .',
        );
    });

    it('ignores other methods', () => {
        expect(renderHumanRecords('host.status', 'status', {}, now)).toBeUndefined();
    });
});
