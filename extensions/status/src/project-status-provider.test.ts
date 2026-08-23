import type { ProjectStatusRequestOptions, ProjectStatusSummary } from 'caxri';
import { CancellationTokenSource } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { ProjectStatusProvider } from './extension';

const emptySummary: ProjectStatusSummary = {
    refreshedAt: 1,
    repositories: [],
};

describe('ProjectStatusProvider', () => {
    it('suppresses the Runtime echo while a forced refresh is pending', async () => {
        const summary = Promise.withResolvers<ProjectStatusSummary>();
        const getProjectStatus = vi.fn<
            (options?: ProjectStatusRequestOptions) => Promise<ProjectStatusSummary>
        >(() => summary.promise);
        const provider = new ProjectStatusProvider({ getProjectStatus });
        const changed = vi.fn();
        const subscription = provider.onDidChangeTreeData(changed);
        const cancellation = new CancellationTokenSource();

        provider.refresh(true);
        expect(changed).toHaveBeenCalledTimes(1);
        const pending = provider.getChildren(undefined, cancellation.token);
        expect(getProjectStatus).toHaveBeenCalledTimes(1);
        expect(typeof getProjectStatus.mock.calls[0]?.[0]?.refreshToken).toBe('string');

        provider.projectStatusChanged();
        expect(changed).toHaveBeenCalledTimes(1);

        summary.resolve(emptySummary);
        const nodes = await pending;
        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.item.id).toBe('status:empty');

        provider.projectStatusChanged();
        expect(changed).toHaveBeenCalledTimes(2);

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });
});
