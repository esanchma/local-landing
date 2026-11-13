#!/bin/sh
set -eu

staged="$HOME/.local/bin/local-landing.install.$$"
trap 'rm -f "$staged"' EXIT

bun run build
install -m 755 dist/local-landing "$staged"
pkexec /usr/sbin/setcap 'cap_net_bind_service+ep' "$staged"
mv -f "$staged" "$HOME/.local/bin/local-landing"
install -m 644 local-landing.service "$HOME/.config/systemd/user/local-landing.service"
systemctl --user daemon-reload
systemctl --user restart local-landing.service
systemctl --user status --no-pager local-landing.service
journalctl --user --unit local-landing -I --no-pager

