#!/usr/bin/env bash
# Clone or update the competitor/agent-CLI repositories listed in references/landscape.md and
# the reference implementations listed in SKILL.md's "Reference implementations" section into the
# git-ignored top-level competitors/ directory, then print each clone's latest commit time so
# staleness is visible at a glance.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DEST="$REPO_ROOT/competitors"
mkdir -p "$DEST"

# Keep in sync with references/landscape.md (closed-source products have no entry) and with
# SKILL.md's "Reference implementations" section.
REPOS=(
    stablyai/orca
    manaflow-ai/cmux
    muxy-app/muxy
    egoist/kero
    thinkany-ai/termany
    herdrdev/herdr
    coder/mux
    iAmCorey/kooky
    warpdotdev/Warp:warp
    superset-sh/superset
    getpaseo/paseo
    pingdotgg/t3code
    Emanuele-web04/synara
    coollabsio/jean
    omnara-ai/omnara
    anthropics/claude-code
    openai/codex
    xai-org/grok-build
    # Reference implementations (not competitors); see SKILL.md's "Reference implementations".
    microsoft/vscode
    gitkraken/vscode-gitlens:gitlens
    tjx666/vscode-fe-helper
    # Streaming chat Markdown references; see references/chat-markdown-rendering.md.
    vercel/streamdown
    lobehub/lobe-chat
    lobehub/lobe-ui
    lobehub/streamdown:lobehub-streamdown
    CherryHQ/cherry-studio
    danny-avila/LibreChat
    assistant-ui/assistant-ui
    open-webui/open-webui
    ChatGPTNextWeb/NextChat
    chatboxai/chatbox
    # Session history tools; see references/session-history-search.md.
    iAmCorey/Wake:wake
    kenn-io/agentsview
    jazzyalex/agent-sessions
)

for entry in "${REPOS[@]}"; do
    repo="${entry%%:*}"
    name="${entry#*:}"
    [ "$name" = "$entry" ] && name="$(basename "$repo")"
    dir="$DEST/$name"
    if [ -d "$dir/.git" ]; then
        # Clones are read-only snapshots; hard-reset onto the freshly fetched shallow tip
        # instead of pull, which cannot reconcile divergent shallow histories.
        git -C "$dir" fetch --quiet --depth 1 origin &&
            git -C "$dir" reset --quiet --hard FETCH_HEAD ||
            echo "warn: update failed for $name" >&2
    else
        git clone --quiet --depth 1 "https://github.com/$repo.git" "$dir" || {
            echo "warn: clone failed for $repo" >&2
            continue
        }
    fi
done

echo "Latest commits under $DEST:"
for dir in "$DEST"/*/; do
    [ -d "$dir/.git" ] || continue
    printf '%-14s %s\n' "$(basename "$dir")" "$(git -C "$dir" log -1 --format='%h %ad %s' --date=short)"
done
