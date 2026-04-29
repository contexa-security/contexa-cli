# Contexa CLI

AI-Native Zero Trust Security CLI for Spring Boot projects.

`contexa-cli` provisions a Contexa setup into an existing Spring Boot project:
it adds the starter dependency, writes a Contexa-managed block into
`application.yml` (with an isolated `contexa.datasource` separate from your
application DB), generates seed SQL, and produces a `docker-compose.yml` that
binds ports to `127.0.0.1` only.

> For PoC / enterprise demo, run `contexa init --distributed` to additionally
> provision Redis + Kafka and switch the application to
> `contexa.infrastructure.mode: DISTRIBUTED`. Production deployments should use
> Kubernetes + Helm.

---

## Install

**Linux / macOS / Git Bash / WSL** — POSIX shell:

```bash
curl -fsSL https://install.ctxa.ai | sh
```

**Windows** — PowerShell 5.1 or later:

```powershell
irm https://install.ctxa.ai/install.ps1 | iex
```

Both installers download the binary, verify it against the SHA-256 digest
published next to it on GitHub Releases, and refuse to install on mismatch.

Supported prebuilt binaries:

- Linux x64
- macOS ARM64 (Apple Silicon)
- Windows x64

Intel Macs, Linux ARM64, and other platforms must build from source (see
"From source" below).

If the installer reports that the install directory is not on your `PATH`,
follow the printed hint:

- Linux / macOS: `export PATH="$HOME/.local/bin:$PATH"` in your shell profile
- Windows: open a new terminal (the PowerShell installer adds the path
  automatically to the user-scope PATH)

---

## Usage

Run inside a Spring Boot project root.

```bash
contexa init               # initialize Contexa AI Security
contexa status             # show current Contexa status
contexa scan               # quick configuration check
contexa mode --shadow      # observe-only mode
contexa mode --enforce     # block threats actively
```

### Language

The CLI ships in English (default) and Korean. Choose explicitly:

```bash
contexa --lang ko init
contexa --lang en init
```

Or set `CONTEXA_LANG=ko` (or `LANG=ko_KR.UTF-8`) in your environment.

### `contexa init`

Interactive setup. Detects Maven (`pom.xml`) or Gradle (`build.gradle` /
`build.gradle.kts`), then:

1. Adds `ai.ctxa:spring-boot-starter-contexa` dependency.
2. Writes a Contexa-managed block into `application.yml`
   (between `# --- Contexa AI Security ---` and `# --- End Contexa ---`).
   The block contains an isolated `contexa.datasource` (driven by
   `CONTEXA_DB_*` / `DB_*` env vars) plus standard `spring.datasource` and
   `spring.ai.*` configuration.
3. Generates `initdb/01-core-ddl.sql`, `initdb/02-dml.sql` with a
   freshly-randomized BCrypt hash for the four seed accounts.
4. Generates `docker-compose.yml` (PostgreSQL + Ollama, ports bound to
   `127.0.0.1`).
5. Optionally starts the containers and pulls the Ollama models.
6. Prints the seed account password **once** so you can record it.

Flags:

| Flag | Description |
|---|---|
| `--yes` | Skip prompts, use defaults |
| `--force` | Re-initialize even if Contexa is already detected |
| `--dir <path>` | Project directory (default: current working directory) |
| `--lang <code>` | Interface language (`en` or `ko`) |
| `--distributed` | **Opt-in:** install distributed infrastructure (Postgres + Ollama + Redis + Zookeeper + Kafka), set `contexa.infrastructure.mode: DISTRIBUTED`, and add `redisson` + `spring-kafka` deps. Without this flag, `init` does not generate `docker-compose.yml`, does not generate `initdb/`, and does not start any containers. Production deployments should still use Kubernetes + Helm. |
| `--no-docker` | With `--distributed`: generate compose/initdb files but do not run `docker compose up -d`. Has no effect without `--distributed` (init does nothing infra-related anyway). |

> **Default behavior:** `contexa init` (no flags) only updates `application.yml`
> with the contexa-managed keys and adds `spring-boot-starter-contexa` to your
> build file. It does not touch Docker, does not write `docker-compose.yml`,
> and does not generate database init scripts. Customers running their own
> PostgreSQL / Ollama (and Redis / Kafka) infrastructure are unaffected.

### `contexa mode`

Toggles `security.zerotrust.mode` inside the Contexa-managed block in
`application.yml`. A `.bak` is created next to the file before the change.

### `contexa scan`

Configuration scan. Reports:

- Contexa starter present in dependencies
- Contexa-managed block present in `application.yml`
- Default DB password still in use (`contexa1234!@#`)
- API keys exposed as plaintext (not as `${ENV:default}` placeholders)
- Both `application.properties` and `application.yml` exist (one shadows the other)
- SHADOW vs ENFORCE mode

Returns non-zero exit code when issues are found.

### `contexa status`

Prints Spring / Contexa / Security / Mode / LLM summary.

---

## Configuration via environment variables

The Contexa-managed block in `application.yml` is written with environment
variable fallbacks, so you can override credentials without editing the file:

| Variable | Purpose | Default |
|---|---|---|
| `CONTEXA_DB_URL` / `DB_URL` | JDBC URL | `jdbc:postgresql://localhost:5432/contexa` |
| `CONTEXA_DB_USERNAME` / `DB_USERNAME` | DB username | `contexa` |
| `CONTEXA_DB_PASSWORD` / `DB_PASSWORD` | DB password | `contexa1234!@#` |
| `CONTEXA_JPA_DDL_AUTO` | Hibernate DDL mode | `update` |
| `OLLAMA_BASE_URL` | Ollama endpoint | `http://127.0.0.1:11434` |
| `OLLAMA_CHAT_MODEL` | Ollama chat model | `qwen2.5:7b` |
| `OLLAMA_EMBEDDING_MODEL` | Ollama embedding model | `mxbai-embed-large` |
| `OPENAI_API_KEY` | OpenAI key | placeholder |
| `ANTHROPIC_API_KEY` | Anthropic key | placeholder |
| `COMPOSE_BIND_HOST` | docker-compose port bind host | `127.0.0.1` |
| `REDIS_HOST` / `REDIS_PORT` | Redis (distributed) | `localhost` / `6379` |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka (distributed) | `localhost:9092` |

For production deployments, set the `CONTEXA_DB_*` variants explicitly and
**never** rely on the embedded defaults.

### Setting environment variables

Linux / macOS / Git Bash:

```bash
export CONTEXA_DB_PASSWORD='your-secret'
contexa init
```

Windows PowerShell:

```powershell
$env:CONTEXA_DB_PASSWORD = 'your-secret'
contexa init
```

For persistent values on Windows, prefer
`[Environment]::SetEnvironmentVariable('CONTEXA_DB_PASSWORD', 'your-secret', 'User')`
and reopen the terminal.

### Default Ollama model footprint

`qwen2.5:7b` is the default chat model and uses roughly 5 GB of RAM at
inference time. On smaller machines, override with a lighter model before
starting Docker:

```bash
export OLLAMA_CHAT_MODEL='qwen2.5:3b'   # ~2.4 GB
contexa init
```

The `mxbai-embed-large` embedding model adds about 670 MB.

---

## From source

```bash
git clone https://github.com/contexa-security/contexa-cli
cd contexa-cli
npm install
npm test                  # 37 unit tests for injector, detector, i18n
node src/index.js init
```

Prebuilt binaries are produced from the same source via `npm run build`
(esbuild bundle + Node.js Single Executable Application). The release
workflow also publishes a `<binary>.sha256` sidecar for each platform that
the installer verifies.

---

## Troubleshooting

If something goes wrong during `init`, the original `application.yml`,
`pom.xml`, `build.gradle`, and `docker-compose.yml` are always backed up
to `<file>.bak` next to the original before any change. Recovery is a
copy: `cp application.yml.bak application.yml`.

### Install / launch

| Symptom | Resolution |
|---|---|
| `contexa: command not found` after install | Open a new terminal, then `which contexa` (Linux/macOS) or `Get-Command contexa` (PowerShell). The installer prints the PATH hint at the end. |
| macOS Gatekeeper blocks `contexa` | The release binary is ad-hoc signed only. Strip the quarantine attribute: `xattr -d com.apple.quarantine $(which contexa)`. |
| `Docker start failed` during `init` | Run `docker compose up -d` manually in the project directory. The `docker-compose.yml` was already generated. To skip the docker step entirely, re-run with `contexa init --infra skip` or `--no-docker`. |

### `contexa init` errors

| Symptom | Resolution |
|---|---|
| `application.yml is not valid YAML (around line N)` | Open the file at the indicated line. Common causes: tabs (use spaces), inconsistent indentation, missing colons. The file is restored from `.bak` if you cannot fix it. |
| `Both application.properties and application.yml exist` warning | Spring Boot loads one and silently shadows the other based on classpath order. Pick a single source - usually move `.properties` content into `.yml` and delete `.properties`. |
| Existing `contexa.*` keys disappear after `init` | They should not. The CLI uses YAML-aware merge and preserves user values. If they do, restore from `application.yml.bak` and please file an issue with the input file. |
| `init` adds a redundant `spring-boot-starter-contexa` line in a multi-module Gradle build | The CLI now walks up to the parent `settings.gradle` and recognizes the starter when it is added in a parent `subprojects { dependencies { } }` block. If you still see the duplicate, ensure your `settings.gradle` `include` line uses the directory basename. |

### Run multiple Contexa stacks side-by-side (manual install simulation)

The compose file generated by `contexa init --distributed` has env-overridable
container names AND ports, so you can run a production stack and one or more
simulation stacks on the same host without colliding:

```bash
# Production stack (default - what your real installation uses)
contexa init --distributed
docker compose up -d
# -> contexa-postgres on 5432, contexa-ollama on 11434, ...

# Manual install simulation - separate stack, can be reset freely
export CONTEXA_PROJECT=ctxa-sim
export CONTEXA_POSTGRES_PORT=25432
export CONTEXA_OLLAMA_PORT=31434
export CONTEXA_REDIS_PORT=26379
export CONTEXA_ZOOKEEPER_PORT=22181
export CONTEXA_KAFKA_PORT=29092
contexa init --distributed --force      # overwrite the previous compose
docker compose up -d                     # ctxa-sim-postgres on 25432, ...

# Reset just the simulation stack (production untouched)
docker compose -p ctxa-sim down -v
docker compose -p ctxa-sim up -d
```

The CLI also ships a ready-to-use test stack at
[test-infra/docker-compose.test.yml](test-infra/docker-compose.test.yml)
(`ctxa-test-*` containers on +10000 ports), which is what the integration
matrix runner uses internally.

### Infrastructure (`--distributed`, Docker, ports)

`contexa init --distributed` provisions PostgreSQL + Ollama + Redis +
Zookeeper + Kafka. Standalone (default) only provisions PostgreSQL + Ollama.
Both modes run a pre-flight check before `docker compose up -d`.

| Symptom | Resolution |
|---|---|
| `Docker is not installed on this machine` | Install Docker Desktop (Windows/macOS) or Docker Engine (Linux), then open a new terminal and re-run `contexa init`. If you cannot install Docker, re-run with `--no-infra` to skip infrastructure provisioning - you must then run PostgreSQL/Ollama (and Redis/Kafka if `--distributed`) yourself. |
| `Docker is installed but the daemon is not running` | Open Docker Desktop and wait for the whale icon to settle, OR run `sudo systemctl start docker` on Linux. Or re-run with `--no-docker` to generate compose/initdb files without starting them. |
| `Port 5432 / 6379 / 9092 (...) is already in use` | Stop the conflicting service, OR set `COMPOSE_BIND_HOST=0.0.0.0` to bind to a different interface, OR re-run with `--no-docker` and resolve the conflict before running compose manually. |
| `Container "contexa-postgres" already exists` | compose will silently reuse it. If its config has drifted (different password, mount path, etc.) run `docker rm -f contexa-postgres` (and other contexa-* containers) before re-init. |
| `redisson` version conflict with your existing BOM (`--distributed` only) | Set `CONTEXA_REDISSON_VERSION=<your-version>` before running `contexa init --distributed`. The CLI will use that version instead of the bundled `3.48.0`. |
| Ollama model pull failed | Run `docker exec contexa-ollama ollama pull qwen2.5:7b`. Override default models with `OLLAMA_CHAT_MODEL=qwen2.5:3b` (and optionally `OLLAMA_EMBEDDING_MODEL`) before re-running `init`. |
| Application can't connect to DB | Confirm `CONTEXA_DB_PASSWORD` matches the value in `docker-compose.yml`. Volumes persist across restarts; `docker compose down -v` resets the data directory. |
| `permission` table column `auto_created` does not exist | Older `02-dml.sql` had a column the DDL did not declare. Re-run `contexa init --force` to regenerate `initdb/01-core-ddl.sql`, then `docker compose down -v && docker compose up -d` to re-bootstrap. |

### `contexa scan` warnings explained

| Warning | Meaning | Fix |
|---|---|---|
| `Dead key contexa.jpa.hibernate.ddl-auto` | No `@ConfigurationProperties` binds this; older CLI versions emitted it. | Remove the key, or move the value to `spring.jpa.hibernate.ddl-auto`. |
| `Deprecated key contexa.llm.chatModelPriority` | Replaced by `contexa.llm.selection.chat.priority`. Core still binds the old key today but it will be removed. | Replace with the new key. |
| `Top-level "contexa:" appears N times` | Spring Boot 3.x SnakeYAML rejects duplicate top-level keys. | Run `contexa init` again; the CLI merges them into one. |
| `Default DB password still in use` | `contexa1234!@#` is in `contexa.datasource.password`. | Set `CONTEXA_DB_PASSWORD` and remove the literal default. |

---

## Security notes (local evaluation only)

The CLI provisions a local-only PostgreSQL container with the default password
`contexa1234!@#`. Docker ports are bound to `127.0.0.1` so they are not
exposed to your LAN by default; override with `COMPOSE_BIND_HOST=0.0.0.0` only
if you need external access.

The four seed users (`admin`, `kim_manager`, `park_user`, `dev_lead`) are
created with a **per-init random password** that is printed once at the end
of `contexa init`. Save it immediately - the CLI keeps no record of it.

Before exposing the deployment to anything other than your own machine:

- Set `CONTEXA_DB_PASSWORD` / `DB_PASSWORD` to a real secret.
- Verify `application.yml` is not committed with default credentials.
- Rotate the seed account passwords.
- Switch to `ENFORCE` mode (`contexa mode --enforce`) once observation is sufficient.

---

## License

Apache License 2.0 — see the `LICENSE` file in the repository root.