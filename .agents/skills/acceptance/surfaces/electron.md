# macOS Electron desktop surface

Use this surface for Caxri's macOS Electron product behavior. Follow
`.agents/acceptance/PROJECT.md` to build and start an isolated app, then read
`port` from `.records/acceptance/runtime.json`:

```bash
PORT=<recorded-port>
ARTIFACT_DIR="$ROUND_DIR/assets"
agent-browser --cdp "$PORT" get url
agent-browser --cdp "$PORT" snapshot -i
```

The URL must belong to the Caxri Renderer. If target selection is ambiguous,
inspect `http://127.0.0.1:$PORT/json/list` and reject `devtools://` targets.

## Prove the planned path

1. Drive the shortest real Renderer interaction that reaches the planned state.
2. Re-snapshot after navigation, reload, or meaningful DOM replacement.
3. Capture settled visual state and supporting DOM evidence into
   `$ARTIFACT_DIR`; follow
   [../references/agent-browser.md](../references/agent-browser.md).
4. For streaming, replay, loading, animation, or another temporal claim, follow
   [../references/recording-cdp.md](../references/recording-cdp.md).
5. Copy any required Main or Runtime log excerpt into `$ARTIFACT_DIR` before
   stopping the app; the adapter removes its isolated user-data directory.

CDP excludes macOS-owned window chrome and system dialogs. Native dialogs are manual Acceptance
boundaries by default: use a deterministic Main stub to prove the product state on either side, and
give the dialog-specific observation to the user. Do not trigger system UI. Only a current user
request explicitly asking the agent to verify a native dialog permits the fail-closed exception in
[../references/native-dialogs.md](../references/native-dialogs.md).

## Agent Chat with fake Agents

Declare `"agentFixture": "agent-chat-v1"` and launch with `--agent-fixture agent-chat-v1`: Claude Code
and Codex become the deterministic Agent Chat fakes (stream-json and app-server JSON-RPC) from
`apps/server/src/domains/agent-chat/__tests__/fixtures/`, whose header comments list the message keywords
(`approve` asks for a command approval, `edit`/`patch` for a file-change diff, anything else streams a reply).
For a `switch-worktree dev` or render-audit launch, run
`eval "$(bun run .agents/skills/acceptance/scripts/agent-fixture-environment.ts --fixture agent-chat-v1 --root <abs tmp dir> --test-root <abs repo>)"` first.

## Case ids bound to a launcher fixture

Some fixtures arm themselves only for a fixed case id, so the plan must reuse that exact id and the
launch must pass it through `--case-id`. A different id silently produces an unfaulted run.

- `audit-naming-cancel` answers the Session deletion confirmation in Main instead of opening the
  native sheet. Each deletion still needs its own command file written into the launch's
  `userDataDir` before the gesture: `acceptance-session-delete-command.json` holding
  `{"caseId":"audit-naming-cancel","decision":"confirm","sequence":<n>,"sessionId":"<id>"}`, where
  `sessionId` is the Session the gesture deletes and `sequence` is higher than the previous one.
  Every field is required; the fixture rejects a command that names a different Session. Cite
  `acceptance-session-delete-receipt.jsonl` as evidence.
- `audit-extension-message-reasons` injects one Extension Host protocol fault per supervised start,
  and the Host restarts between them. The three reasons land in two different logs: the Extension
  Host records `parent-envelope` because it classifies that envelope itself, while Server Core
  records `child-envelope` and `reply-result`. Read both processes' logs; filtering to Server Core
  alone shows two reasons and looks like the fixture never armed.

## Finish

Stop only the owned launcher:

```bash
bun run .agents/skills/acceptance/scripts/stop-electron.ts
```

Never use a broad process-name kill or a command that closes unrelated automation
sessions.
