#!/bin/sh
set -eu
# This independent root is mandatory in current Chrome; never copy a daily profile.
profile_root="${APPLE_SHOPPING_PROFILE_DIR:-$HOME/.apple-shopping-chrome}"
case "$profile_root" in
  "$HOME"|"$HOME/Library/Application Support/Google/Chrome"*)
    echo 'Use a dedicated user-data directory, outside daily Chrome.' >&2; exit 1;;
esac
mkdir -p "$profile_root"
chmod 700 "$profile_root"
exec '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$profile_root" 'https://www.apple.com/shop/bag'
