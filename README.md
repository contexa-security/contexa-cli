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

```bash
curl -fsSL https://install.ctxa.ai | sh
```

The installer downloads the binary, verifies it against the SHA-256 digest
published next to it on GitHub Releases, and refuses to install on mismatch.
Supported binaries: Linux x64, macOS ARM64 (Apple Silicon), Windows x64.
Other platforms can run from source (see "From source" below).

If the installer reports that the install directory is not on your `PATH`,
follow the printed `export PATH=...` hint.

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

1. Adds `io.contexa:spring-boot-starter-contexa` dependency.
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
| `--distributed` | Provision Redis + Kafka and switch to `mode: DISTRIBUTED` (PoC / enterprise demo). Production: use Kubernetes + Helm |

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

---

## From source

```bash
git clone https://github.com/contexa-security/contexa-cli
cd contexa-cli
npm install
node src/index.js init
```

Prebuilt binaries are produced from the same source via `npm run build`
(esbuild bundle + Node.js Single Executable Application). The release
workflow also publishes a `<binary>.sha256` sidecar for each platform that
the installer verifies.

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

See repository root.
