# pisha-server

The server of [Pisha](https://github.com/roke22/pisha): teams of AI coding agents (Claude Code, Codex CLI, Grok CLI), each team run by a coordinator, on any of your machines, with a self-hosted dashboard, a web terminal and an inbox for what is yours to decide.

No dependencies: only Node.js 22.13 or later.

## Start it

```bash
npx pisha-server
```

Or install the command:

```bash
npm install -g pisha-server
pisha-server
```

Open **http://127.0.0.1:7787**, create the first owner with the server token it prints the first time (you will need an authenticator app for the codes), then **Machines → Add machine** gives you the command for each computer where you want agents.

Everything it keeps is in `~/.pisha` (`--data-dir` or `DATA_DIR` to put it elsewhere).

## On a server, with HTTPS

```bash
pisha-server --domain pisha.example.com --acme-email you@example.com
```

It gets and renews its own certificate (Let's Encrypt). `pisha-server --help` lists every option.

## With Docker

```bash
docker run -d --name pisha -p 7787:7787 -v pisha-data:/data ghcr.io/roke22/pisha
docker logs pisha    # the server token, the first time
```

## More

Everything else, from adding machines to permission profiles and task boards, is in the [reference](https://github.com/roke22/pisha/blob/main/docs/reference.md). MIT licensed.
