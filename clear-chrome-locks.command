#!/bin/zsh
# Restore every profile in the active receiver config and release its global lock.
cd -- "${0:A:h}" || exit 1
python3 deploy/clear_receiver_locks.py
result=$?
if [[ -t 0 ]]; then
  echo
  read -r 'reply?按回车关闭窗口。'
fi
exit "$result"
