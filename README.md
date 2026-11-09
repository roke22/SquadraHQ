<p align="center"><img src="branding/squadra-logo.svg" width="96" alt="SquadraHQ logo"></p>

<h1 align="center">SquadraHQ: multi-agent Claude Code with a coordinator and a live dashboard</h1>

<p align="center"><b>A coordinator agent that runs teams of Claude Code agents — fast, unattended, and visible live.</b></p>

<p align="center">
  <a href="https://github.com/roke22/SquadraHQ/releases"><img src="https://img.shields.io/github/v/release/roke22/SquadraHQ?label=release&color=C15F3C" alt="Latest release"></a>
  <a href="https://github.com/roke22/SquadraHQ/actions/workflows/test.yml"><img src="https://github.com/roke22/SquadraHQ/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/server%20dependencies-0-success" alt="Server has zero dependencies">
  <a href="https://github.com/roke22/SquadraHQ/stargazers"><img src="https://img.shields.io/github/stars/roke22/SquadraHQ?style=social" alt="GitHub stars"></a>
</p>

<p align="center"><a href="README-es.md">Leer en español</a> · <a href="https://roke22.github.io/SquadraHQ/">Website</a> · <a href="https://roke22.github.io/SquadraHQ/examples.html">Examples</a> · <a href="docs/reference.md">Reference</a> · <a href="https://github.com/roke22/SquadraHQ/discussions">Discussions</a> · v0.0.10</p>

---

SquadraHQ gives [Claude Code](https://claude.com/product/claude-code) a **coordinator**: you tell it what you want, and it splits the work among a team of **workers** (other Claude Code sessions), follows their progress, approves their safe actions and only comes back to you for the decisions that matter.

A web dashboard keeps what needs you in one inbox, shows each team with its plan, and opens a whole team live, like a wall of terminals: what each agent is doing, what Claude is saying, and who is waiting for you. From there you also add your computers and open new sessions on them.

Coordinators and workers can also be **Codex CLI** or **Grok CLI** sessions, mixed with Claude Code ones in the same team (experimental): see [Codex CLI and Grok CLI](#codex-cli-and-grok-cli-experimental).

SquadraHQ is **multi-agent orchestration for Claude Code**: parallel Claude Code sessions on one machine or many, coordinated by another Claude Code session, with a self-hosted web dashboard and web terminal to run and watch them from any browser. It is open source (MIT), a single Node.js server with no dependencies, and installs as a Claude Code plugin.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/inbox-dark-en.jpg"><img src="docs/screenshots/inbox-light-en.jpg" alt="The SquadraHQ inbox: a permission waiting and two decisions from the Development coordinator, one open with its options and the recommended one marked" width="1440"></picture>

## Quick start

```bash
git clone https://github.com/roke22/SquadraHQ.git squadra && cd squadra
git checkout "$(git tag --sort=-v:refname | head -1)"   # the latest release
node server/server.js          # dashboard at http://127.0.0.1:7787
```

Create the first owner with the server token it prints (you will need an authenticator app for the codes), open **Machines → Add machine** and run the one command it shows on each computer where agents should work. That's it: the details, Docker and HTTPS are in [steps 1 and 2](#1-install-the-dashboard) below.

### Just want to try it? Docker

One command starts the dashboard *and* a machine that runs Claude Code, in a single container. Everything it keeps (the dashboard's data, Claude Code's login, your projects) goes in one folder, `deploy/demo/squadra`.

**1. Start it** (the first time it builds the image, a few minutes):

```bash
cd deploy/demo
docker-compose up -d        # or: docker compose up -d
```

**2. Read the server token**, once it has started (some 20 seconds):

```bash
cat squadra/data/server-token
```

It is also in the logs, in the *Squadra demo* box: `docker-compose logs`. It stays the same when the container restarts.

**3. Create the first owner:** open **http://localhost:7787** and give the token, your name, email and a password; then add the code to your authenticator app. Then **New team** (the **+** next to *Your teams* in the sidebar) in the folder `/squadra/projects` with the subfolder `demo`, an example project with three personas. The first time, Claude Code asks in the session's terminal for its theme, your Claude login (`/login`) and whether you trust the folder; the login is kept for every later session.

To stop it, `docker-compose down` (the folder stays). To update it, `git fetch --tags && git checkout "$(git tag --sort=-v:refname | head -1)"` and then `docker-compose up -d --build`. Only this computer can reach it. More in [the demo's README](deploy/demo/README.md).

## What you can do with it

- **Build a feature across several repositories at once:** the backend, the web app and the mobile app, each with its own worker, kept in step by the coordinator.
- **Split a big job into parallel pieces:** a migration, a refactor or more tests, one worker per module.
- **Leave it working unattended:** workers decide the technical details and the coordinator approves their safe actions, so the team keeps going while you are away.
- **Keep watch from anywhere:** every team and agent live in your browser, on a phone too (add it to the home screen and it opens as an app), and everything that waits on you at the top of the inbox.
- **Decide from your inbox:** coordinators leave you the decisions that are yours, one question per decision with options and what they recommend, and tell you what finished or went wrong (which you can reply to as well); you answer from the dashboard picking an option (with a detail if you want) or in your own words, also by voice with the inbox read aloud, or dismiss a question and its coordinator is told not to wait.
- **Decide what each agent may do:** write a permission profile in your own words (edit files, run the tests, commit, but never push, say) and give it to a team or a session; it reaches Claude Code as real permission rules, as far as each machine allows.
- **Follow each team's plan:** the coordinator keeps the list of tasks it is working through, who has each one and its state, on the team's page.
- **See what each agent did without reading it all:** beside its terminal and its conversation, what it is doing now and a timeline of what mattered (its orders, the files it edited, tests and commits, permissions and reports), read from what it already reports, so it costs no tokens.
- **Use all your computers and accounts:** each agent runs on any machine you add, with that machine's Claude Code login.
- **Mix agents (experimental):** give a worker or a coordinator Codex CLI or Grok CLI instead of Claude Code; the dashboard marks each session with its agent (A, O, X) and the team works the same way.
- **Build teams with your own skills:** give each agent a skill or agent from its project (design, marketing, HR, code review…) as its persona, and save the whole team as a template to open it again in one click.
- **Link teams:** link the coordinators of two teams (design and marketing, say) so they share work, each handing what it takes on to its own workers.
- **See and shape your whole organisation:** the org chart shows every team, its agents and how teams are linked, with what each one is for on hover; add, describe, link, move and close them from there.

## How it works

```
                    you
                     │  talk in its terminal
             ┌───────┴────────┐
             │  coordinator   │  plans, delegates, approves, reports
             └───────┬────────┘
                     │  messages through squadra-server
      ┌──────────────┼──────────────┬──────────────┐
 ┌────┴─────┐   ┌────┴─────┐   ┌────┴─────┐   ┌────┴─────┐
 │ worker 1 │   │ worker 2 │   │ worker 3 │   │ worker N │   each one a Claude Code
 └──────────┘   └──────────┘   └──────────┘   └──────────┘   session, on any machine
```

- **The coordinator** is a Claude Code session with the coordinator role. It turns your request into tasks, assigns them to workers, answers their questions, approves harmless actions and escalates only what is critical. It keeps its plan on the team's page.
- **Workers** are Claude Code sessions with the worker role, each in its own project folder. They decide technical details themselves, and every task ends with a final report (done, blocked, failed or a question): Claude Code doesn't let them finish without it.
- **`squadra-server`** relays messages between agents and serves the dashboard. Agents connect *out* to it, so their machines open no ports.
- **The `squadra` plugin** delivers each message into the agent's session, even while it is idle, through Claude Code [Channels](https://code.claude.com/docs/en/channels), and reports what the agent is doing to the dashboard.

Every agent is a normal interactive `claude` in a terminal, so you can step in and type into any of them at any time.

## SquadraHQ vs Claude Code Agent Teams and subagents

Claude Code already has [subagents](https://code.claude.com/docs/en/sub-agents) and experimental Agent Teams. SquadraHQ is for when those stop being enough:

| | Subagents | Agent Teams | SquadraHQ |
|---|---|---|---|
| Agents run on | the same session | the same machine | any machine you add, each with its own Claude Code login |
| Watch them | in one terminal | one terminal each | one live web dashboard with every agent, from any browser |
| Unattended work | you approve each prompt | you approve each prompt | the coordinator approves safe actions, you only get the critical ones |
| Open and reopen sessions | manually | manually | from the dashboard, with a web terminal into each agent |
| Several repositories at once | no | the lead's directory | one worker per repository, on the machine that has it |

SquadraHQ adds to Claude Code rather than replacing it: subagents and Agent Teams still work inside each session.

## Codex CLI and Grok CLI (experimental)

Any coordinator or worker can run [Codex CLI](https://github.com/openai/codex) or [Grok CLI](https://x.ai/cli) instead of Claude Code: choose it for each session in **New team** or **New session** (the machine needs it: tick it in **Add machine**, or install it yourself). It runs the same SquadraHQ plugin and follows the same rules, with a few differences, since neither has Claude Code's Channels:

- **Messages are typed into its terminal between its turns.** A message that arrives while it works waits for the end of its turn, so a coordinator gives out its tasks and ends its turn, and its workers' reports come in as new turns.
- **Permission prompts** go to its coordinator as with Claude Code. The answer is typed into its terminal only when the prompt shows that very command on one line; a long command, one over several lines or a file edit is only announced, and answered in the terminal.
- **Clearing its context** for a new task starts the agent again in its terminal, with a new conversation. **Personas** go in as its instructions, without the agent's own list of tools. **Continue the last conversation** works as with Claude Code.
- **First start:** sign in on each machine (`codex login` and `grok login`; add `--device-auth` on a machine without a browser) and trust the folder. Codex also asks once to trust the SquadraHQ hooks, and again after an update that changes them. **Trusting a folder also trusts its own Codex or Grok settings, which can run code:** only do it for repositories you trust. A Grok session isn't opened where the project defines its own MCP server named `squadra`.

It is experimental: it works with the agents' current versions, but has had far less use than Claude Code. More in the [reference](docs/reference.md#codex-cli-and-grok-cli-experimental).

## What you need

- **A Claude Code account** with a claude.ai plan (Pro, Max, Team or Enterprise) or an Anthropic Console API key. On Team and Enterprise, an Owner enables *Channels* in the organization settings.
- **A computer for the dashboard,** with [Node.js 22](https://nodejs.org) or Docker. It can be the same computer where your agents run.

The computers where the agents run get everything else installed for them when you add them (see step 2). For Codex CLI or Grok CLI sessions, an account for that agent too.

## 1. Install the dashboard

```bash
git clone https://github.com/roke22/SquadraHQ.git squadra && cd squadra
git checkout "$(git tag --sort=-v:refname | head -1)"   # the latest release
node server/server.js
```

Open **http://127.0.0.1:7787** and create the first owner with the **server token** it prints the first time it starts (it stays in `data/server-token`). From then on you sign in with your email, password and a code. From **Settings**, at the bottom of the sidebar, you can invite others and add companies: see [Companies and people](docs/reference.md#companies-and-people).

**With Docker** instead:

```bash
docker build -f server/Dockerfile -t squadra-server .
docker run -d --name squadra-server -p 127.0.0.1:7787:7787 -e PUBLIC_URL=http://127.0.0.1:7787 -v squadra-data:/data squadra-server
docker logs squadra-server      # the first time, shows the server token (then: docker exec squadra-server cat /data/server-token)
```

**To use it from other computers,** give it a domain: point the domain to this computer, open ports 80 and 443, and start it with

```bash
node server/server.js --domain squadra.example.com --acme-email you@example.com
```

It gets and renews its HTTPS certificate by itself, and the dashboard is at `https://squadra.example.com`. (On Linux, ports 80 and 443 need privileges: run it with `sudo`, or use the Docker image with `-p 80:80 -p 443:443 -e SQUADRA_DOMAIN=squadra.example.com`.)

## 2. Add your computers

In the dashboard, open **Machines → Add machine** (or the **+** next to *Machines* in the sidebar). The page walks you through it: choose the computer's system (Linux, macOS or Windows) and the agents to install there (Claude Code, and Codex CLI or Grok CLI if you want them), and run the single command it shows on that computer. It installs everything it needs and connects it to your dashboard; the page says when it has connected and lets you choose its folders right there.

Then, still in the dashboard:

1. **Add folder**, on that page once it has connected or under the machine on the *Machines* page: choose the folders where agents may work (your projects).
2. **Open your first team** ([step 3](#3-build-your-teams)), or a single session with **Machines → New session**. Each one opens in a live terminal in your browser. The first time, accept Claude Code's prompts (for the development channel, choose *"I am using this for local development"*). Codex CLI and Grok CLI ask you to sign in once on each machine (`codex login`, `grok login`) and to trust the folder.
3. **Talk to the coordinator** in its terminal (**Give an order** on its team's page takes you there) and tell it what you want done.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/live-dark-en.jpg"><img src="docs/screenshots/live-light-en.jpg" alt="A team all at once: the coordinator's terminal and its workers' conversations side by side" width="1440"></picture>

## 3. Build your teams

A team is a coordinator and its workers, like a department. **New team** (the **+** next to *Your teams* in the sidebar, or the button on **Teams**) opens a page with four steps:

1. **What it is for:** the team's **name** and its **goal**. The coordinator is told both, and puts its effort there.
2. **Who:** a coordinator and workers, just a coordinator, or a template you saved. Each session gets a name (one worker per area or repository: `copy`, `design`, `ads`), its agent if the machine has more than one (Claude Code, Codex CLI or Grok CLI) and, if the folder has skills or agents, a **persona**.
3. **Where:** the machine and the folder.
4. **Open it:** the coordinator opens first, then each worker, and you land on the team's page.

Then:

- **Give it its first order:** **Give an order** on the team's page. Once the coordinator splits the work, the page shows its plan: each task, who has it and its state (to do, in progress, done, blocked, waiting on you), with its workers' latest reports below. **Add a worker** adds one later.

  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/team-dark-en.jpg"><img src="docs/screenshots/team-light-en.jpg" alt="A team's page: its plan with three of seven tasks done, one in progress, one blocked and one waiting on you, and its workers' latest reports" width="1440"></picture>

- **Link the teams that need each other:** in **Teams → Org chart**, drag the dot on a card's right edge onto another card (or **Manage links** on a team's page). Linked coordinators ask each other for work (marketing asks product for the landing page, product tells marketing what ships), and each hands what it takes on to its own workers.
- **Save each team as a template:** **Save as template** on its page. **Machines → Templates → Open team** opens it all again, coordinator first, and **New team** can start from it.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/org-chart-dark-en.jpg"><img src="docs/screenshots/org-chart-light-en.jpg" alt="The SquadraHQ org chart: the Development, QA and Content teams, each coordinator with its workers" width="1440"></picture>

The **[examples](https://roke22.github.io/SquadraHQ/examples.html)** show whole organisations built this way: a marketing agency, a personal brand on social media, a software company and a product launch, with the teams, personas, links and first message for each. Everything the org chart does is in the [reference](docs/reference.md#org-chart).

## Good tips

- **Use HTTPS** (a domain, step 1) when other computers connect to your dashboard, and keep the server token to yourself: it creates the first owner, recovers access and always works on `/admin`: it's the key to the dashboard.
- **Give your coordinator its own repository** with a `CLAUDE.md` describing your team: which worker handles which repository, what counts as done, and what it must always ask you first. Every coordinator you open from it then works the same way.
- **Name workers after what they do** (`api`, `web`, `docs`): the coordinator uses the names to decide who gets each task.
- **Give each worker a persona:** in **New team** or **New session**, pick one of the skills (`.claude/skills/<name>/SKILL.md`) or agents (`.claude/agents/<name>.md`) the machine finds in that folder or in `~/.claude`. It goes into the agent's system prompt, so it holds through compactions, and its coordinator is told which persona each worker follows.
- **One worker per repository or area,** so they don't edit the same files. For parallel work in one repository, give each worker its own [git worktree](https://git-scm.com/docs/git-worktree).
- **Open your own projects,** or repositories you trust, in the agents' folders. Claude Code, Codex CLI and Grok CLI all apply a trusted folder's own settings.
- **Leave room in the context:** with 1M-context models, the dashboard's default of auto-compacting at 600K tokens keeps agents sharp.
- **Press Ctrl+K** (⌘K on a Mac) to go to any session, team, inbox entry or screen, or to open an action, by typing a few letters.

## Updating

Update the dashboard to the latest release (`git fetch --tags && git checkout "$(git tag --sort=-v:refname | head -1)"`) and start it again, or rebuild the Docker image from there. Then run `squadra-host update` on each computer. The dashboard tells you which ones are out of date.

**From 0.0.7:** what the dashboard held becomes its first company, and computers and sessions keep working as they are. The first time you open it, the server token creates the first owner; after that you sign in with email, password and code, and the token no longer opens the dashboard (`--allow-token-api` keeps it working on `/api` for your scripts). Run `squadra-host update` on each computer and open its sessions again to get the new features, such as the inbox and the team plan; computers not updated keep working without them. The repository is now `roke22/SquadraHQ`: the old address still works, and each computer moves to the new one when it updates.

## FAQ

**What does the coordinator approve on its own, and what does it ask me?**
It approves what has no side effects: reading files, searching, running tests and local builds. Anything destructive, irreversible or with effects outside the machine (deleting data, force pushes, deploying, publishing, spending money, credentials) it asks you first in your inbox, as do product decisions and anything about security or costs. Workers decide technical details themselves. The rules live in the plugin's instructions and in your coordinator's `CLAUDE.md`, so you can tighten them.

**Does it work with my Claude plan?**
Yes, with any claude.ai plan that includes Claude Code (Pro, Max, Team, Enterprise) or with an Anthropic Console API key. Each agent is a normal Claude Code session on its machine, with that machine's login, so it counts against that account like any other session.

**What does the "add machine" command install?**
What is missing among tmux, Node.js 22 and Claude Code (and Codex CLI, with npm, or Grok CLI, with its own installer, if you ticked them), then `squadra-host`: a small Node program that connects the machine to your server, installs the `squadra` plugin and stays running as a user service. The script is [install/linux.sh](install/linux.sh) (and [macos.sh](install/macos.sh), [windows.bat](install/windows.bat)); the command checks it against your server's copy before running it.

**What leaves my machines?**
Only what goes to **your** SquadraHQ server: messages between agents, presence, and what you choose to show in the dashboard (`--observe off|activity|full`). Recognisable secrets are masked, and files from credentials folders are never sent. Nothing goes to any other service. Details in the [plugin README](plugins/squadra/README.md).

**Do I need to open ports on the machines where agents run?**
No. Agents connect out to the server. Only the server needs to be reachable, and with a domain it gets its own HTTPS certificate.

**Can I use Codex CLI or Grok CLI instead of Claude Code?**
Yes, session by session, as an experimental option: see [Codex CLI and Grok CLI](#codex-cli-and-grok-cli-experimental). Each one uses its own account on its machine.

**Is it a replacement for Agent Teams or subagents?**
No, it works alongside them: those run inside one session on one machine; SquadraHQ coordinates whole sessions across machines and lets the team keep going without you watching.

**Why the "development channel" flag?**
Channels are the Claude Code feature that delivers messages into a session. Until the plugin is in Anthropic's directory, Claude Code asks you to confirm loading a channel plugin the first time. Choose *"I am using this for local development"*.

## Learn more

- [Examples](https://roke22.github.io/SquadraHQ/examples.html): marketing, social media, software and launch organisations, team by team.
- [docs/reference.md](docs/reference.md): setting agents up by hand without the dashboard, every server option, and how it all works.
- [PLAN.md](PLAN.md): the full technical guide (Spanish).

## Contributing

Bugs and ideas go to [Issues](https://github.com/roke22/SquadraHQ/issues); questions and show-and-tell to [Discussions](https://github.com/roke22/SquadraHQ/discussions). See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the tests and send a pull request. If SquadraHQ is useful to you, a star on GitHub helps other people find it.

## License

[MIT](LICENSE) — free to use, copy, modify and distribute, for any purpose.
