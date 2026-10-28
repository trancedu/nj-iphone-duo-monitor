#!/bin/zsh
# Double-click in Finder: cancel old work, restore configured pickup standby pages, and resume the receiver.
cd -- "${0:A:h}" || exit 1
python3 deploy/clear_receiver_locks.py
result=$?
if [[ -t 0 ]]; then
  echo
  read -r 'reply?按回车关闭窗口。'
fi
exit "$result"
