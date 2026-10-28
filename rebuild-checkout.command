#!/bin/zsh
# Manual only: rebuild every idle Safari profile through Bag to pickup checkout.
cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
while true; do
  python3 deploy/clear_receiver_locks.py --rebuild-checkout
  result=$?
  [[ -t 0 ]] || exit "$result"
  echo
  read -r 'reply?输入 r 再按回车重跑；直接回车退出：'
  [[ "$reply" == [rR] ]] || exit "$result"
done
