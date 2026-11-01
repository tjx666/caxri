import type { ProjectRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    parseActivitySessionProject,
    resolveActivitySessionProject,
} from '../activity-session-project-store';

const project = (id: string) => ({ id, title: id }) as ProjectRecord;
const projects = [project('alpha'), project('beta'), project('gamma')];

describe('parseActivitySessionProject', () => {
    it('keeps a stored Project id and reads anything else as no pick', () => {
        expect(parseActivitySessionProject('beta')).toEqual({ projectId: 'beta' });
        expect(parseActivitySessionProject('')).toEqual({ projectId: undefined });
        expect(parseActivitySessionProject(undefined)).toEqual({ projectId: undefined });
        expect(parseActivitySessionProject({ projectId: 'beta' })).toEqual({
            projectId: undefined,
        });
    });
});

describe('resolveActivitySessionProject', () => {
    it('keeps the remembered pick over the selected Session Project', () => {
        expect(resolveActivitySessionProject(projects, 'gamma', 'alpha')?.id).toBe('gamma');
    });

    it('falls back to the selected Session Project when the pick is gone', () => {
        expect(resolveActivitySessionProject(projects, 'removed', 'beta')?.id).toBe('beta');
        expect(resolveActivitySessionProject(projects, undefined, 'beta')?.id).toBe('beta');
    });

    it('falls back to the first listed Project, and to nothing when none is listed', () => {
        expect(resolveActivitySessionProject(projects, undefined, 'hidden')?.id).toBe('alpha');
        expect(resolveActivitySessionProject([], 'alpha', 'alpha')).toBeUndefined();
    });
});
