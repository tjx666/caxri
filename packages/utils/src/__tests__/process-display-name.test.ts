import { describe, expect, it } from 'vitest';

import { processDisplayName } from '../process-display-name';

describe('processDisplayName', () => {
    it('names processes after what they run instead of their path', () => {
        expect(processDisplayName('/Users/me/.local/bin/claude --resume abc')).toBe('claude');
        expect(
            processDisplayName(
                '/Applications/Caxri.app/Contents/Resources/server/runtime/bin/node /Applications/Caxri.app/Contents/Resources/server/bundles/agent-launcher.js --x',
            ),
        ).toBe('node agent-launcher.js');
        expect(processDisplayName('bun run .agents/scripts/watch-pr.ts --repo a/b')).toBe(
            'bun watch-pr.ts',
        );
        expect(processDisplayName('-zsh')).toBe('zsh');
        expect(processDisplayName('/bin/zsh -c source /tmp/snapshot.sh')).toBe('zsh');
        expect(processDisplayName('(git)')).toBe('git');
        expect(processDisplayName('node')).toBe('node');
    });

    it('never turns inline code or an argument fragment into the name', () => {
        expect(
            processDisplayName(`python3 -c import requests; requests.get("https://h/x?token=t0k")`),
        ).toBe('python3');
        expect(processDisplayName('node -e console.log(process.env.KEY)')).toBe('node');
        expect(processDisplayName('ruby -e puts 1')).toBe('ruby');
        expect(processDisplayName('node --inspect=9229 server.js')).toBe('node server.js');
        expect(processDisplayName('perl /tmp/x?token=t0k')).toBe('perl');
    });
});
