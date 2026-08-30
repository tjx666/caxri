import type { SourceControlResource } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildSourceControlResourceTree,
    sourceControlDirectoryExpansionKeys,
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
});
