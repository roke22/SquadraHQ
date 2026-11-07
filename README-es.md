<p align="center"><img src="branding/squadra-logo.svg" width="96" alt="Logo de SquadraHQ"></p>

<h1 align="center">SquadraHQ: Claude Code multiagente con un coordinador y un panel en directo</h1>

<p align="center"><b>Un agente coordinador que dirige equipos de agentes de Claude Code: rápido, desatendido y a la vista en directo.</b></p>

<p align="center">
  <a href="https://github.com/roke22/Squadra/releases"><img src="https://img.shields.io/github/v/release/roke22/Squadra?label=release&color=C15F3C" alt="Última versión"></a>
  <a href="https://github.com/roke22/Squadra/actions/workflows/test.yml"><img src="https://github.com/roke22/Squadra/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="Licencia MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/server%20dependencies-0-success" alt="El servidor no tiene dependencias">
  <a href="https://github.com/roke22/Squadra/stargazers"><img src="https://img.shields.io/github/stars/roke22/Squadra?style=social" alt="Estrellas en GitHub"></a>
</p>

<p align="center"><a href="README.md">Read in English</a> · <a href="https://roke22.github.io/Squadra/">Web</a> · <a href="https://roke22.github.io/Squadra/es/ejemplos.html">Ejemplos</a> · <a href="docs/referencia.md">Referencia</a> · <a href="https://github.com/roke22/Squadra/discussions">Discussions</a> · v0.0.7</p>

---

SquadraHQ le da a [Claude Code](https://claude.com/product/claude-code) un **coordinador**: le dices lo que quieres y él reparte el trabajo entre un equipo de **workers** (otras sesiones de Claude Code), sigue cómo avanzan, aprueba sus acciones seguras y solo vuelve a ti para las decisiones importantes.

Un panel web reúne en una bandeja lo que te necesita, muestra cada equipo con su plan y abre un equipo entero en directo, como una pared de terminales: qué hace cada agente, qué dice Claude y quién te está esperando. Desde ahí también añades tus ordenadores y abres sesiones nuevas en ellos.

SquadraHQ es **orquestación multiagente para Claude Code**: varias sesiones de Claude Code en paralelo, en una máquina o en varias, coordinadas por otra sesión de Claude Code, con un panel web autoalojado y una terminal web para lanzarlas y vigilarlas desde cualquier navegador. Es código abierto (MIT), un único servidor Node.js sin dependencias, y se instala como plugin de Claude Code.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/inbox-dark-es.jpg"><img src="docs/screenshots/inbox-light-es.jpg" alt="La bandeja de SquadraHQ: un permiso pendiente y dos decisiones del coordinador de Desarrollo, una abierta con sus opciones y la recomendada marcada" width="1440"></picture>

## Inicio rápido

```bash
git clone https://github.com/roke22/Squadra.git squadra && cd squadra
git checkout "$(git tag --sort=-v:refname | head -1)"   # la última versión
node server/server.js          # panel en http://127.0.0.1:7787
```

Crea el primer propietario con el token del servidor que muestra (necesitarás una app de autenticación para los códigos), abre **Máquinas → + Añadir máquina** y ejecuta el comando que te enseña en cada ordenador donde quieras agentes. Eso es todo: los detalles, Docker y HTTPS están en los [pasos 1 y 2](#1-instala-el-panel).

### ¿Solo quieres probarlo? Docker

Un comando arranca el panel *y* una máquina que ejecuta Claude Code, en un solo contenedor. Todo lo que guarda (los datos del panel, el login de Claude Code, tus proyectos) va en una carpeta, `deploy/demo/squadra`.

**1. Arráncalo** (la primera vez construye la imagen, unos minutos):

```bash
cd deploy/demo
docker-compose up -d        # o bien: docker compose up -d
```

**2. Lee el token para entrar**, cuando haya arrancado (unos 20 segundos):

```bash
cat squadra/data/server-token
```

También aparece en los logs, en el recuadro *Squadra demo*: `docker-compose logs`. Es siempre el mismo aunque reinicies el contenedor.

**3. Crea el primer propietario:** abre **http://localhost:7787** y escribe el token, tu nombre, tu email y una contraseña; luego añade el código a tu app de autenticación. Después, **Nuevo equipo** (el **+** junto a *Tus equipos* en la barra lateral) en la carpeta `/squadra/projects` con la subcarpeta `demo`, un proyecto de ejemplo con tres personas. La primera vez, Claude Code pide en el terminal de la sesión el tema, tu login de Claude (`/login`) y si confías en la carpeta; el login se guarda para todas las sesiones siguientes.

Para pararlo, `docker-compose down` (la carpeta se queda). Para actualizarlo, `git fetch --tags && git checkout "$(git tag --sort=-v:refname | head -1)"` y después `docker-compose up -d --build`. Solo este ordenador puede acceder. Más en [el README de la demo](deploy/demo/README-es.md).

## Qué puedes hacer con él

- **Hacer una funcionalidad en varios repositorios a la vez:** el backend, la web y la app móvil, cada uno con su worker, coordinados entre sí.
- **Partir un trabajo grande en piezas en paralelo:** una migración, una refactorización o más tests, un worker por módulo.
- **Dejarlo trabajando solo:** los workers deciden los detalles técnicos y el coordinador aprueba sus acciones seguras, así el equipo sigue mientras no estás.
- **Vigilarlo desde cualquier sitio:** todos los equipos y agentes en directo en tu navegador, también en el móvil, y todo lo que te espera arriba en la bandeja.
- **Decidir desde tu bandeja:** los coordinadores te dejan las decisiones que son tuyas, una pregunta por decisión con opciones y lo que recomiendan, y te cuentan lo que terminó o salió mal; respondes desde el panel con una tecla numérica o con tus palabras.
- **Seguir el plan de cada equipo:** el coordinador mantiene en la página del equipo la lista de tareas en las que trabaja, quién lleva cada una y en qué estado está.
- **Usar todos tus ordenadores y cuentas:** cada agente funciona en cualquier máquina que añadas, con la sesión de Claude Code de esa máquina.
- **Montar equipos con tus propias skills:** dale a cada agente una skill o un agente de su proyecto (diseño, marketing, RR. HH., revisión de código…) como persona, y guarda todo el equipo como plantilla para volver a abrirlo de un clic.
- **Enlazar equipos:** enlaza los coordinadores de dos equipos (por ejemplo, diseño y marketing) para que se repartan trabajo, y cada uno lo pase a sus propios workers.
- **Ver y montar toda tu organización:** el organigrama muestra cada equipo, sus agentes y cómo se enlazan, con para qué sirve cada uno al pasar el ratón; desde ahí se añaden, describen, enlazan, mueven y cierran.

## Cómo funciona

```
                     tú
                     │  hablas en su terminal
             ┌───────┴────────┐
             │  coordinador   │  planifica, delega, aprueba, informa
             └───────┬────────┘
                     │  mensajes a través de squadra-server
      ┌──────────────┼──────────────┬──────────────┐
 ┌────┴─────┐   ┌────┴─────┐   ┌────┴─────┐   ┌────┴─────┐
 │ worker 1 │   │ worker 2 │   │ worker 3 │   │ worker N │   cada uno una sesión de
 └──────────┘   └──────────┘   └──────────┘   └──────────┘   Claude Code, en cualquier máquina
```

- **El coordinador** es una sesión de Claude Code con el rol de coordinador. Convierte tu petición en tareas, las asigna a los workers, responde sus preguntas, aprueba las acciones inofensivas y solo te escala lo crítico. Mantiene su plan en la página del equipo.
- **Los workers** son sesiones de Claude Code con el rol de worker, cada una en su carpeta de proyecto. Deciden los detalles técnicos solas, y cada tarea termina con un informe final (hecho, bloqueado, fallido o una pregunta): Claude Code no las deja terminar sin él.
- **`squadra-server`** pasa los mensajes entre agentes y sirve el panel. Los agentes se conectan *hacia fuera*, así que sus máquinas no abren puertos.
- **El plugin `squadra`** entrega cada mensaje dentro de la sesión del agente, incluso cuando está parada, mediante los [Channels](https://code.claude.com/docs/en/channels) de Claude Code, y cuenta al panel qué está haciendo el agente.

Cada agente es un `claude` interactivo normal en una terminal, así que puedes entrar y escribir en cualquiera en cualquier momento.

## SquadraHQ frente a los Agent Teams y subagentes de Claude Code

Claude Code ya tiene [subagentes](https://code.claude.com/docs/en/sub-agents) y los Agent Teams experimentales. SquadraHQ es para cuando se quedan cortos:

| | Subagentes | Agent Teams | SquadraHQ |
|---|---|---|---|
| Los agentes corren en | la misma sesión | la misma máquina | cualquier máquina que añadas, cada una con su sesión de Claude Code |
| Verlos | en una terminal | una terminal por agente | un panel web en directo con todos los agentes, desde cualquier navegador |
| Trabajo desatendido | apruebas cada aviso | apruebas cada aviso | el coordinador aprueba las acciones seguras, a ti solo te llegan las críticas |
| Abrir y reabrir sesiones | a mano | a mano | desde el panel, con una terminal web a cada agente |
| Varios repositorios a la vez | no | el directorio del lead | un worker por repositorio, en la máquina que lo tiene |

SquadraHQ se suma a Claude Code en vez de sustituirlo: los subagentes y los Agent Teams siguen funcionando dentro de cada sesión.

## Qué necesitas

- **Una cuenta de Claude Code** con un plan de claude.ai (Pro, Max, Team o Enterprise) o una clave de API de Anthropic Console. En Team y Enterprise, un Owner activa *Channels* en los ajustes de la organización.
- **Un ordenador para el panel,** con [Node.js 22](https://nodejs.org) o Docker. Puede ser el mismo ordenador donde trabajan tus agentes.

En los ordenadores donde trabajan los agentes se instala todo lo demás solo, al añadirlos (paso 2).

## 1. Instala el panel

```bash
git clone https://github.com/roke22/Squadra.git squadra && cd squadra
git checkout "$(git tag --sort=-v:refname | head -1)"   # la última versión
node server/server.js
```

Abre **http://127.0.0.1:7787** y crea el primer propietario con el **token del servidor** que muestra la primera vez que arranca (queda en `data/server-token`). A partir de ahí entras con tu email, tu contraseña y un código. Desde **Ajustes**, abajo en la barra lateral, puedes invitar a otros y añadir empresas: mira [Empresas y personas](docs/referencia.md#empresas-y-personas).

**Con Docker**, en su lugar:

```bash
docker build -f server/Dockerfile -t squadra-server .
docker run -d --name squadra-server -p 127.0.0.1:7787:7787 -e PUBLIC_URL=http://127.0.0.1:7787 -v squadra-data:/data squadra-server
docker logs squadra-server      # la primera vez, muestra el token del servidor (después: docker exec squadra-server cat /data/server-token)
```

**Para usarlo desde otros ordenadores,** dale un dominio: apunta el dominio a este ordenador, abre los puertos 80 y 443, y arráncalo con

```bash
node server/server.js --domain squadra.example.com --acme-email tu@example.com
```

Consigue y renueva su certificado HTTPS solo, y el panel queda en `https://squadra.example.com`. (En Linux, los puertos 80 y 443 necesitan privilegios: arráncalo con `sudo`, o usa la imagen de Docker con `-p 80:80 -p 443:443 -e SQUADRA_DOMAIN=squadra.example.com`.)

## 2. Añade tus ordenadores

En el panel, abre **Máquinas → + Añadir máquina** (o el **+** junto a *Máquinas* en la barra lateral), elige el sistema del ordenador (Linux, macOS o Windows) y **sigue las instrucciones que te muestra**: es un único comando para ejecutar en ese ordenador. Instala todo lo que necesita y lo conecta a tu panel.

Después, desde el panel:

1. **+ Carpeta** debajo de la máquina, en la página *Máquinas*: elige las carpetas donde pueden trabajar los agentes (tus proyectos).
2. **Abre tu primer equipo** ([paso 3](#3-monta-tus-equipos)), o una sesión suelta con **Máquinas → + Nueva sesión**. Cada una se abre en una terminal en directo en tu navegador. La primera vez, acepta los avisos de Claude Code (para el canal de desarrollo, elige *"I am using this for local development"*).
3. **Habla con el coordinador** en su terminal (**Dar una orden** en la página de su equipo te lleva allí) y dile lo que quieres hacer.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/live-dark-es.jpg"><img src="docs/screenshots/live-light-es.jpg" alt="Un equipo a la vez: la terminal del coordinador y las de sus workers, una al lado de otra" width="1440"></picture>

## 3. Monta tus equipos

Un equipo es un coordinador y sus workers, como un departamento. **Nuevo equipo** (el **+** junto a *Tus equipos* en la barra lateral, o el botón de **Equipos**) abre una página con cuatro pasos:

1. **Para qué es:** el **nombre** del equipo y su **objetivo**. El coordinador recibe los dos y pone su esfuerzo ahí.
2. **Quiénes:** coordinador y workers, solo un coordinador, o una plantilla que hayas guardado. Cada sesión lleva un nombre (un worker por área o repositorio: `copy`, `design`, `ads`) y, si la carpeta tiene skills o agentes, una **persona**.
3. **Dónde:** la máquina y la carpeta.
4. **Abrirlo:** primero se abre el coordinador y después cada worker, y llegas a la página del equipo.

Después:

- **Dale su primera orden:** **Dar una orden** en la página del equipo. Cuando el coordinador reparte el trabajo, la página muestra su plan: cada tarea, quién la lleva y su estado (pendiente, en curso, hecha, bloqueada, espera tu decisión), con los últimos informes de sus workers debajo. **Añadir worker** añade uno más tarde.

  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/team-dark-es.jpg"><img src="docs/screenshots/team-light-es.jpg" alt="La página de un equipo: su plan con tres de siete tareas hechas, una en curso, una bloqueada y una que espera tu decisión, y los últimos informes de sus workers" width="1440"></picture>

- **Enlaza los equipos que se necesitan:** en **Equipos → Organigrama**, arrastra el punto del borde derecho de una tarjeta hasta otra (o **Gestionar enlaces** en la página de un equipo). Los coordinadores enlazados se piden trabajo entre ellos (marketing le pide la landing a producto, producto le cuenta a marketing qué sale), y cada uno pasa lo que asume a sus propios workers.
- **Guarda cada equipo como plantilla:** **Guardar como plantilla** en su página. **Máquinas → Plantillas → Abrir el equipo** lo vuelve a abrir entero, primero el coordinador, y **Nuevo equipo** puede empezar desde ella.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/org-chart-dark-es.jpg"><img src="docs/screenshots/org-chart-light-es.jpg" alt="El organigrama de SquadraHQ: los equipos de Desarrollo, QA y Contenidos, cada coordinador con sus workers" width="1440"></picture>

Los **[ejemplos](https://roke22.github.io/Squadra/es/ejemplos.html)** muestran organizaciones completas montadas así: una agencia de marketing, una marca personal en redes sociales, una empresa de software y el lanzamiento de un producto, con los equipos, las personas, los enlaces y el primer mensaje de cada uno. Todo lo que hace el organigrama está en la [referencia](docs/referencia.md#organigrama).

## Buenos consejos

- **Usa HTTPS** (un dominio, paso 1) cuando otros ordenadores se conecten a tu panel, y guarda el token del servidor solo para ti: crea el primer propietario, recupera el acceso y siempre vale en `/admin`.
- **Dale al coordinador su propio repositorio** con un `CLAUDE.md` que describa tu equipo: qué worker lleva cada repositorio, cuándo una tarea está terminada y qué debe consultarte siempre. Así cada coordinador que abras desde él trabaja igual.
- **Pon a los workers nombres de lo que hacen** (`api`, `web`, `docs`): el coordinador los usa para decidir a quién da cada tarea.
- **Dale una persona a cada worker:** en **Nuevo equipo** o en **+ Nueva sesión**, elige una de las skills (`.claude/skills/<nombre>/SKILL.md`) o agentes (`.claude/agents/<nombre>.md`) que la máquina encuentra en esa carpeta o en `~/.claude`. Va en el system prompt del agente, así que se mantiene tras las compactaciones, y su coordinador sabe qué persona sigue cada worker.
- **Un worker por repositorio o por área,** para que no editen los mismos ficheros. Para trabajar en paralelo en un mismo repositorio, dale a cada worker su propio [git worktree](https://git-scm.com/docs/git-worktree).
- **Abre tus propios proyectos,** o repositorios de confianza, en las carpetas de los agentes.
- **Deja espacio en el contexto:** con modelos de 1M de contexto, el autocompactado a 600K tokens que trae el panel por defecto mantiene a los agentes en forma.
- **Pulsa Ctrl+K** (⌘K en un Mac) para ir a cualquier sesión, equipo, entrada de la bandeja o pantalla, o para abrir una acción, escribiendo unas letras.

## Actualizar

Actualiza el panel a la última versión (`git fetch --tags && git checkout "$(git tag --sort=-v:refname | head -1)"`) y arráncalo de nuevo, o reconstruye la imagen de Docker desde ahí. Después ejecuta `squadra-host update` en cada ordenador. El panel te dice cuáles están desactualizados.

**Desde 0.0.7:** lo que tenía el panel pasa a ser su primera empresa, y los ordenadores y las sesiones siguen funcionando como estaban. La primera vez que lo abres, el token del servidor crea el primer propietario; después entras con email, contraseña y código, y el token ya no abre el panel (`--allow-token-api` lo mantiene en `/api` para tus scripts). Ejecuta `squadra-host update` en cada ordenador y vuelve a abrir sus sesiones para tener lo nuevo, como la bandeja y el plan del equipo; los ordenadores sin actualizar siguen funcionando sin ello.

## Preguntas frecuentes

**¿Qué aprueba el coordinador por su cuenta y qué me pregunta?**
Aprueba lo que no tiene efectos secundarios: leer ficheros, buscar, ejecutar tests y compilaciones locales. Todo lo destructivo, irreversible o con efectos fuera de la máquina (borrar datos, force push, desplegar, publicar, gastar dinero, credenciales) te lo pregunta antes en tu bandeja, igual que las decisiones de producto y lo relativo a seguridad o costes. Los workers deciden los detalles técnicos solos. Las reglas están en las instrucciones del plugin y en el `CLAUDE.md` de tu coordinador, así que puedes endurecerlas.

**¿Funciona con mi plan de Claude?**
Sí, con cualquier plan de claude.ai que incluya Claude Code (Pro, Max, Team, Enterprise) o con una clave de API de Anthropic Console. Cada agente es una sesión normal de Claude Code en su máquina, con la sesión de esa máquina, así que consume de esa cuenta como cualquier otra sesión.

**¿Qué instala el comando de "añadir máquina"?**
Lo que falte de tmux, Node.js 22 y Claude Code, y después `squadra-host`: un pequeño programa Node que conecta la máquina a tu servidor, instala el plugin `squadra` y se queda en marcha como servicio de usuario. El script es [install/linux.sh](install/linux.sh) (y [macos.sh](install/macos.sh), [windows.bat](install/windows.bat)); el comando lo comprueba contra la copia de tu servidor antes de ejecutarlo.

**¿Qué sale de mis máquinas?**
Solo lo que va a **tu** servidor SquadraHQ: los mensajes entre agentes, la presencia y lo que elijas mostrar en el panel (`--observe off|activity|full`). Los secretos reconocibles se enmascaran y los ficheros de carpetas de credenciales nunca se envían. Nada va a ningún otro servicio. Detalles en el [README del plugin](plugins/squadra/README.md).

**¿Tengo que abrir puertos en las máquinas de los agentes?**
No. Los agentes se conectan hacia fuera, al servidor. Solo el servidor tiene que ser accesible, y con un dominio consigue su propio certificado HTTPS.

**¿Sustituye a los Agent Teams o a los subagentes?**
No, convive con ellos: esos funcionan dentro de una sesión en una máquina; SquadraHQ coordina sesiones enteras entre máquinas y deja que el equipo siga sin que lo vigiles.

**¿Por qué el aviso de "development channel"?**
Los Channels son la función de Claude Code que entrega mensajes dentro de una sesión. Hasta que el plugin esté en el directorio de Anthropic, Claude Code te pide confirmar la primera vez que cargas un plugin de canal. Elige *"I am using this for local development"*.

## Saber más

- [Ejemplos](https://roke22.github.io/Squadra/es/ejemplos.html): organizaciones de marketing, redes sociales, software y lanzamiento, equipo a equipo.
- [docs/referencia.md](docs/referencia.md): configurar agentes a mano sin el panel, todas las opciones del servidor y cómo funciona todo por dentro.
- [PLAN.md](PLAN.md): la guía técnica completa.

## Contribuir

Los errores y las ideas van a [Issues](https://github.com/roke22/Squadra/issues); las preguntas y lo que hayas montado con SquadraHQ, a [Discussions](https://github.com/roke22/Squadra/discussions). En [CONTRIBUTING.md](CONTRIBUTING.md) está cómo ejecutar los tests y enviar un pull request. Si SquadraHQ te resulta útil, una estrella en GitHub ayuda a que lo encuentre más gente.

## Licencia

[MIT](LICENSE): libre para usar, copiar, modificar y distribuir, para cualquier fin.
