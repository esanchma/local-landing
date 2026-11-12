# Local Landing

Panel local para descubrir servicios HTTP y abrirlos a partir de capturas. Linux, Bun y systemd de usuario.

## Funcionamiento

Al arrancar y al pulsar **Actualizar capturas**, consulta los puertos TCP con `ss -ltnH`, prueba HTTP en `127.0.0.1` y captura cada servicio que responde. Excluye su propio puerto. Las capturas viven en memoria y en archivos temporales privados durante la generación; no hay base de datos ni configuración persistente de la aplicación.

El navegador usa el perfil predeterminado, con sus sesiones y extensiones. Visitar un servicio puede ejecutar acciones en él. Si el navegador termina sin generar un archivo de captura, el panel muestra un recuadro blanco y registra el aviso. Los demás fallos de captura y el timeout de 20 segundos siguen terminando el proceso con código 1. El servicio no se reinicia automáticamente tras un fallo.

Bajo cada captura se muestra el nombre de la tercera columna de `ports` y el comando del proceso que escucha en el puerto, obtenido con `lsof` y `ps`. Si alguno no es accesible, se indica que no está disponible. Los argumentos pueden contener información sensible visible en el panel. `ports` se ejecuta una vez por actualización; en esta máquina usa `sudo` para consultar `ss` y necesita poder hacerlo sin solicitar una contraseña interactiva.

La captura usa el modo headless y una ventana de 1280 × 800. La opción `--screenshot` de Chromium captura la ventana, no garantiza una página completa.

## Desarrollar

Requiere Bun, `ss`, `lsof`, `ps`, la utilidad local `ports` y un navegador Chromium compatible. Se busca `ports` en `PATH` y, si no aparece, en `~/update.d/bin/ports`. Si no se puede ejecutar, el resto del panel sigue funcionando. `BROWSER` debe contener la ruta de un ejecutable, no una línea de comandos. Por defecto usa `brave-browser-stable`.

~~~sh
PORT=8088 BROWSER=/usr/bin/brave-browser-stable bun run dev
bun run build
bun test
~~~

El servidor escucha solo en `127.0.0.1`; el puerto predeterminado es 80. El binario es autocontenido para Bun y la interfaz, pero sigue necesitando `ss`, `lsof`, `ps`, `ports` y el navegador instalados.

## Instalar como servicio de usuario

~~~sh
bun run build
install -Dm755 dist/local-landing "$HOME/.local/bin/local-landing"
install -Dm644 local-landing.service "$HOME/.config/systemd/user/local-landing.service"
sudo setcap cap_net_bind_service=+ep "$HOME/.local/bin/local-landing"
systemctl --user daemon-reload
systemctl --user enable --now local-landing.service
~~~

La capability permite al binario abrir puertos privilegiados sin ejecutarse como root. Reaplica `setcap` después de sustituir el binario: la instalación normalmente elimina la capability. El puerto 80 debe estar libre. La unidad fija `BROWSER=/usr/bin/brave-browser-stable`; cambia ese valor si tu navegador está en otra ruta. Para mantener el servicio activo sin sesión, configura `loginctl enable-linger "$USER"` si tu sistema lo permite.

~~~sh
systemctl --user status local-landing.service
journalctl --user -u local-landing.service -f
systemctl --user restart local-landing.service
~~~
