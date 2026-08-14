import { describe, expect, it } from 'vitest';

import {
    deleteProjectPrompt,
    deleteSessionPrompt,
    externalLinkChoice,
    externalLinkPrompt,
    legacyHostUpgradePrompt,
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

    it('makes Cancel both the default and the Escape target in either shape', () => {
        for (const allowTrust of [true, false]) {
            const options = externalLinkPrompt(new URL('https://example.com/'), allowTrust);
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
        /** Without trust, index 1 is Cancel — it must never be read as an implicit trust. */
        expect(externalLinkChoice(1, false)).toBe('cancel');
    });
});

describe('trash prompt', () => {
    it('names the target and promises recovery for a saved file', () => {
        const options = trashPrompt({ name: 'notes.md', path: '/tmp/notes.md' });
        expect(options.message).toBe("Move 'notes.md' to the Trash?");
        expect(options.detail).toContain('You can recover this item from the Trash.');
    });

    /** The Trash restores only what reached disk, so the blanket reassurance would be a lie here. */
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

describe('delete prompts', () => {
    it.each([
        ['Project', deleteProjectPrompt, 'The Project directory'],
        ['Session', deleteSessionPrompt, 'The selected directory'],
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
});

describe('legacy Host upgrade prompt', () => {
    it('keeps the non-destructive choice behind Enter and Escape', () => {
        const options = legacyHostUpgradePrompt(2);
        expect(options.buttons![options.defaultId!]).toBe('Quit');
        expect(options.buttons![options.cancelId!]).toBe('Quit');
    });

    it('states the current live count, stop boundary, and file safety', () => {
        const active = legacyHostUpgradePrompt(2).detail!;
        expect(active).toContain('currently owns 2 live Terminal processes');
        expect(active).toContain('every Terminal still running at that moment');
        expect(active).toContain('Projects and user files are never deleted');

        const idle = legacyHostUpgradePrompt(0).detail!;
        expect(idle).toContain('currently reports no live Terminal processes');
        expect(idle).toContain('cancels the upgrade');
    });
});

describe('unsaved changes prompt', () => {
    it('names the document and offers the three macOS choices', () => {
        const options = unsavedChangesPrompt('index.ts');
        expect(options.message).toBe("Do you want to save the changes you made to 'index.ts'?");
        expect(options.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
    });

    /** Enter must save and Escape must cancel; neither may land on the destructive choice. */
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
