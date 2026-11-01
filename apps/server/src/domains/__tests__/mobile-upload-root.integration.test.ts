import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, expect, it } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The file store sweeps entries in its root that it does not track. Under a root shared by every Server of the account
 * (the old `tmpdir()` default), a dev worktree's upload deleted a file the installed app's Agent had already cited.
 */
it('keeps phone file uploads under the Server profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-upload-root-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const userDataPath = join(directory, 'user-data');
    const runtime = await createTestDomainServices({
        userDataPath,
        logger: new StructuredLogger(join(directory, 'logs')),
        send: () => {},
        terminal: { spawn: () => createFakePty() },
    });

    try {
        const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
        const { session } = await runtime.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        const content = Buffer.from('notes');
        const result = await runtime.handlers['mobile.file.uploadInternal']({
            sessionId: session.id,
            attachmentId: `file_${'a'.repeat(32)}`,
            name: 'notes.txt',
            size: content.length,
            chunkIndex: 0,
            chunk: content.toString('base64'),
            principal: {
                kind: 'paired-device',
                id: 'paired-device:fixture',
                deviceId: 'fixture',
                generation: 1,
                role: 'reply',
                projectIds: [project.id],
            },
        });

        expect(result.ready).toBe(true);
        expect(result.path?.startsWith(`${join(userDataPath, 'mobile-files')}/`)).toBe(true);
        await expect(readFile(result.path!, 'utf8')).resolves.toBe('notes');
    } finally {
        await runtime.close();
    }
});
