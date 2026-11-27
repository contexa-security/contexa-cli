# Contexa CLI

Adds [Contexa](https://docs.ctxa.ai/) to a Spring Boot 3.5 application and gets it running.

```bash
cd your-spring-boot-project
contexa init
```

That is the whole installation. `contexa init` asks one question (which AI model to use), shows
what it will change, prepares a local database and AI model, changes the project, checks that the
dependencies download, and offers to start the application to confirm it works.

---

## Install the CLI

Linux / macOS:

```bash
curl -fsSL https://install.ctxa.ai | sh
```

Windows (PowerShell):

```powershell
irm https://install.ctxa.ai/install.ps1 | iex
```

The installer verifies the signed release and its checksum before it replaces anything. Prebuilt
binaries exist for Linux x64, macOS Apple Silicon and Windows x64.

## Requirements

| What | Why |
|---|---|
| Java 17 or newer | Spring Boot 3 and Contexa |
| A Spring Boot **3.5.x** application | Contexa 0.1.x does not start on 3.4 and older, and does not support Spring Boot 4 yet. `contexa init` stops before changing anything if it finds another version |
| Docker (Docker Desktop on Windows/macOS) | Runs the local PostgreSQL with pgvector. Not needed with `--db-url` |
| Ollama, or an OpenAI / Anthropic API key | The AI model. Without a running Ollama, Contexa starts one in Docker |

No project yet? Run `contexa init` in an empty folder: it creates a small Spring Boot 3.5
application with Contexa and sample sign-in accounts. (start.spring.io only creates Spring Boot 4
projects now.)

---

## What `contexa init` does

In your project:

- Adds `ai.ctxa:spring-boot-starter-contexa`, `spring-boot-starter-security`, the Spring AI BOM, the
  model starter and the PgVector starter to the build file (Maven, Gradle Groovy or Kotlin DSL, also
  inside multi-module builds). The Contexa starter alone changes nothing in an application:
  `@EnableAISecurity` is the decision to apply security, and Spring Security is what applies it.
- Adds `@EnableAISecurity` to the `@SpringBootApplication` class, after showing the security mode
  and what it means (see [Security mode](#security-mode)):
  - without an option → `@EnableAISecurity` (SANDBOX, the default: Contexa is kept apart from your
    application, whose sign-in, authorization and security settings stay as they are; if your
    `SecurityFilterChain` signs in with Spring Boot's default user, which the starter would turn
    off, that user `user` is kept with a password made once and kept in
    `~/.contexa/credentials.properties`);
  - `--mode full` → `@EnableAISecurity(mode = SecurityMode.FULL)` (Contexa is your application's
    main security: sign-in, authorization and security settings);
  - the sample application created in an empty folder → FULL without an option, since it has no
    sign-in of its own (`--mode sandbox` keeps it apart instead);
  - an `@EnableAISecurity` already in your application is left as it is, with its mode.
- Writes Contexa's settings to `src/main/resources/config/application.yml`. Spring Boot reads that
  file by itself, so your own `application.yml` / `application.properties` stay unchanged. Keys you
  already set yourself are never written there.

On this computer (shared by all your projects):

- A PostgreSQL with pgvector in Docker (`contexa-local-postgres`, on a free port such as 55432),
  with a database of its own for each project.
- Ollama: the one already running on your computer, or one started in Docker. The models are
  downloaded once.
- A local mail inbox (Mailpit) that receives Contexa's one-time codes (the second sign-in step of
  the admin console in both modes and of Contexa's sign-in with FULL, the additional verification of
  a CHALLENGE with SANDBOX), so they work without a mail server.
- A password for the admin-console account `admin`, kept in `~/.contexa/credentials.properties`
  (outside the project) and shown at the end. Contexa creates the account when the application
  first starts. With SANDBOX, this is Contexa's own administrator for the console, apart from your
  application's accounts. The example application created in an empty folder uses the sample
  accounts (`admin` / `1111`).

Contexa starts in **SHADOW** mode: it analyses and records requests but blocks nothing yet. Change
`contexa.security.zerotrust.mode` to `ENFORCE` (or switch it in the admin console) once you have
reviewed its decisions.

Running `contexa init` again is safe; it checks what is in place and adds only what is missing.

### Security mode

Before it changes anything, `contexa init` shows the security mode and what it means. Both modes run
every feature of Contexa; they differ in what Contexa's security settings do to your application:

| | SANDBOX (default) | FULL |
|---|---|---|
| Chosen when | no option is given | `--mode full`, or no option for the sample application created in an empty folder |
| Sign-in, sessions, cookies, security settings | your application, as now (Contexa does not change them; it reads who signed in and decides) | Contexa (sign-in page, passkey, one-time code) |
| Risk decisions and their enforcement on every path (block screen, additional verification, agent gate) | Contexa | Contexa, the same |
| Contexa console `/contexa/admin` | Contexa's own administrator account, apart from your users: the password, then a code by mail or a passkey | Contexa's administrator account, on Contexa's sign-in page: the password, then a code by mail or a passkey |

With SANDBOX, a CHALLENGE sends the user to Contexa's additional verification (`/contexa/step-up`:
a passkey, or a one-time code by mail); your application's sign-in and session stay as they were.
An application with neither a `SecurityFilterChain` nor users of its own gets Contexa's isolation
chain, which lets every request through, so its access stays as it is (one that relied on Spring
Boot's default security and its `user` no longer asks for that sign-in: declare a chain to keep it);
one with users of its own
but no chain keeps Spring Boot's default security, which asks every request to sign in, and Contexa
warns about it at the start.
An application that signs its users in without Spring Security tells Contexa who signed in with one
`ContexaSubjectResolver` bean, or puts a `ContexaSubject` in the request attribute `ctxa.subject`
from its own filter.

With FULL, Contexa's main chain takes every request. An application chain narrowed to its own paths
with `http.securityMatcher(...)` takes those paths first and runs alongside; an application chain
that takes every request cannot run with it, and the application does not start. The CLI says so
before it changes anything.

The CLI writes no authentication ownership (`contexa.bridge.ownership`). Left out, it follows the
mode (SANDBOX → `HOST_OWNED`, FULL → `CONTEXA_OWNED`); it only settles whose component the
application gets where your application and Contexa bring one of the same kind (a
`UserDetailsService`, a `JwtDecoder`), and it turns no feature off.

### Options

Everything is asked interactively; options are for scripts and CI.

| Option | Meaning |
|---|---|
| `--provider <ollama\|openai\|anthropic>` | AI model provider (default `ollama`) |
| `--mode <sandbox\|full>` | Security mode: `sandbox` (default, Contexa kept apart from your application) or `full` (Contexa is your application's main security). Without it the CLI uses `sandbox`, except `full` for the sample application it creates in an empty folder |
| `--ownership <host\|contexa>` | Former name of `--mode`, still accepted: `host` = `sandbox`, `contexa` = `full`. Given together with `--mode`, the two must agree |
| `--yes` | Do not ask; use the defaults |
| `--dir <path>` | Project folder (default: current folder) |
| `--db-url <jdbc-url>` | Use your own PostgreSQL (with pgvector) instead of the local one; the password comes from `CONTEXA_DB_PASSWORD` |
| `--db-username <name>` | User for `--db-url` (default `contexa`) |
| `--lang <en\|ko>` | Language of the CLI. Without it the CLI uses `CONTEXA_LANG`, then `LC_ALL` / `LANG`, then the language of the computer (a Korean Windows gets Korean), then English. There is no question about it during the setup |

API keys for OpenAI and Anthropic come from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or are asked
for and kept in `~/.contexa/credentials.properties` — never in your project.

---

## Other commands

```bash
contexa doctor   # checks everything Contexa needs and tells how to fix what is missing
contexa reset    # removes Contexa from the project again
```

`contexa reset` restores exactly the files `contexa init` changed, from the backups it took.
Changes you made afterwards are kept; where they overlap with Contexa's changes the file is left
as it is and reported. The local services stay for your other projects; when no project uses them
any more, `contexa reset` offers to remove them (or use `contexa reset --services`).

---

## Troubleshooting

| You see | Do this |
|---|---|
| `contexa: command not found` right after installing | Run the `export PATH=...` line the installer printed, or open a new terminal |
| `SPRING_BOOT_UNSUPPORTED` / `SPRING_BOOT_TOO_OLD` | Contexa needs Spring Boot 3.5.x. Change the version to 3.5.x, or start from `contexa init` in an empty folder |
| `BOOT4_DEPENDENCIES` | The build file is on Spring Boot 3.5 but still names Spring Boot 4 starters (`spring-boot-starter-webmvc` is `spring-boot-starter-web` in 3.5; `spring-boot-starter-webmvc-test` and every other `...-test` starter is `spring-boot-starter-test`). The message lists each replacement |
| `NO_APPLICATION` / `CONTEXA_SOURCE` | The build has Spring Boot modules but none of them is an application: they are libraries (bootJar turned off) or have no class with `@SpringBootApplication`, or the folder is the source code of Contexa itself. In a terminal `contexa init` offers to create the sample application in `contexa-demo` below the folder; run it in your application's folder (or with `--dir <that folder>`) to set up your own application |
| `DOCKER_MISSING` / `DOCKER_STOPPED` | Install or start Docker Desktop, or use `--db-url` with your own PostgreSQL |
| `OLLAMA_MISSING` | Install Ollama from https://ollama.com/download, or use `--provider openai` |
| `STARTER_UNAVAILABLE` | Your build cannot download the Contexa starter; check its network/proxy or repository settings |
| You need the admin-console password | It was shown at the end of `contexa init` and is the value of `contexa.iam.seed.admin.password` in `~/.contexa/credentials.properties`. Contexa creates the account `admin` when the application starts as the same user on the same computer |
| The application does not start | Run `contexa doctor` |

---

## Developing the CLI

```bash
git clone https://github.com/contexa-security/contexa-cli
cd contexa-cli
npm ci
npm test
node src/index.js init
```

## License

Apache License 2.0.
