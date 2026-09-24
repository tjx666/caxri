import { describe, expect, it, vi } from 'vitest';

import { trackProjectItem } from '../track-project-item';

const select = (id: string, names: string[]) => ({
    id,
    options: names.map((name) => ({ id: `${id}-${name}`, name })),
});

function lookup(projectItems: Array<{ id: string; project: { id: string } }>) {
    return JSON.stringify({
        data: {
            repositoryOwner: {
                projectV2: {
                    id: 'project',
                    priority: select('priority', ['P1 High', 'P2 Normal']),
                    size: select('size', ['S', 'M']),
                    status: select('status', ['Next', 'In Progress', 'Done']),
                },
            },
            resource: { id: 'issue', projectItems: { nodes: projectItems } },
        },
    });
}

const readBack = JSON.stringify({
    data: {
        node: { priority: { name: 'P2 Normal' }, size: { name: 'S' }, status: { name: 'Next' } },
    },
});

function queryOf(arguments_: string[]): string {
    return arguments_.find((argument) => argument.startsWith('query='))?.slice(6) ?? '';
}

describe('trackProjectItem', () => {
    it('adds a missing item and sets every requested field in one mutation', async () => {
        const runGitHub = vi.fn<(arguments_: string[]) => Promise<string>>();
        runGitHub
            .mockResolvedValueOnce(lookup([{ id: 'elsewhere', project: { id: 'other' } }]))
            .mockResolvedValueOnce(
                JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'item' } } } }),
            )
            .mockResolvedValueOnce('{"data":{}}')
            .mockResolvedValueOnce(readBack);

        await expect(
            trackProjectItem(
                {
                    owner: 'owner',
                    projectNumber: 2,
                    url: 'https://github.com/owner/repo/issues/1',
                    values: { priority: 'P2 Normal', size: 'S', status: 'Next' },
                },
                { runGitHub },
            ),
        ).resolves.toEqual({ priority: 'P2 Normal', size: 'S', status: 'Next' });

        expect(runGitHub).toHaveBeenCalledTimes(4);
        const [, add, update] = runGitHub.mock.calls.map(([arguments_]) => arguments_);
        expect(add).toEqual(expect.arrayContaining(['content=issue', 'project=project']));
        const mutation = queryOf(update);
        expect(mutation.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(3);
        expect(mutation).toContain('"status-Next"');
        expect(update).toContain('item=item');
    });

    it('reuses an existing item and skips the add', async () => {
        const runGitHub = vi.fn<(arguments_: string[]) => Promise<string>>();
        runGitHub
            .mockResolvedValueOnce(lookup([{ id: 'item', project: { id: 'project' } }]))
            .mockResolvedValueOnce('{"data":{}}')
            .mockResolvedValueOnce(readBack);

        await trackProjectItem(
            { owner: 'owner', projectNumber: 2, url: 'u', values: { status: 'Done' } },
            { runGitHub },
        );

        expect(runGitHub).toHaveBeenCalledTimes(3);
        expect(queryOf(runGitHub.mock.calls[1][0])).not.toContain('addProjectV2ItemById');
    });

    it('rejects an unknown option before mutating anything', async () => {
        const runGitHub = vi.fn<(arguments_: string[]) => Promise<string>>();
        runGitHub.mockResolvedValueOnce(lookup([]));

        await expect(
            trackProjectItem(
                { owner: 'owner', projectNumber: 2, url: 'u', values: { priority: 'P3 Low' } },
                { runGitHub },
            ),
        ).rejects.toThrow('Priority has no option "P3 Low"; expected one of: P1 High, P2 Normal');
        expect(runGitHub).toHaveBeenCalledTimes(1);
    });
});
