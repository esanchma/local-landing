# Local Landing

A local dashboard for discovering HTTP services and opening them from screenshots. Built for Linux with Bun and user-level systemd.

## How it works

On startup and when you click **Actualizar capturas** (Refresh screenshots), Local Landing finds TCP ports with `ss -ltnH`, probes them over HTTP at `127.0.0.1`, and captures each service that responds. It excludes its own port. Screenshots are stored in memory and in private temporary files while they are generated; the application has no database or persistent configuration.

The browser uses its default profile, including its sessions and extensions. Visiting a service may trigger actions on it. If the browser exits without generating a screenshot file, the dashboard shows a white placeholder and logs a warning. Other capture errors and the 20-second timeout still cause the process to exit with code 1. The service does not restart automatically after a failure.

Below each screenshot, the dashboard shows the name from the third column of `ports` and the command of the process listening on the port, obtained with `lsof` and `ps`. If either is unavailable, the dashboard indicates that. Arguments may contain sensitive information visible on the dashboard. Local Landing runs `ports` once per refresh; on this machine, `ports` uses `sudo` to query `ss` and must be able to do so without an interactive password prompt.

Screenshots use headless mode and a 1280 × 800 window. Chromium's `--screenshot` option captures the window and does not guarantee a full-page screenshot.

## Development

Requires Bun, `ss`, `lsof`, `ps`, the local `ports` utility, and a Chromium-compatible browser. Local Landing looks for `ports` in `PATH`, then in `~/update.d/bin/ports`. If it cannot run `ports`, the rest of the dashboard still works. `BROWSER` must contain an executable path, not a command line. The default is `brave-browser-stable`.

~~~sh
PORT=8088 BROWSER=/usr/bin/brave-browser-stable bun run dev
bun run build
bun test
~~~

The server listens only on `127.0.0.1`; the default port is 80. The binary bundles Bun and the interface, but still needs `ss`, `lsof`, `ps`, `ports`, and the browser installed.

## Install as a user service

~~~sh
bun run build
install -Dm755 dist/local-landing "$HOME/.local/bin/local-landing"
install -Dm644 local-landing.service "$HOME/.config/systemd/user/local-landing.service"
sudo setcap cap_net_bind_service=+ep "$HOME/.local/bin/local-landing"
systemctl --user daemon-reload
systemctl --user enable --now local-landing.service
~~~

The capability lets the binary bind to privileged ports without running as root. Run `setcap` again after replacing the binary: installation normally removes the capability. Port 80 must be available. The service unit sets `BROWSER=/usr/bin/brave-browser-stable`; change it if your browser is elsewhere. To keep the service running without an active login session, configure `loginctl enable-linger "$USER"` if your system permits it.

~~~sh
systemctl --user status local-landing.service
journalctl --user -u local-landing.service -f
systemctl --user restart local-landing.service
~~~
