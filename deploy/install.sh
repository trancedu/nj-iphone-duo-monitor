#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JOB=com.trancedu.iphone-duo-monitor
TARGET="$HOME/Library/LaunchAgents/$JOB.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/runtime"
cp "$ROOT/deploy/$JOB.plist" "$TARGET"
launchctl bootout "gui/$(id -u)/$JOB" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl print "gui/$(id -u)/$JOB"
