#!/bin/bash
# Installs or updates Caxri on an Apple Silicon Mac from its GitHub Release.
#
#   curl -fsSL https://raw.githubusercontent.com/tjx666/caxri/main/install.sh | bash
#
# Needs only what macOS ships (curl, shasum, hdiutil, ditto, xattr): no repository, Node.js, Bun, gh, or Homebrew.
# It downloads the release DMG and its published SHA-256, refuses a mismatch, and replaces Caxri.app only after the new
# copy is fully staged, so a failed install keeps the previous app. It clears the quarantine attribute on the installed
# Caxri.app alone (never Gatekeeper as a whole) and never touches Projects, Sessions, or the Caxri profile.
#
# Environment:
#   CAXRI_VERSION      Install this version (for example 0.0.147) instead of the latest release.
#   CAXRI_INSTALL_DIR  Folder that receives Caxri.app. Defaults to /Applications.
#   CAXRI_RELEASE_URL  Base URL of the release downloads, for tests. Defaults to the GitHub repository's releases.

set -euo pipefail

REPOSITORY_URL="https://github.com/tjx666/caxri"
RELEASE_URL="${CAXRI_RELEASE_URL:-$REPOSITORY_URL/releases}"
INSTALL_DIR="${CAXRI_INSTALL_DIR:-/Applications}"
APP_NAME="Caxri.app"

fail() {
    printf 'Caxri install failed: %s\n' "$1" >&2
    exit 1
}

say() {
    printf '%s\n' "$1"
}

check_platform() {
    [ "$(uname -s)" = "Darwin" ] || fail "Caxri runs on macOS only."
    [ "$(uname -m)" = "arm64" ] || fail "Caxri needs an Apple Silicon Mac (arm64)."
    local major
    major="$(sw_vers -productVersion | cut -d. -f1)"
    [ "$major" -ge 13 ] || fail "Caxri needs macOS 13 or later; this Mac runs $(sw_vers -productVersion)."
}

resolve_version() {
    if [ -n "${CAXRI_VERSION:-}" ]; then
        printf '%s' "${CAXRI_VERSION#v}"
        return
    fi
    # The releases/latest page redirects to the newest stable tag; following it avoids the rate-limited GitHub API.
    local latest
    latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASE_URL/latest")" ||
        fail "could not reach $RELEASE_URL/latest. Check the network connection and try again."
    local tag="${latest##*/}"
    case "$tag" in
        v[0-9]*.[0-9]*.[0-9]*) printf '%s' "${tag#v}" ;;
        *) fail "could not find the latest Caxri release at $RELEASE_URL." ;;
    esac
}

is_running() {
    # Matches only the executable inside the bundle this script is about to replace.
    pgrep -f "^$INSTALL_DIR/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1
}

cleanup() {
    if [ -d "$mount" ]; then hdiutil detach -quiet "$mount" >/dev/null 2>&1 || true; fi
    rm -rf "$work" "$staged"
}

main() {
    check_platform
    local version
    version="$(resolve_version)"
    local dmg="Caxri-$version-arm64.dmg"
    # Globals rather than locals: the EXIT trap runs after main returns, when its locals are gone.
    work="$(mktemp -d "${TMPDIR:-/tmp}/caxri-install.XXXXXX")"
    mount="$work/mount"
    staged="$INSTALL_DIR/.$APP_NAME.installing"
    previous="$INSTALL_DIR/.$APP_NAME.previous"
    trap cleanup EXIT

    [ -d "$INSTALL_DIR" ] || fail "$INSTALL_DIR does not exist."
    [ -w "$INSTALL_DIR" ] ||
        fail "$INSTALL_DIR is not writable. Run again with CAXRI_INSTALL_DIR=\"\$HOME/Applications\" or from an administrator account."
    if is_running; then
        fail "Caxri is running from $INSTALL_DIR/$APP_NAME. Quit it first (Caxri > Quit Caxri); running Agents stop with it, so let their work finish."
    fi

    say "Downloading Caxri $version..."
    curl -fL --progress-bar -o "$work/$dmg" "$RELEASE_URL/download/v$version/$dmg" ||
        fail "could not download $dmg from release v$version."
    curl -fsSL -o "$work/$dmg.sha256" "$RELEASE_URL/download/v$version/$dmg.sha256" ||
        fail "could not download the checksum for $dmg."

    local expected actual
    expected="$(awk 'NR == 1 { print $1 }' "$work/$dmg.sha256")"
    actual="$(shasum -a 256 "$work/$dmg" | awk '{ print $1 }')"
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "the published checksum for $dmg is malformed."
    [ "$expected" = "$actual" ] ||
        fail "$dmg does not match its published SHA-256 (expected $expected, got $actual). Nothing was installed."

    mkdir -p "$mount"
    hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$work/$dmg" ||
        fail "could not open $dmg."
    [ -d "$mount/$APP_NAME" ] || fail "$dmg does not contain $APP_NAME."

    rm -rf "$staged"
    ditto "$mount/$APP_NAME" "$staged" || fail "could not copy $APP_NAME into $INSTALL_DIR."
    # A browser download quarantines the app and macOS then reports the unsigned build as damaged. Clear it on this
    # app only; Gatekeeper stays on for everything else.
    xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true

    rm -rf "$previous"
    if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
        mv "$INSTALL_DIR/$APP_NAME" "$previous" || fail "could not move the current $APP_NAME aside."
    fi
    if ! mv "$staged" "$INSTALL_DIR/$APP_NAME"; then
        if [ -d "$previous" ]; then mv "$previous" "$INSTALL_DIR/$APP_NAME"; fi
        fail "could not move the new $APP_NAME into place; the previous version was kept."
    fi
    rm -rf "$previous"

    say "Installed Caxri $version to $INSTALL_DIR/$APP_NAME."
    say "Open it with: open \"$INSTALL_DIR/$APP_NAME\""
}

main "$@"
