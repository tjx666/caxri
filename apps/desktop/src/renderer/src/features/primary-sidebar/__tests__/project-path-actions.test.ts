import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../../lib/caxri', () => ({ caxri: { request } }));
vi.mock('../../../stores/toasts', () => ({
    tryCommand: (_title: string, action: () => unknown) => action(),
}));

import { openProjectRoot } from '../project-path-actions';

describe('Project root actions', () => {
    it.each(['finder', 'editor'] as const)(
        'opens the clicked Project in %s without a selected Session',
        (app) => {
            openProjectRoot('clicked-project', app);
            expect(request).toHaveBeenLastCalledWith('project.openRoot', {
                projectId: 'clicked-project',
                application: app,
            });
        },
    );
});
