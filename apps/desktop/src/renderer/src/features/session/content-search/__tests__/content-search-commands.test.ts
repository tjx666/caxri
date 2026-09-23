import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    sessions: [] as Array<{ id: string; archivedAt?: number }>,
    open: vi.fn(),
    archived: vi.fn(),
    search: vi.fn(),
}));
vi.mock('../../../../stores/selectors', () => ({
    getBootstrap: () => ({ sessions: state.sessions }),
}));
vi.mock('../../../../stores/dialogs', () => ({
    setArchivedSessionsOpen: state.archived,
    setSessionContentSearchOpen: state.search,
}));
vi.mock('../../session-commands', () => ({ openSession: state.open }));

import { openContentSearchResult } from '../content-search-commands';

beforeEach(() => {
    vi.clearAllMocks();
    state.sessions = [{ id: 'active' }, { id: 'archived', archivedAt: 1 }];
});
it('opens active results and routes archived results to explicit restore', () => {
    openContentSearchResult('active');
    expect(state.open).toHaveBeenCalledWith('active');
    openContentSearchResult('archived');
    expect(state.archived).toHaveBeenCalledWith(true);
    expect(state.open).toHaveBeenCalledTimes(1);
});
it('rechecks a removed result before closing search', () => {
    openContentSearchResult('removed');
    expect(state.search).not.toHaveBeenCalled();
});
