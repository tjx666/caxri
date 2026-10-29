import { describe, expect, it } from 'vitest';

import { agentChatUserMessageSegments } from '../../agent-chat-user-message-text';
import { agentChatUserMessageBlocks } from '../agent-chat-user-message-blocks';

/**
 * A message's blocks, each written as its line kind and runs: `text[styles]`, `•` for a bullet, and the segment's text
 * in braces.
 */
function blocks(text: string, isFileOpenable = true): string[] {
    const segments = agentChatUserMessageSegments(text, { withFiles: isFileOpenable });
    return agentChatUserMessageBlocks(text, segments).map((block) => {
        const runs = block.runs
            .map((run) => {
                if (run.kind === 'bullet') return '•';
                if (run.kind === 'segment')
                    return `{${run.segment.text}${run.styles.length > 0 ? `[${run.styles.join(',')}]` : ''}}`;
                return run.styles.length > 0 ? `${run.text}[${run.styles.join(',')}]` : run.text;
            })
            .join('|');
        return `${block.line ?? 'plain'}${block.indent ? `:${block.indent}` : ''} ${runs}`;
    });
}

describe('agentChatUserMessageBlocks', () => {
    it('leaves plain text as one block', () => {
        expect(blocks('hello\nworld')).toEqual(['plain hello\nworld']);
    });

    it('hides markers around bold, italics, inline code, and strikethrough', () => {
        expect(blocks('a **b** *c* `d` ~~e~~')).toEqual([
            'plain a |b[strong]| |c[emphasis]| |d[code]| |e[strike]',
        ]);
    });

    it('draws bullets, ordered numbers, and quotes as their own blocks', () => {
        expect(blocks('intro\n- one\n- two\n1. first\n> quoted\noutro')).toEqual([
            'plain intro',
            'list:2 •| one',
            'list:2 •| two',
            'list:3 1.[syntax]| first',
            'quote quoted',
            'plain outro',
        ]);
    });

    it('keeps blank lines between plain paragraphs', () => {
        expect(blocks('a\n\nb')).toEqual(['plain a\n\nb']);
    });

    it('keeps paths, snake_case, and dunder names literal', () => {
        expect(blocks('see src/foo_bar.ts and __init__ and snake_case_name', false)).toEqual([
            'plain see src/foo_bar.ts and __init__ and snake_case_name',
        ]);
        expect(blocks('src/*.ts and lib/*.ts')).toEqual(['plain src/*.ts and lib/*.ts']);
    });

    it('keeps a path pill inside bold text', () => {
        expect(blocks('**open /Users/me/app.ts now**')).toEqual([
            'plain open [strong]|{/Users/me/app.ts[strong]}| now[strong]',
        ]);
    });

    it('leaves headings and fenced code as typed', () => {
        expect(blocks('# title\n```\nconst a = **b**\n```')).toEqual([
            'plain # title\n```\nconst a = **b**\n```',
        ]);
    });

    it('does not render tables or images', () => {
        expect(blocks('| a | b |\n|---|---|\n![x](y.png)')).toEqual([
            'plain | a | b |\n|---|---|\n![x](y.png)',
        ]);
    });
});
