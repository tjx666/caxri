import type { SourceControlResource } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildSourceControlResourceTree,
    sourceControlDirectoryExpansionKeys,
    sourceControlGroupExpansionKeys,
    sumSourceControlLineStats,
} from '../source-control-tree';

function resource(path: string): SourceControlResource {
    return {
        id: path,
        label: path.split('/').at(-1)!,
        tooltip: path,
        accessibilityLabel: path,
        icon: { kind: 'file-type', name: path.split('/').at(-1)! },
        path,
    };
}

describe('controlled Source Control resource tree', () => {
    it('groups arbitrary provider paths without interpreting their domain', () => {
        expect(
            buildSourceControlResourceTree([
                resource('src/z.ts'),
                resource('README.md'),
                resource('src/a.ts'),
            ]),
        ).toMatchObject([
            { kind: 'directory', name: 'src', children: [{ name: 'a.ts' }, { name: 'z.ts' }] },
            { kind: 'file', name: 'README.md' },
        ]);
    });

    it('sums measured line counts into every ancestor directory', () => {
        const measured = (path: string, additions: number, deletions: number) => ({
            ...resource(path),
            lineStats: { additions, deletions },
        });
        const [source] = buildSourceControlResourceTree([
            measured('src/a.ts', 3, 1),
            measured('src/nested/b.ts', 5, 0),
            resource('src/nested/unmeasured.bin'),
            resource('src/empty/unmeasured.txt'),
        ]);
        expect(source.kind === 'directory' && source.children.at(0)).not.toHaveProperty(
            'lineStats',
        );
        expect(source).toMatchObject({
            name: 'src',
            lineStats: { additions: 8, deletions: 1 },
            children: [
                { name: 'empty' },
                { name: 'nested', lineStats: { additions: 5, deletions: 0 } },
                { name: 'a.ts' },
            ],
        });
    });

    it('collects the selected directory and every nested directory for recursive disclosure', () => {
        const [agents] = buildSourceControlResourceTree([
            resource('.agents/acceptance/references/dev-server.md'),
            resource('.agents/skills/README.md'),
        ]);

        expect(sourceControlDirectoryExpansionKeys(agents, 'pull-request:repo')).toEqual([
            'pull-request:repo:.agents',
            'pull-request:repo:.agents/acceptance',
            'pull-request:repo:.agents/acceptance/references',
            'pull-request:repo:.agents/skills',
        ]);
    });

    it('collects every top-level directory of a group for a recursive gesture on an ancestor row', () => {
        expect(
            sourceControlGroupExpansionKeys(
                [resource('docs/adr/0001.md'), resource('src/a.ts'), resource('README.md')],
                'pull-request:repo',
            ),
        ).toEqual([
            'pull-request:repo:docs',
            'pull-request:repo:docs/adr',
            'pull-request:repo:src',
        ]);
    });
});

describe('sumSourceControlLineStats', () => {
    it('totals measured entries and ignores unmeasured ones', () => {
        expect(
            sumSourceControlLineStats([
                { additions: 1_900, deletions: 600 },
                undefined,
                { additions: 40, deletions: 84 },
            ]),
        ).toEqual({ additions: 1_940, deletions: 684 });
    });

    it('reports nothing when no entry was measured', () => {
        expect(sumSourceControlLineStats([undefined, undefined])).toBeUndefined();
    });
});
