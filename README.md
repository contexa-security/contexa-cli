# Contexa CLI

AI-Native Zero Trust Security CLI for Spring Boot projects.

`contexa-cli` provisions a single-server (in-memory) Contexa setup into an existing
Spring Boot project: it adds the starter dependency, writes Contexa configuration
into `application.yml`, and (optionally) generates a `docker-compose.yml` for the
required infrastructure (PostgreSQL + Ollama).

> Distributed deployments (Redis / Kafka) are **not** provisioned by the CLI —
> see the [Distributed deployment](https://docs.ctxa.ai/docs/install/configuration/infrastructure.html)
> guide.

---

## Install

```bash
curl -fsSL https://install.ctxa.ai | sh
```

Supported binaries: Linux x64, macOS ARM64 (Apple Silicon), Windows x64.
Other platforms can run from source (see "From source" below).

If the installer reports that the install directory is not on your `PATH`,
follow the printed `export PATH=...` hint.

---

## Usage

Run inside a Spring Boot project root.

```bash
contexa init       # initialize Contexa AI Security
contexa status     # show current Contexa status
contexa scan       # quick configuration check
contexa mode --shadow    # observe-only mode
contexa mode --enforce   # block threats actively
```

### `contexa init`

Interactive setup. Detects Maven (`pom.xml`) or Gradle (`build.gradle` /
`build.gradle.kts`), then:

1. Adds `io.contexa:spring-boot-starter-contexa` dependency.
2. Writes a Contexa-managed block into `application.yml`
   (between `# --- Contexa AI Security ---` and `# --- End Contexa ---`).
3. Generates `initdb/01-core-ddl.sql`, `initdb/02-dml.sql`.
4. Generates `docker-compose.yml` (PostgreSQL + Ollama).
5. Optionally starts the containers and pulls the Ollama models.

Flags:

| Flag | Description |
|---|---|
| `--yes` | Skip prompts, use defaults |
| `--force` | Re-initialize even if Contexa is already detected |
| `--dir <path>` | Project directory (default: current working directory) |

### `contexa mode`

Toggles `mode:` inside the Contexa-managed block in `application.yml`.
A `.bak` is created next to the file before the change.

### `contexa scan`

Lightweight configuration check. Inspects only the Contexa-managed block of
`application.yml` (won't false-trigger on unrelated `mode:` keys elsewhere).

### `contexa status`

Prints Spring / Contexa / Security / Mode / LLM summary.

---

## From source

```bash
git clone https://github.com/contexa-security/contexa-cli
cd contexa-cli
npm install
node src/index.js init
```

Prebuilt binaries are produced from the same source via `npm run build`
(esbuild bundle + Node.js Single Executable Application).

---

## Default credentials (local evaluation only)

The CLI provisions a local-only PostgreSQL container with the default password
`contexa1234!@#` and seeds four demo users (`admin`, `kim_manager`, `park_user`,
`dev_lead`) with password `1234`. **Change these before exposing the deployment
to anything other than your own machine.**

---

## License

See repository root.
