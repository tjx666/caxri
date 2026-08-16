import { describe, expect, it } from 'vitest';

import { workItemSchema } from '../work-item.js';

describe('workItemSchema', () => {
    it('accepts a terminal work item', () => {
        expect(
            workItemSchema.safeParse({ kind: 'terminal', terminalId: 'terminal-1' }).success,
        ).toBe(true);
    });

    it('accepts an editor work item', () => {
        expect(workItemSchema.safeParse({ kind: 'editor', path: 'src/index.ts' }).success).toBe(
            true,
        );
    });

    it('rejects an editor item carrying a terminalId instead of a path', () => {
        expect(workItemSchema.safeParse({ kind: 'editor', terminalId: 'terminal-1' }).success).toBe(
            false,
        );
    });

    it('rejects an unknown discriminator', () => {
        expect(workItemSchema.safeParse({ kind: 'settings' }).success).toBe(false);
    });

    it('rejects an empty terminal id', () => {
        expect(workItemSchema.safeParse({ kind: 'terminal', terminalId: '' }).success).toBe(false);
    });
});
