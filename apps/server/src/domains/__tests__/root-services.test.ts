import type { FileMutationOperation } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../db';
import type { FileService } from '../files';
import { acknowledgeFileMutation } from '../root-services';

describe('root service file mutation acknowledgement', () => {
    it('remaps the originating durable root before removing the operation record', async () => {
        const order: string[] = [];
        const operation = {
            id: 'operation-1',
            kind: 'move',
            sessionId: 'session-1',
            workbenchRootProjectId: 'project-a',
            phase: 'completed',
            input: {
                conflict: 'reject',
                directory: '/project-a/destination',
                path: '/project-a/source.txt',
            },
            result: {
                kind: 'file',
                name: 'source.txt',
                path: '/project-a/destination/source.txt',
                previousPath: '/project-a/source.txt',
            },
            startedAt: 1,
            updatedAt: 2,
        } satisfies FileMutationOperation;
        const remapWorkbenchEditorState = vi.fn(() => {
            order.push('remap');
            return 1;
        });
        const database = { remapWorkbenchEditorState } as unknown as CaxriDatabase;
        const files = {
            getScopedMutationOperation: vi.fn(() => Promise.resolve(operation)),
            acknowledgeScopedMutationOperation: vi.fn(() => {
                order.push('acknowledge');
                return Promise.resolve();
            }),
        } as unknown as FileService;

        await acknowledgeFileMutation(database, files, operation.sessionId, operation.id);

        expect(remapWorkbenchEditorState).toHaveBeenCalledWith(
            operation.workbenchRootProjectId,
            operation.id,
            operation.result.previousPath,
            operation.result.path,
        );
        expect(order).toEqual(['remap', 'acknowledge']);
    });
});
