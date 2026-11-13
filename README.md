# Local Landing

A local dashboard for discovering HTTP services and opening them from screenshots. Built for Linux with Bun and user-level systemd.

## How it works

On startup and when you click **Actualizar capturas** (Refresh screenshots), Local Landing finds TCP ports with `ss -ltnH`, probes them over HTTP at `127.0.0.1`, and captures each service that responds. It excludes its own port. Screenshots are stored in memory and in private temporary files while they are generated; the application has no database or persistent configuration.

The browser uses its default profile, including its sessions and extensions. Visiting a service may trigger actions on it. A missing screenshot, browser error, or 20-second timeout affects only that service. The dashboard shows a white placeholder, or keeps the previous screenshot marked as outdated, and logs the failure. A later refresh can retry the capture. Previous screenshots are retained only when the process command and executable name still match.

The server starts and discovers HTTP services even without a graphical session. It launches the browser only when `graphical-session.target`, `xdg-desktop-portal.service`, and `xdg-desktop-portal-gtk.service` are active and systemd's user environment includes a display, `XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS`. It checks these conditions without starting the portal, including on manual refresh, and retries automatically every five seconds while captures are waiting. Browser processes receive the current user-manager session environment, not stale values from service startup. This check reduces the risk of early portal activation but cannot guarantee a working display or portal backend.

With linger and no active graphical session, the dashboard remains available without launching the browser; captures stay pending until the requirements are met. A desktop that does not start the GTK portal backend on its own will also leave captures pending. The check currently targets the GTK backend used by GNOME; other desktop setups may require a different readiness policy.

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

The capability lets the binary bind to privileged ports without running as root. Run `setcap` again after replacing the binary: installation normally removes the capability. Port 80 must be available. The service unit sets `BROWSER=/usr/bin/brave-browser-stable`; change it if your browser is elsewhere. It restarts after an unexpected process failure, with a 10-second delay. To keep the dashboard running without an active login session, configure `loginctl enable-linger "$USER"` if your system permits it. After changing an installed unit, run `systemctl --user daemon-reload` and restart the service.

~~~sh
systemctl --user status local-landing.service
journalctl --user -u local-landing.service -f
systemctl --user restart local-landing.service
~~~
