import { describe, expect, it } from 'vitest';

import {
    deleteProjectPrompt,
    deleteSessionPrompt,
    deleteSessionsPrompt,
    discardGitChangesPrompt,
    externalLinkChoice,
    externalLinkPrompt,
    revokeMobileDevicePrompt,
    shellCommandElevationPrompt,
    trashPrompt,
    unsavedChangesChoice,
    unsavedChangesPrompt,
} from '../confirmations';

describe('external link prompt', () => {
    it('shows the full URL, not just the host, so consent is informed', () => {
        const options = externalLinkPrompt(new URL('https://example.com/login?token=abc'), true);
        expect(options.message).toContain('example.com');
        expect(options.detail).toContain('https://example.com/login?token=abc');
    });

    it('offers trusting the origin only when trust is allowed', () => {
        expect(externalLinkPrompt(new URL('https://example.com/'), true).buttons).toEqual([
            'Open Once',
            'Trust Domain and Open',
            'Cancel',
        ]);
        expect(externalLinkPrompt(new URL('https://example.com/'), false).buttons).toEqual([
            'Open Once',
            'Cancel',
        ]);
    });

    it('adds the wildcard button and names the exact host once both trust choices are shown', () => {
        const options = externalLinkPrompt(
            new URL('https://api.venice.ai/api/v1'),
            true,
            'venice.ai',
        );
        expect(options.buttons).toEqual([
            'Open Once',
            'Trust api.venice.ai and Open',
            'Trust *.venice.ai and Open',
            'Cancel',
        ]);
    });

    it('says how much wider the wildcard rule is instead of leaving the user to infer it', () => {
        const options = externalLinkPrompt(
            new URL('https://api.venice.ai/api/v1'),
            true,
            'venice.ai',
        );
        expect(options.detail).toContain('covers that host alone');
        expect(options.detail).toContain('every subdomain of venice.ai');
        expect(options.detail).toContain('sites other people control');
    });

    it('keeps the wildcard button out of a prompt that may not persist trust at all', () => {
        expect(
            externalLinkPrompt(new URL('https://api.venice.ai/'), false, 'venice.ai').buttons,
        ).toEqual(['Open Once', 'Cancel']);
    });

    it('makes Cancel both the default and the Escape target in every shape', () => {
        const shapes = [
            externalLinkPrompt(new URL('https://example.com/'), true),
            externalLinkPrompt(new URL('https://example.com/'), false),
            externalLinkPrompt(new URL('https://api.venice.ai/'), true, 'venice.ai'),
        ];
        for (const options of shapes) {
            const cancelIndex = options.buttons!.indexOf('Cancel');
            expect(options.defaultId).toBe(cancelIndex);
            expect(options.cancelId).toBe(cancelIndex);
        }
    });

    it('maps every button index to its decision', () => {
        expect(externalLinkChoice(0, true)).toBe('open_once');
        expect(externalLinkChoice(1, true)).toBe('trust');
        expect(externalLinkChoice(2, true)).toBe('cancel');
        expect(externalLinkChoice(0, false)).toBe('open_once');
        /**
         * Without trust, index 1 is Cancel — it must never be read as an implicit trust.
         */
        expect(externalLinkChoice(1, false)).toBe('cancel');
    });

    it('reads index 2 as the wildcard choice only when that button was rendered', () => {
        expect(externalLinkChoice(2, true, true)).toBe('trust_parent');
        expect(externalLinkChoice(1, true, true)).toBe('trust');
        expect(externalLinkChoice(3, true, true)).toBe('cancel');
        /**
         * In the three-button shape index 2 is Cancel. Reading it as `trust_parent` would persist a wildcard rule the
         * user never saw offered.
         */
        expect(externalLinkChoice(2, true, false)).toBe('cancel');
    });
});

describe('trash prompt', () => {
    it('names the target and promises recovery for a saved file', () => {
        const options = trashPrompt({ name: 'notes.md', path: '/tmp/notes.md' });
        expect(options.message).toBe("Move 'notes.md' to the Trash?");
        expect(options.detail).toContain('You can recover this item from the Trash.');
    });

    /**
     * The Trash restores only what reached disk, so the blanket reassurance would be a lie here.
     */
    it('withdraws the recovery promise when the editor holds unsaved changes', () => {
        const options = trashPrompt({
            name: 'notes.md',
            path: '/tmp/notes.md',
            hasUnsavedChanges: true,
        });
        expect(options.detail).not.toContain('You can recover this item from the Trash.');
        expect(options.detail).toContain('Only the last saved version can be recovered');
    });

    it('keeps Cancel as the default and Escape target', () => {
        const options = trashPrompt({ name: 'notes.md', path: '/tmp/notes.md' });
        expect(options.buttons![options.defaultId!]).toBe('Cancel');
        expect(options.buttons![options.cancelId!]).toBe('Cancel');
    });
});

describe('mobile device revoke prompt', () => {
    it('names the device, explains the impact, and keeps cancellation safe by default', () => {
        const options = revokeMobileDevicePrompt({
            displayName: 'Pixel 8',
            platform: 'android',
        });
        expect(options.message).toBe("Revoke 'Pixel 8'?");
        expect(options.detail).toContain('immediately loses access');
        expect(options.detail).toContain('pair it again');
        expect(options.detail).toContain('Projects and files are not affected');
        expect(options.buttons![options.defaultId!]).toBe('Cancel');
        expect(options.buttons![options.cancelId!]).toBe('Cancel');
    });
});

describe('delete prompts', () => {
    it.each([
        ['Project', deleteProjectPrompt, 'The Project folder'],
        ['Session', deleteSessionPrompt, 'The selected folder'],
    ] as const)('names the %s and states that files survive', (kind, prompt, clause) => {
        const options = prompt('caxri', 0);
        expect(options.title).toBe(`Delete ${kind}`);
        expect(options.message).toBe("Delete 'caxri'?");
        expect(options.detail).toContain('Only Caxri metadata and snapshots are deleted.');
        expect(options.detail).toContain(`${clause} and its files are never touched.`);
        expect(options.buttons).toEqual([`Delete ${kind}`, 'Cancel']);
        expect(options.buttons![options.defaultId!]).toBe('Cancel');
        expect(options.buttons![options.cancelId!]).toBe('Cancel');
    });

    it.each([
        [1, "Delete 'caxri' and terminate 1 running Terminal?"],
        [3, "Delete 'caxri' and terminate 3 running Terminals?"],
    ])('warns about %i running Terminals with matching plural', (count, message) => {
        expect(deleteProjectPrompt('caxri', count).message).toBe(message);
        expect(deleteSessionPrompt('caxri', count).message).toBe(message);
    });

    it('says nothing about worktree Projects when none cascade', () => {
        expect(deleteProjectPrompt('caxri', 0).detail).not.toContain('worktree');
    });

    it('names the cascaded worktree Projects and that this is their only delete path', () => {
        const options = deleteProjectPrompt('caxri', 0, ['feature-a', 'feature-b']);
        expect(options.detail).toContain(
            "2 linked worktree Projects are removed with it: 'feature-a', 'feature-b'.",
        );
        expect(options.detail).toContain('a cascade like this is the only way they are removed');
        // The metadata-only promise still has to survive the added sentence.
        expect(options.detail).toContain('The Project folder and its files are never touched.');
    });

    /**
     * An auto-registered worktree Project can never hold a Session of its own, so the only Sessions this cascade
     * touches are the ones adopting the worktree as a Workbench Root — and those are kept, not deleted. Copy that said
     * "and their Sessions" would name an always-empty set while implying the one set that survives.
     */
    it('says the Sessions working in those worktrees survive rather than implying they go too', () => {
        const detail = deleteProjectPrompt('caxri', 0, ['feature-a', 'feature-b']).detail ?? '';
        expect(detail).toContain(
            'Any Session still working in one of them survives, with its Workbench Root back at its own Project root.',
        );
        expect(detail).not.toContain('along with their Sessions');
    });

    it('uses singular wording for one cascaded worktree Project', () => {
        expect(deleteProjectPrompt('caxri', 0, ['feature-a']).detail).toContain(
            "1 linked worktree Project is removed with it: 'feature-a'. Caxri registered it automatically when a Session adopted the worktree, and a cascade like this is the only way it is removed. Any Session still working in it survives",
        );
    });

    it('counts the tail instead of listing every title, so the dialog stays readable', () => {
        const detail = deleteProjectPrompt('caxri', 0, ['a', 'b', 'c', 'd', 'e', 'f', 'g']).detail;
        expect(detail).toContain("'a', 'b', 'c', 'd', 'e', and 2 more.");
        expect(detail).toContain('7 linked worktree Projects');
        expect(detail).not.toContain("'f'");
    });
});

describe('bulk delete Sessions prompt', () => {
    it.each([
        [0, 'Delete 3 Sessions?'],
        [1, 'Delete 3 Sessions and terminate 1 running Terminal?'],
        [4, 'Delete 3 Sessions and terminate 4 running Terminals?'],
    ])('counts Sessions and running Terminals (%i) with matching plural', (count, message) => {
        const options = deleteSessionsPrompt(3, count);
        expect(options.title).toBe('Delete Sessions');
        expect(options.message).toBe(message);
        expect(options.detail).toContain('Only Caxri metadata and snapshots are deleted.');
        expect(options.buttons![options.defaultId!]).toBe('Cancel');
        expect(options.buttons![options.cancelId!]).toBe('Cancel');
    });
});

describe('discard Git changes prompt', () => {
    it.each([
        [1, "Discard all changes in 1 file in 'caxri'?"],
        [3, "Discard all changes in 3 files in 'caxri'?"],
    ])(
        'names the file count and repository with matching plural for %i files',
        (fileCount, message) => {
            const options = discardGitChangesPrompt({
                repositoryName: 'caxri',
                scope: { kind: 'all', fileCount },
            });
            expect(options.message).toBe(message);
            expect(options.buttons).toEqual(['Discard All Changes', 'Cancel']);
            expect(options.defaultId).toBe(1);
            expect(options.cancelId).toBe(1);
        },
    );

    it('names the tracked file and offers to discard its changes', () => {
        const options = discardGitChangesPrompt({
            repositoryName: 'caxri',
            scope: { kind: 'file', path: 'src/index.ts', untracked: false },
        });
        expect(options.message).toBe("Discard changes in 'src/index.ts'?");
        expect(options.buttons).toEqual(['Discard Changes', 'Cancel']);
        expect(options.buttons![options.defaultId!]).toBe('Cancel');
        expect(options.buttons![options.cancelId!]).toBe('Cancel');
    });

    /**
     * An untracked file has no committed state to restore to, so discarding it is a permanent delete and the copy must
     * say so instead of reusing the "restored" wording used for tracked files.
     */
    it('warns about permanent deletion for an untracked file', () => {
        const options = discardGitChangesPrompt({
            repositoryName: 'caxri',
            scope: { kind: 'file', path: 'new-file.ts', untracked: true },
        });
        expect(options.message).toBe("Delete 'new-file.ts'?");
        expect(options.buttons).toEqual(['Delete File', 'Cancel']);
        expect(options.detail).toContain('permanently deleted');
    });
});

describe('unsaved changes prompt', () => {
    it('names the document and offers the three macOS choices', () => {
        const options = unsavedChangesPrompt('index.ts');
        expect(options.message).toBe("Do you want to save the changes you made to 'index.ts'?");
        expect(options.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
    });

    /**
     * Enter must save and Escape must cancel; neither may land on the destructive choice.
     */
    it('never puts the destructive choice behind Enter or Escape', () => {
        const options = unsavedChangesPrompt('index.ts');
        expect(options.buttons![options.defaultId!]).toBe('Save');
        expect(options.buttons![options.cancelId!]).toBe('Cancel');
    });

    it('maps every button index to its decision', () => {
        expect(unsavedChangesChoice(0)).toBe('save');
        expect(unsavedChangesChoice(1)).toBe('discard');
        expect(unsavedChangesChoice(2)).toBe('cancel');
    });
});

describe('shell command elevation prompt', () => {
    it('names the link and maps Escape to Cancel before the administrator prompt', () => {
        const options = shellCommandElevationPrompt('install', '/usr/local/bin/caxri');
        expect(options.detail).toContain('/usr/local/bin/caxri');
        expect(options.buttons?.[options.cancelId ?? -1]).toBe('Cancel');
        expect(shellCommandElevationPrompt('uninstall', '/usr/local/bin/caxri').detail).toContain(
            'Caxri app itself is not affected',
        );
    });
});
