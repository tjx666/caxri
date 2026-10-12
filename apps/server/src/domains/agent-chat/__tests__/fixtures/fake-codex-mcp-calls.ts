/**
 * MCP calls the fake Codex app-server's `explore` turn makes after its commands: a plain MCP tool, and Computer Use
 * steps through the bundled `cua_repl/js` tool the way the Codex app reports them. One browser step returns its whole
 * result again as text, as some real steps do.
 */
import crypto from 'node:crypto';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

const BROWSER_META = {
    'codex/browserUse': true,
    'codex/toolSurface': { backend: 'chrome', browserFamily: 'chrome', kind: 'browserUse' },
};

/**
 * The parts of an app-server `McpToolCallResult` the Chat reads.
 */
interface FakeMcpResult {
    content: Array<{ type: 'text'; text: string }>;
    _meta?: Record<string, unknown>;
}

export function completeMcpCalls(io: FakeCodexIo, turn: FakeTurn) {
    const call = (
        server: string,
        tool: string,
        arguments_: Record<string, string>,
        result: FakeMcpResult,
    ) =>
        io.completeItem(turn, {
            type: 'mcpToolCall',
            id: crypto.randomUUID(),
            server,
            tool,
            status: 'completed',
            arguments: arguments_,
            result,
            durationMs: 5,
        });
    call(
        'docs',
        'search',
        { query: 'greet' },
        { content: [{ type: 'text', text: '{"hits": 1}' }] },
    );
    const pageState: FakeMcpResult = {
        content: [
            { type: 'text', text: 'Browser tab: 1, Title: "Router", URL: "https://example.com/"' },
        ],
        _meta: BROWSER_META,
    };
    call(
        'cua_repl',
        'js',
        { code: 'await tab.getAXState();', title: 'Read the router page' },
        pageState,
    );
    call(
        'cua_repl',
        'js',
        { code: 'await tab.click(12);', title: 'Open the JSON editor' },
        { content: [{ type: 'text', text: JSON.stringify(pageState) }] },
    );
    call(
        'cua_repl',
        'js',
        { code: 'await app.click(3);', title: 'Copy the settings' },
        {
            content: [{ type: 'text', text: 'Clicked' }],
            _meta: { 'codex/toolSurface': { app: null, kind: 'computerUse' } },
        },
    );
}
