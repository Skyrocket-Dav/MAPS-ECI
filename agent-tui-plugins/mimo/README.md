# pacman-tokens para MiMoCode

Barra de estado para la TUI de MiMoCode: traza en braille del tráfico real de
tokens (cuántos llegaron desde el tick anterior, autoescalada contra un pico
reciente que decae, así que la línea queda plana en reposo y sube en ráfaga),
contexto restante y saldo disponible del proveedor. Portada desde
`../opencode/pacman-tokens`.

## Estado: instalado y verificado

- Probado contra **MiMoCode 0.1.16** (binario `mimo`).
- Carga confirmada en el log del host: `service=tui.plugin path=file:///…/pacman-tokens.tsx state=first source=file`.
- Render confirmado en una sesión real: la fila del prompt muestra el nombre de
  la carpeta, la traza braille y `CTX`, sin errores `[tui.slot]`.
- Saldo confirmado contra la API real de DeepSeek (HTTP 200, USD).
- Pruebas de la lógica pura: **25/25** (`node --test pacman-tokens/ecg.test.mjs`).

Evidencia de la barra renderizada en un terminal de 80 columnas:

```
Build · DeepSeek V4.1 Flash · DeepSeek   📁 appla ⡀⡀⡀⡀⡀⡀⡀⡀⡀CTX —
```

En un terminal ancho el resumen sube de nivel (`CTX ▰▰▰▰▰▰▱▱ 75% · 150k/200k`)
y la traza se alarga; al estrecharse degrada el resumen antes que la traza.

## Instalar / desinstalar

```bash
./install.sh --dry-run     # ver qué cambiaría
./install.sh               # copia el plugin al directorio que MiMo escanea
./install.sh --force       # reemplaza una copia existente
./install.sh --uninstall   # quita los archivos instalados
```

Destino: `<config>/tui/`, es decir `~/.config/mimocode/tui/` (o
`$XDG_CONFIG_HOME/mimocode/tui`, o `$MIMOCODE_HOME/config/tui`). MiMoCode
auto-descubre `*.{ts,tsx,js}` en ese directorio al arrancar: **no** hace falta
`mimo plugin`, ni `npm install`, ni tocar `mimocode.json`. Reiniciar la TUI basta.

Alternativa por proyecto: copiar los dos archivos a `<proyecto>/.mimocode/tui/`.

## Archivos

- `pacman-tokens/pacman-tokens.tsx` — plugin TUI: export por defecto `{ id, tui }`,
  registra el slot `session_prompt_right`.
- `pacman-tokens/ecg.mjs` — lógica pura (traza braille, gauge, layout, lectura de
  uso y ventana de contexto). Importada en runtime con ruta relativa; `.mjs` no
  coincide con el glob de descubrimiento, así que no se carga como plugin.
- `pacman-tokens/ecg.test.mjs` — 16 pruebas de esa lógica.
- `pacman-tokens/reference/` — `index.ts` y `tui.tsx` originales de OpenCode,
  guardados como procedencia (extensión `.txt` para que no se carguen).
- `client/` — clon del código fuente oficial de MiMoCode en el tag `v0.1.16`,
  usado para verificar el contrato de la API. Se puede borrar sin afectar al plugin.

## Cómo funciona en MiMoCode

El host inyecta el runtime y los módulos, así que el plugin no necesita
`node_modules` ni build:

- `@opentui/solid/runtime-plugin-support` instala el transform de JSX para
  `.tsx` externos y mapea `@opentui/solid`, `solid-js` y `solid-js/store` a las
  instancias del host (`packages/cli/src/cli/cmd/tui/plugin/runtime.ts:1`).
- Por eso `import type … from "@mimo-ai/plugin/tui"` es solo de tipos (se borra
  al transpilar) y `solid-js` / `@opentui/solid` se resuelven en runtime.
- Los plugins de archivo **deben** exportar `id` (`plugin/shared.ts:313-316`) y
  el default export no puede tener `server()` y `tui()` a la vez (`shared.ts:293-295`).
- El slot recibe `(ctx, props)`; `props.session_id` llega desde la ruta de sesión.
  `api.slots.register` devuelve un id y queda registrado para el dispose.

Datos leídos de `api.state`, igual que el widget de contexto interno:
`state.session.messages(id)` (solo el subagente `main`), la última respuesta del
asistente con `tokens.output > 0`, y la ventana del modelo desde
`state.provider → models[modelID].limit` (`limit.input` si existe, si no
`limit.context`).

## Diferencias con el original de OpenCode

Se conservó la traza, el gauge de contexto, el saldo y el layout adaptativo. Se
quitaron los segmentos que dependían de APIs propias de OpenCode y que **no
tienen equivalente en MiMoCode**: `5H`/`WK`/`MO` de OpenCode Go. No se
inventaron endpoints para reemplazarlos. Tampoco se portó el sondeo de conexión
(`HEAD` al host del modelo) ni el comando `/balance`.

## Saldo y ventanas de suscripción

| Proveedor | Fuente | Qué muestra |
|---|---|---|
| `deepseek` | `GET https://api.deepseek.com/user/balance` (documentado) | saldo total, con `$` o `¥` según la moneda de la cuenta |
| `openrouter` | `GET https://openrouter.ai/api/v1/credits` (documentado) | créditos menos consumo |
| `openai` | `GET https://chatgpt.com/backend-api/codex/usage` (**no documentado**) | ventanas `5H` y `7D` con lo que queda disponible |

- Se consulta cada 5 minutos, al montar la barra y al cambiar de proveedor, con
  timeout de 5 s. Si falla, el segmento no aparece; nunca se inventa un cero.
- La clave se lee primero de `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` y, si no
  está, de `<data>/auth.json` (`$MIMOCODE_HOME/data` o
  `~/.local/share/mimocode`), donde MiMoCode ya la guarda. Se mantiene en memoria
  para esa petición y nunca se escribe ni se registra en logs.
- Un modelo con coste cero en todos sus tramos muestra `FREE` aunque la cuenta
  tenga saldo.
- El dato pertenece al proveedor en uso: el del último turno o, antes de la
  primera respuesta, el modelo seleccionado en la TUI (`<state>/model.json`).

### Sobre la ventana de ChatGPT

Una cuenta ChatGPT no tiene saldo prepago: su cupo son dos ventanas rodantes. El
endpoint que las publica es el mismo que usa el CLI de Codex, **no es una API
documentada de OpenAI**, así que puede cambiar o desaparecer sin aviso. Por eso
una ventana solo se etiqueta `5H`/`7D` cuando su longitud reportada coincide con
5 horas / 7 días; si el backend cambia, el segmento se descarta en lugar de
mostrar una etiqueta falsa. El token OAuth se lee de `auth.json` y se usa en
memoria; MiMoCode lo refresca ahí, de modo que la barra toma el vigente.

### Qué se recorta primero al estrecharse

`saldo/ventana` → detalle del contexto → longitud de la traza. La ventana `5H`
se mantiene aunque la barra se quede sin traza; `7D` solo se cae cuando no cabe
junto a `5H` (p. ej. por debajo de ~40 columnas de barra).
