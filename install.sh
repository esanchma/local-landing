systemctl --user stop local-landing.service
bun run build
cp dist/local-landing ~/.local/bin/local-landing
sudo setcap 'cap_net_bind_service+ep' ~/.local/bin/local-landing
systemctl --user restart local-landing.service
systemctl --user status local-landing.service
journalctl --user --unit local-landing -I

