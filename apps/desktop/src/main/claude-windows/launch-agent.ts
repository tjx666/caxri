import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * The launchd label prefix of the Claude window background job. One job per Caxri profile: the suffix is a hash of the
 * profile path, so the label never carries a home path or account name. `bun run uninstall:caxri` removes every
 * `<prefix>.*.plist` it finds in `~/Library/LaunchAgents`.
 */
const CLAUDE_WINDOW_JOB_LABEL_PREFIX = 'com.caxri.app.claude-windows';

export interface ClaudeWindowLaunchAgent {
    label: string;
    plistPath: string;
}

export function claudeWindowLaunchAgent(
    home: string,
    userDataPath: string,
): ClaudeWindowLaunchAgent {
    const suffix = createHash('sha256').update(userDataPath).digest('hex').slice(0, 12);
    const label = `${CLAUDE_WINDOW_JOB_LABEL_PREFIX}.${suffix}`;
    return { label, plistPath: join(home, 'Library', 'LaunchAgents', `${label}.plist`) };
}

function xml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * The job's property list: at each local wake time it runs the packaged CLI's `host claude-window-tick` for this
 * profile, which starts the Host when Caxri is closed. launchd runs a calendar job missed while the Mac slept once at
 * wake, which is when the keeper reconciles the missed time. Output goes nowhere: the Host's own structured log records
 * the check.
 */
export function claudeWindowLaunchAgentPlist(options: {
    label: string;
    launcherPath: string;
    userDataPath: string;
    wakeTimes: ReadonlyArray<{ hour: number; minute: number }>;
}): string {
    const argumentsXml = [
        options.launcherPath,
        'host',
        'claude-window-tick',
        '--profile',
        options.userDataPath,
        '--json',
    ]
        .map((value) => `        <string>${xml(value)}</string>`)
        .join('\n');
    const intervals = options.wakeTimes
        .map(
            ({ hour, minute }) =>
                `        <dict>\n            <key>Hour</key>\n            <integer>${hour}</integer>\n            <key>Minute</key>\n            <integer>${minute}</integer>\n        </dict>`,
        )
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
</dict>
</plist>
`;
}
