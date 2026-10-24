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

WATCHDOG=com.trancedu.iphone-duo-watchdog
WATCHDOG_TARGET="$HOME/Library/LaunchAgents/$WATCHDOG.plist"
cp "$ROOT/deploy/$WATCHDOG.plist" "$WATCHDOG_TARGET"
launchctl bootout "gui/$(id -u)/$WATCHDOG" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$WATCHDOG_TARGET"
launchctl print "gui/$(id -u)/$WATCHDOG"
