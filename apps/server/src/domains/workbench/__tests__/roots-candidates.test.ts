import { describe, expect, it } from 'vitest';

import { fixture } from './roots.fixture';

interface CandidateInput {
    repositoryKey: string;
    rootPath: string;
    sessionId: string;
}

function publishCandidate(
    context: Awaited<ReturnType<typeof fixture>>,
    input: CandidateInput,
): void {
    (context.service as unknown as { addCandidate(input: CandidateInput): void }).addCandidate(
        input,
    );
}

describe('WorkbenchRootService candidate identity', () => {
    it.each(['pending', 'claimed'] as const)(
        'keeps a visible %s candidate usable after the same root is observed again',
        async (state) => {
            const context = await fixture();
            const sessionId = context.sessions[0].session.id;
            const input = {
                repositoryKey: context.getTopology().repositoryKey,
                rootPath: context.worktreeRoot,
                sessionId,
            };
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature/same', rootPath: context.worktreeRoot },
            ]);
            publishCandidate(context, input);
            const first = context.events.find((event) => event.event === 'workbench.candidate');
            if (first?.event !== 'workbench.candidate') throw new Error('Candidate not emitted');
            if (state === 'claimed')
                context.service.claimCandidate(sessionId, first.payload.candidateId);

            publishCandidate(context, input);

            expect(
                context.events.filter((event) => event.event === 'workbench.candidate'),
            ).toHaveLength(1);
            if (state === 'pending')
                context.service.claimCandidate(sessionId, first.payload.candidateId);
            await expect(
                context.service.authorizeCandidate(
                    sessionId,
                    first.payload.candidateId,
                    input.rootPath,
                ),
            ).resolves.toMatchObject({ rootPath: input.rootPath });
            await context.service.close();
            context.database.close();
        },
    );

    it('rejects the old candidate when the target changes or it was dismissed', async () => {
        const context = await fixture();
        const sessionId = context.sessions[0].session.id;
        const repoKey = context.getTopology().repositoryKey;
        publishCandidate(context, {
            repositoryKey: repoKey,
            rootPath: context.ownerRoot,
            sessionId,
        });
        const first = context.events.find((event) => event.event === 'workbench.candidate');
        if (first?.event !== 'workbench.candidate') throw new Error('Candidate not emitted');

        publishCandidate(context, {
            repositoryKey: repoKey,
            rootPath: context.worktreeRoot,
            sessionId,
        });
        expect(() =>
            context.service.claimCandidate(sessionId, first.payload.candidateId),
        ).toThrow();
        const second = context.events.findLast((event) => event.event === 'workbench.candidate');
        if (second?.event !== 'workbench.candidate') throw new Error('Candidate not emitted');
        context.service.dismissCandidate(sessionId, second.payload.candidateId);
        publishCandidate(context, {
            repositoryKey: repoKey,
            rootPath: context.worktreeRoot,
            sessionId,
        });
        expect(() =>
            context.service.claimCandidate(sessionId, second.payload.candidateId),
        ).toThrow();
        await context.service.close();
        context.database.close();
    });
});
