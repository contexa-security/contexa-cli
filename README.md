# Contexa CLI

AI-Native Zero Trust Security CLI for Spring Boot projects.

`contexa-cli` adds the Contexa starter dependency and the minimum Contexa
configuration needed by a Spring Boot application. The default installation path
is intentionally simple:

```bash
contexa init
```

The command opens a guided setup. General users do not need to memorize long
flags. Advanced flags exist for CI, scripted installs, and platform teams.

---

## Install

Linux / macOS / Git Bash / WSL:

```bash
curl -fsSL https://install.ctxa.ai | sh
```

Windows PowerShell 5.1 or later:

```powershell
irm https://install.ctxa.ai/install.ps1 | iex
```

Both installers download the binary, verify it against the SHA-256 digest
published next to it on GitHub Releases, and refuse to install on mismatch.

Supported prebuilt binaries:

- Linux x64
- macOS ARM64
- Windows x64

Intel Macs, Linux ARM64, and other platforms must build from source.

---

## Quick Start

Run inside a Spring Boot project root:

```bash
contexa init
```

The CLI selects its language from `--lang`, `CONTEXA_LANG`, or the host locale,
and uses the recommended quick path by default. The guided setup asks only
whether AI security should be enabled now. If enabled, it then asks for the AI
provider and whether it may add `@EnableAISecurity` to the main Spring Boot
class.

If you choose starter-only setup, changes stay small:

- Adds `ai.ctxa:spring-boot-starter-contexa`.
- Leaves every host `application.yml`, `.yaml`, `.properties`, and profile file
  byte-identical.
- Does not inject `spring.ai.*`.
- Does not add provider dependencies unless AI security is explicitly selected.
- Does not modify Java source unless the user explicitly allows it.
- Does not start Docker or create infrastructure unless simulation/distributed
  infrastructure is explicitly selected.

Non-interactive `contexa init --yes` uses the safe starter-only defaults. In interactive mode, AI security is enabled only after the wizard asks and the user accepts.

After initialization:

```bash
contexa status
contexa doctor
```

---

## Language

The CLI ships in English and Korean.

```bash
contexa --lang ko init
contexa --lang en init
```

You can also set `CONTEXA_LANG=ko` or `CONTEXA_LANG=en`.

---

## What `contexa init` Changes

`contexa init` detects Maven or Gradle and then applies the selected changes.
Before writing files, the CLI prints the planned changes.

Basic starter-only setup:

- Build file: adds the Contexa Spring Boot starter.
- Host application configuration: no change. Defaults are owned by Contexa
  properties and auto-configuration.
- Runtime schema and seed data: handled by Contexa auto-configuration when the
  application starts, not by copied SQL files in the CLI.

AI security setup, only when selected in the wizard:

- Adds provider dependencies for the chosen provider.
- Writes only Contexa-owned AI settings.
- Optionally adds `@EnableAISecurity` when the user approves.
- API keys remain in environment variables or user-owned application settings.

Infrastructure setup, only when selected:

- `--simulate`: creates an isolated local simulation stack.
- `--distributed`: creates a PoC/demo distributed stack.
- Production deployments should use a proper infrastructure process such as
  Kubernetes or Helm.

---

## Commands

The four primary workflows are:

```bash
contexa init                 # normal installation
contexa reset                # restore normal installation changes
contexa init --simulate      # isolated simulation installation
contexa reset --simulate     # remove only isolated simulation changes
```

`status`, `doctor`, and `scan` are optional support commands. They are not
required installation steps. The machine-readable command and version contract
is `release-manifest.json`.

### Advanced Automation

The following flags are for CI, scripted installs, or platform teams. They are
not required for normal installation.

| Flag | Purpose |
|---|---|
| `--yes` | Skip prompts and use safe defaults. |
| `--enable-ai-security` | Explicitly enable AI security during init. |
| `--provider <openai\|anthropic\|ollama\|none>` | Select an AI provider for explicit AI setup. |
| `--auto-annotate` | Add `@EnableAISecurity` to the main Spring Boot class. |
| `--distributed` | Generate distributed PoC/demo infrastructure. |
| `--simulate` | Generate isolated simulation infrastructure. |
| `--no-docker` | With infrastructure setup, generate compose files but do not start containers. |

For automation, run `contexa init --help` and use only the flags your CI flow needs.

The normal installation entry point remains:

```bash
contexa init
```

---

## Configuration

Contexa defaults are owned by the starter and auto-configuration. The CLI avoids
writing long operational defaults into a customer application.

Common environment variables:

| Variable | Purpose |
|---|---|
| `CONTEXA_DB_URL` / `DB_URL` | Contexa JDBC URL |
| `CONTEXA_DB_USERNAME` / `DB_USERNAME` | Contexa DB username |
| `CONTEXA_DB_PASSWORD` / `DB_PASSWORD` | Contexa DB password |
| `OPENAI_API_KEY` | OpenAI API key, if OpenAI is selected |
| `ANTHROPIC_API_KEY` | Anthropic API key, if Anthropic is selected |
| `OLLAMA_BASE_URL` | Ollama endpoint, if Ollama is selected |

For production, set `CONTEXA_DB_*` explicitly and do not rely on demo defaults.
API keys must not be committed to source control.

---

## Reset Safety

`contexa init` records a manifest of files it changed. `contexa reset` uses that
manifest and backups to restore only CLI-created or CLI-modified files. It does
not broadly delete user-owned source or settings.

Simulation reset:

```bash
contexa reset --simulate
```

Project reset:

```bash
contexa reset
```

---

## Troubleshooting

| Symptom | Resolution |
|---|---|
| `contexa: command not found` after install | Open a new terminal, then run `which contexa` or `Get-Command contexa`. |
| `application.yml is not valid YAML` | Fix the indicated YAML line and rerun `contexa init`. The previous file is backed up. |
| Docker is not installed | Docker is only needed when simulation or distributed infrastructure is selected. Install Docker and rerun `contexa init`, or use your own infrastructure. |
| Docker daemon is not running | Start Docker Desktop or the Docker service. With infrastructure setup, `--no-docker` can generate compose files without starting containers. |
| Ollama model pull failed | This matters only when Ollama is selected. Pull the model manually with `docker exec contexa-ollama ollama pull <model>`, then rerun the app. |
| Schema or seed data is missing | Confirm the application includes `spring-boot-starter-contexa`, points `contexa.datasource.*` at the Contexa database, and starts with Contexa IAM seed enabled or unset. |

---

## From Source

```bash
git clone https://github.com/contexa-security/contexa-cli
cd contexa-cli
npm install
npm test
node src/index.js init
```

---

## Security Notes

- Set real database credentials before production use.
- Keep API keys in environment variables or a secret manager.
- Do not commit generated demo credentials.
- Use SHADOW or observation modes until operational monitoring is sufficient.
- Switch to ENFORCE only after review by the operator.

---

## License

Apache License 2.0.
