'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const yaml = require('js-yaml');

// Legacy marker block written by pre-1.1 versions. Kept here only so that
// re-running init on an older project strips and rewrites the block as a
// merged contexa: tree instead of producing a duplicate top-level key.
const LEGACY_MARKER_START = '# --- Contexa AI Security ---';
const LEGACY_MARKER_END   = '# --- End Contexa ---';

const CONTEXA_GROUP_ID = 'ai.ctxa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';
const CONTEXA_VERSION = '0.1.0';

// Generate a URL-safe random password (16 chars from 12 random bytes).
// Node 18 supports base64url directly.
function generateRandomPassword(byteLength = 12) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

// BCrypt hash with cost factor 6 to keep init time acceptable.
// Cost 6 is sufficient for the seed accounts; users should rotate later.
function bcryptHash(plain) {
  return bcrypt.hashSync(plain, 6);
}

// Build the contexa.* sub-tree this CLI version is responsible for.
// The shape mirrors the @ConfigurationProperties surface in the platform.
// Returned tree is a fresh object the caller can mutate freely.
function buildCliContexaTree(opts) {
  const { mode = 'shadow', llmProviders = ['ollama'], infra = 'standalone' } = opts;
  const priority = llmProviders.join(',');
  const embeddingPriority = llmProviders.filter(p => p !== 'anthropic').join(',') || 'ollama';

  const tree = {
    llm: {
      // Use the non-deprecated selection API. Deprecated chatModelPriority/
      // embeddingModelPriority on contexa.llm.* are intentionally NOT written.
      selection: {
        chat: { priority },
        embedding: { priority: embeddingPriority },
      },
    },
    datasource: {
      url: '${CONTEXA_DB_URL:${DB_URL:jdbc:postgresql://localhost:5432/contexa}}',
      username: '${CONTEXA_DB_USERNAME:${DB_USERNAME:contexa}}',
      password: '${CONTEXA_DB_PASSWORD:${DB_PASSWORD:contexa1234!@#}}',
      'driver-class-name': '${CONTEXA_DB_DRIVER:org.postgresql.Driver}',
      isolation: { 'contexa-owned-application': true },
    },
    security: {
      zerotrust: { mode: mode === 'enforce' ? 'ENFORCE' : 'SHADOW' },
    },
    hcad: {
      geoip: { enabled: true, dbPath: 'data/GeoLite2-City.mmdb' },
    },
  };
  if (infra === 'distributed') {
    tree.infrastructure = { mode: 'DISTRIBUTED' };
  }
  return tree;
}

// Recursively fill missing keys from source into target. Existing primitives
// are preserved (user wins). Objects merge; arrays/primitives never overwrite.
function fillOnly(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      fillOnly(target[key], sv);
    } else if (target[key] === undefined) {
      target[key] = sv;
    }
  }
}

function setPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

// Apply the CLI tree onto the host application's parsed yml object.
// Policy:
//   - User-set values are preserved by default (fill-only merge).
//   - A small set of CLI-managed keys are always force-overwritten because they
//     define platform behavior and must not silently drift between init runs:
//       * contexa.security.zerotrust.mode
//       * contexa.hcad.geoip.enabled
//       * contexa.datasource.isolation.contexa-owned-application
//       * contexa.llm.selection.{chat,embedding}.priority
//   - --distributed additionally forces contexa.infrastructure.mode = DISTRIBUTED.
function applyCliContexaTree(rootObj, cliTree, opts) {
  if (!rootObj.contexa || typeof rootObj.contexa !== 'object' || Array.isArray(rootObj.contexa)) {
    rootObj.contexa = {};
  }
  fillOnly(rootObj.contexa, cliTree);

  setPath(rootObj.contexa, ['security', 'zerotrust', 'mode'],
    opts.mode === 'enforce' ? 'ENFORCE' : 'SHADOW');
  setPath(rootObj.contexa, ['hcad', 'geoip', 'enabled'], true);
  setPath(rootObj.contexa, ['datasource', 'isolation', 'contexa-owned-application'], true);
  setPath(rootObj.contexa, ['llm', 'selection', 'chat', 'priority'],
    cliTree.llm.selection.chat.priority);
  setPath(rootObj.contexa, ['llm', 'selection', 'embedding', 'priority'],
    cliTree.llm.selection.embedding.priority);

  if (opts.infra === 'distributed') {
    setPath(rootObj.contexa, ['infrastructure', 'mode'], 'DISTRIBUTED');
  }
}

// Strip a marker block written by older CLI versions. Idempotent on input
// without a marker. Returns the cleaned yml text.
function stripLegacyMarker(content) {
  const regex = new RegExp(
    `\\n*${escapeRegex(LEGACY_MARKER_START)}[\\s\\S]*?${escapeRegex(LEGACY_MARKER_END)}\\n*`,
    'g'
  );
  return content.replace(regex, '\n');
}

async function injectYml(ymlPath, opts = {}) {
  const cliTree = buildCliContexaTree(opts);

  let rootObj = {};
  if (await fs.pathExists(ymlPath)) {
    await fs.copy(ymlPath, ymlPath + '.bak');
    const content = await fs.readFile(ymlPath, 'utf8');
    const stripped = stripLegacyMarker(content);
    try {
      const parsed = yaml.load(stripped);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rootObj = parsed;
      }
    } catch (err) {
      // Surface a friendly, actionable message instead of a raw stack trace.
      // The .bak file is already in place so the user can recover.
      const lineHint = err.mark && typeof err.mark.line === 'number'
        ? ` (around line ${err.mark.line + 1})` : '';
      const guidance = [
        `application.yml is not valid YAML${lineHint}.`,
        `Backup saved to ${ymlPath}.bak`,
        `How to fix:`,
        `  1) Open ${ymlPath} and check indentation${lineHint}.`,
        `  2) Tabs are NOT valid in YAML - replace with spaces.`,
        `  3) Run "contexa init" again once the file parses cleanly.`,
        `  4) If you cannot resolve it, restore from the .bak file.`,
        `Original parser error: ${err.message}`,
      ].join('\n  ');
      throw new Error(guidance);
    }
  }

  applyCliContexaTree(rootObj, cliTree, opts);

  await fs.ensureDir(path.dirname(ymlPath));
  const out = yaml.dump(rootObj, {
    lineWidth: 200,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });
  await fs.writeFile(ymlPath, out);
}

async function injectMavenDep(pomPath) {
  if (!await fs.pathExists(pomPath)) return false;
  const pom = await fs.readFile(pomPath, 'utf8');
  if (pom.includes(CONTEXA_ARTIFACT_ID)) return false;

  // Locate the project-level </dependencies>, skipping over any
  // <dependencyManagement>...</dependencyManagement> block whose inner
  // </dependencies> tag must NOT be the injection point.
  const mgmtRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
  const mgmtRanges = [];
  let m;
  while ((m = mgmtRegex.exec(pom)) !== null) {
    mgmtRanges.push([m.index, m.index + m[0].length]);
  }
  const isInsideMgmt = (idx) => mgmtRanges.some(([a, b]) => idx >= a && idx < b);

  let target = -1;
  let cursor = 0;
  while (true) {
    const found = pom.indexOf('</dependencies>', cursor);
    if (found === -1) break;
    if (!isInsideMgmt(found)) { target = found; break; }
    cursor = found + 1;
  }
  if (target === -1) return false;

  // Backup
  await fs.copy(pomPath, pomPath + '.bak');

  const dep =
    `        <dependency>\n` +
    `            <groupId>${CONTEXA_GROUP_ID}</groupId>\n` +
    `            <artifactId>${CONTEXA_ARTIFACT_ID}</artifactId>\n` +
    `            <version>${CONTEXA_VERSION}</version>\n` +
    `        </dependency>\n    `;
  const updated = pom.slice(0, target) + dep + pom.slice(target);
  await fs.writeFile(pomPath, updated);
  return true;
}

async function injectGradleDep(gradlePath) {
  if (!await fs.pathExists(gradlePath)) return false;
  let gradle = await fs.readFile(gradlePath, 'utf8');
  if (gradle.includes(CONTEXA_ARTIFACT_ID)) return false;

  // Backup
  await fs.copy(gradlePath, gradlePath + '.bak');

  // Kotlin DSL uses double-quoted, parenthesized form: implementation("group:artifact:version")
  // Groovy DSL uses single-quoted form: implementation 'group:artifact:version'
  const isKotlinDsl = gradlePath.endsWith('.kts');
  const depLine = isKotlinDsl
    ? `    implementation("${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}")`
    : `    implementation '${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}'`;

  gradle = gradle.replace(
    /dependencies\s*\{/,
    `dependencies {\n${depLine}`
  );
  await fs.writeFile(gradlePath, gradle);
  return true;
}

async function generateDockerCompose(projectDir, opts = {}) {
  const { infra = 'standalone' } = opts;
  const composePath = path.join(projectDir, 'docker-compose.yml');

  if (await fs.pathExists(composePath)) {
    await fs.copy(composePath, composePath + '.bak');
  }

  let content = `# Contexa Infrastructure - Auto-generated by contexa init
# Ports are bound to 127.0.0.1 only to prevent unintended LAN exposure.
# Override with COMPOSE_BIND_HOST=0.0.0.0 only if external access is required.
services:
  # PostgreSQL with PGVector
  postgres:
    image: pgvector/pgvector:pg16
    container_name: contexa-postgres
    environment:
      POSTGRES_DB: \${CONTEXA_DB_NAME:-contexa}
      POSTGRES_USER: \${CONTEXA_DB_USERNAME:-contexa}
      POSTGRES_PASSWORD: \${CONTEXA_DB_PASSWORD:-contexa1234!@#}
      POSTGRES_INITDB_ARGS: "-E UTF8 --locale=C"
    ports:
      - "\${COMPOSE_BIND_HOST:-127.0.0.1}:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${CONTEXA_DB_USERNAME:-contexa} -d \${CONTEXA_DB_NAME:-contexa}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # Ollama - Local LLM for AI security analysis
  ollama:
    image: ollama/ollama:latest
    container_name: contexa-ollama
    ports:
      - "\${COMPOSE_BIND_HOST:-127.0.0.1}:11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    environment:
      - OLLAMA_KEEP_ALIVE=30m
      - OLLAMA_NUM_PARALLEL=2
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 30s
      timeout: 10s
      retries: 5
    restart: unless-stopped
`;

  if (infra === 'distributed') {
    content += `
  # Redis - Session store, cache, distributed locks (PoC/demo only)
  redis:
    image: redis:7.2-alpine
    container_name: contexa-redis
    ports:
      - "\${COMPOSE_BIND_HOST:-127.0.0.1}:6379:6379"
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # Zookeeper - Kafka coordinator
  zookeeper:
    image: confluentinc/cp-zookeeper:7.4.0
    container_name: contexa-zookeeper
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
    ports:
      - "\${COMPOSE_BIND_HOST:-127.0.0.1}:2181:2181"
    volumes:
      - zookeeper-data:/var/lib/zookeeper/data
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "2181"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    restart: unless-stopped

  # Kafka - Event streaming
  kafka:
    image: confluentinc/cp-kafka:7.4.0
    container_name: contexa-kafka
    depends_on:
      zookeeper:
        condition: service_healthy
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9093,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9093,PLAINTEXT_HOST://0.0.0.0:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
    ports:
      - "\${COMPOSE_BIND_HOST:-127.0.0.1}:9092:9092"
    volumes:
      - kafka-data:/var/lib/kafka/data
    healthcheck:
      test: ["CMD", "kafka-broker-api-versions", "--bootstrap-server", "localhost:9092"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 40s
    restart: unless-stopped
`;
  }

  // Volumes
  content += `
volumes:
  pgdata:
  ollama-data:`;
  if (infra === 'distributed') {
    content += `
  redis-data:
  zookeeper-data:
  kafka-data:`;
  }
  content += '\n';

  await fs.writeFile(composePath, content);
  return composePath;
}

// Generate database init scripts.
// When seedPassword is omitted, a fresh random password is generated.
// Returns { initdbDir, seedPassword } so the caller can show it to the user once.
async function generateInitDbScripts(projectDir, opts = {}) {
  const initdbDir = path.join(projectDir, 'initdb');
  await fs.ensureDir(initdbDir);

  const seedPassword = opts.seedPassword || generateRandomPassword();
  const seedHash = bcryptHash(seedPassword);

  // 01-core-ddl.sql (numbered for execution order)
  await fs.writeFile(path.join(initdbDir, '01-core-ddl.sql'), getDdlScript());

  // 02-dml.sql with per-init randomized BCrypt hash for the four seed accounts.
  await fs.writeFile(path.join(initdbDir, '02-dml.sql'), getDmlScript(seedHash));

  return { initdbDir, seedPassword };
}

function getDdlScript() {
  return `-- Contexa Core DDL
-- Auto-generated from entity definitions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

create table users
(
    id                    bigserial
        primary key,
    username              varchar(100)                           not null
        unique,
    email                 varchar(255)                           not null
        unique,
    password              varchar(255)                           not null,
    name                  varchar(100)                           not null,
    phone                 varchar(20),
    department            varchar(100),
    position              varchar(100),
    profile_image_url     varchar(500),
    enabled               boolean      default true              not null,
    account_locked        boolean      default false             not null,
    credentials_expired   boolean      default false             not null,
    failed_login_attempts integer      default 0                 not null,
    lock_expires_at       timestamp(6),
    mfa_enabled           boolean      default false             not null,
    preferred_mfa_factor  varchar(50),
    last_used_mfa_factor  varchar(50),
    last_mfa_used_at      timestamp(6),
    last_login_at         timestamp(6),
    last_login_ip         varchar(45),
    password_changed_at   timestamp(6),
    locale                varchar(10)  default 'ko'::character varying,
    timezone              varchar(50)  default 'Asia/Seoul'::character varying,
    created_at            timestamp(6) default CURRENT_TIMESTAMP not null,
    updated_at            timestamp(6),
    authentication_source varchar(100),
    bridge_subject_key    varchar(120)
        constraint uk5rjvurnq36ksjjr71o1siari7
            unique,
    external_subject_id   varchar(255),
    last_bridged_at       timestamp(6),
    organization_id       varchar(255),
    principal_type        varchar(50),
    bridge_managed        boolean      default false             not null,
    external_auth_only    boolean      default false             not null
);


create index idx_users_email
    on users (email);

create index idx_users_department
    on users (department);

create index idx_users_enabled
    on users (enabled);

create table app_group
(
    group_id    bigserial
        primary key,
    group_name  varchar(100)                           not null
        unique,
    description varchar(500),
    enabled     boolean      default true              not null,
    created_at  timestamp(6) default CURRENT_TIMESTAMP not null,
    updated_at  timestamp(6),
    created_by  varchar(100)
);

create table role
(
    role_id       bigserial
        primary key,
    role_name     varchar(100)                           not null
        unique,
    role_desc     varchar(500),
    expression    boolean      default false             not null,
    enabled       boolean      default true              not null,
    created_at    timestamp(6) default CURRENT_TIMESTAMP not null,
    updated_at    timestamp(6),
    created_by    varchar(100),
    is_expression varchar(255)
);

create table managed_resource
(
    id                          bigserial
        primary key,
    resource_identifier         varchar(512)                                               not null
        unique,
    resource_type               varchar(255)                                               not null,
    http_method                 varchar(255),
    friendly_name               varchar(255),
    description                 varchar(1024),
    service_owner               varchar(255),
    parameter_types             varchar(1024),
    return_type                 varchar(512),
    api_docs_url                varchar(1024),
    source_code_location        varchar(1024),
    status                      varchar(255) default 'NEEDS_DEFINITION'::character varying not null,
    created_at                  timestamp(6) default CURRENT_TIMESTAMP                     not null,
    updated_at                  timestamp(6) default CURRENT_TIMESTAMP                     not null,
    available_context_variables varchar(1024)
);

create table permission
(
    permission_id        bigserial
        primary key,
    permission_name      varchar(255)                           not null
        unique,
    friendly_name        varchar(255),
    description          varchar(1024),
    target_type          varchar(100),
    action_type          varchar(100),
    condition_expression varchar(2048),
    managed_resource_id  bigint
        unique
                                                                references managed_resource
                                                                    on delete set null,
    auto_created         boolean      default false             not null,
    created_at           timestamp(6) default CURRENT_TIMESTAMP not null,
    updated_at           timestamp(6)
);

create table user_groups
(
    user_id     bigint                                 not null
        references users
            on delete cascade,
    group_id    bigint                                 not null
        references app_group
            on delete cascade,
    assigned_at timestamp(6) default CURRENT_TIMESTAMP not null,
    assigned_by varchar(100),
    primary key (user_id, group_id)
);

create table group_roles
(
    group_id    bigint                                 not null
        references app_group
            on delete cascade,
    role_id     bigint                                 not null
        references role
            on delete cascade,
    assigned_at timestamp(6) default CURRENT_TIMESTAMP not null,
    assigned_by varchar(100),
    primary key (group_id, role_id)
);

create table role_permissions
(
    role_id       bigint                                 not null
        references role
            on delete cascade,
    permission_id bigint                                 not null
        references permission
            on delete cascade,
    assigned_at   timestamp(6) default CURRENT_TIMESTAMP not null,
    assigned_by   varchar(100),
    primary key (role_id, permission_id)
);

create table policy
(
    id                   bigserial
        primary key,
    name                 varchar(255)                           not null
        unique,
    description          varchar(255),
    effect               varchar(255)                           not null,
    priority             integer                                not null,
    friendly_description varchar(2048),
    ai_model             varchar(255),
    approval_status      varchar(50)
        constraint policy_approval_status_check
            check ((approval_status)::text = ANY
                   ((ARRAY ['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying, 'NOT_REQUIRED'::character varying])::text[])),
    approved_at          timestamp(6),
    approved_by          varchar(255),
    confidence_score     double precision,
    source               varchar(50)
        constraint policy_source_check
            check ((source)::text = ANY
                   ((ARRAY ['MANUAL'::character varying, 'AI_GENERATED'::character varying, 'AI_EVOLVED'::character varying, 'IMPORTED'::character varying])::text[])),
    updated_at           timestamp(6),
    created_at           timestamp(6) default CURRENT_TIMESTAMP not null,
    is_active            boolean      default true              not null,
    reasoning            varchar(4096)
);

create table policy_target
(
    id                bigserial
        primary key,
    policy_id         bigint                not null
        references policy
            on delete cascade,
    target_type       varchar(255)          not null,
    target_identifier varchar(255)          not null,
    http_method       varchar(255),
    target_order      integer     default 0 not null,
    source_type       varchar(20) default 'RESOURCE'::character varying
);

create table policy_rule
(
    id          bigserial
        primary key,
    policy_id   bigint not null
        references policy
            on delete cascade,
    description varchar(255)
);

create table policy_condition
(
    id                   bigserial
        primary key,
    rule_id              bigint                                                  not null
        references policy_rule
            on delete cascade,
    condition_expression varchar(2048)                                           not null,
    authorization_phase  varchar(255) default 'PRE_AUTHORIZE'::character varying not null,
    description          varchar(255)
);

create table role_hierarchy_config
(
    hierarchy_id     bigserial
        primary key,
    description      varchar(255),
    hierarchy_string text                  not null
        unique,
    is_active        boolean default false not null
);

create table audit_log
(
    id                  bigserial
        primary key,
    timestamp           timestamp(6) default CURRENT_TIMESTAMP not null,
    principal_name      varchar(255)                           not null,
    resource_identifier varchar(512)                           not null,
    action              varchar(100),
    decision            varchar(50)                            not null,
    reason              varchar(1024),
    client_ip           varchar(45),
    details             text,
    outcome             varchar(50),
    resource_uri        varchar(1024),
    session_id          varchar(128),
    correlation_id      varchar(64),
    event_category      varchar(50),
    event_source        varchar(50),
    http_method         varchar(10),
    request_uri         varchar(2048),
    risk_score          double precision,
    user_agent          varchar(512),
    parameters          varchar(255),
    status              varchar(255)
);

create table business_resource
(
    id            bigserial
        primary key,
    name          varchar(255) not null
        unique,
    resource_type varchar(100) not null,
    description   varchar(1024)
);

create table business_action
(
    id          bigserial
        primary key,
    name        varchar(255) not null
        unique,
    action_type varchar(100) not null,
    description varchar(1024)
);

create table business_resource_action
(
    business_resource_id   bigint       not null
        references business_resource
            on delete cascade,
    business_action_id     bigint       not null
        references business_action
            on delete cascade,
    mapped_permission_name varchar(255) not null,
    primary key (business_resource_id, business_action_id)
);

create table condition_template
(
    id                   bigserial
        primary key,
    name                 varchar(255)      not null
        unique,
    spel_template        varchar(2048)     not null,
    category             varchar(255),
    parameter_count      integer default 0 not null,
    description          varchar(1024),
    required_target_type varchar(1024),
    created_at           timestamp(6),
    is_auto_generated    boolean,
    is_universal         boolean,
    source_method        varchar(255),
    template_type        varchar(255),
    updated_at           timestamp(6),
    approval_required    boolean,
    classification       varchar(255)
        constraint condition_template_classification_check
            check ((classification)::text = ANY
                   ((ARRAY ['UNIVERSAL'::character varying, 'CONTEXT_DEPENDENT'::character varying, 'CUSTOM_COMPLEX'::character varying])::text[])),
    complexity_score     integer,
    context_dependent    boolean
);

create table wizard_session
(
    session_id    varchar(36)  not null
        primary key,
    context_data  text         not null,
    owner_user_id varchar(255) not null,
    created_at    timestamp(6) not null,
    expires_at    timestamp(6) not null
);

create table function_group
(
    id   bigserial
        primary key,
    name varchar(255) not null
        unique
);

create table function_catalog
(
    id                  bigserial
        primary key,
    description         varchar(1024),
    friendly_name       varchar(255) not null,
    status              varchar(255) not null
        constraint function_catalog_status_check
            check ((status)::text = ANY
                   (ARRAY [('UNCONFIRMED'::character varying)::text, ('ACTIVE'::character varying)::text, ('INACTIVE'::character varying)::text])),
    function_group_id   bigint
        references function_group,
    managed_resource_id bigint       not null
        unique
        references managed_resource
);

create table policy_template
(
    id                bigserial
        primary key,
    category          varchar(255),
    description       varchar(1024),
    name              varchar(255) not null,
    policy_draft_json jsonb        not null,
    template_id       varchar(255) not null
        unique
);

create table vector_store
(
    id        uuid default gen_random_uuid() not null
        primary key,
    content   text                           not null,
    metadata  jsonb,
    embedding vector(1024)
);


create index vector_store_embedding_idx
    on vector_store using hnsw (embedding vector_cosine_ops);

create index spring_ai_vector_index
    on vector_store using hnsw (embedding vector_cosine_ops);

create table user_behavior_profiles
(
    id                      bigserial
        primary key,
    cluster_centroid_vector text,
    cluster_size            integer,
    common_activities       json,
    common_ip_ranges        json,
    confidence_score        real,
    last_updated            timestamp(6),
    learning_count          integer,
    normal_range_metadata   json,
    profile_type            varchar(50)  not null,
    user_id                 varchar(255) not null,
    vector_cluster_id       varchar(100)
);

create table soar_incidents
(
    id          uuid         not null
        primary key,
    created_at  timestamp(6) not null,
    history     text,
    severity    varchar(20),
    status      varchar(255) not null
        constraint soar_incidents_status_check
            check ((status)::text = ANY
                   ((ARRAY ['NEW'::character varying, 'TRIAGE'::character varying, 'INVESTIGATION'::character varying, 'PLANNING'::character varying, 'PENDING_APPROVAL'::character varying, 'EXECUTION'::character varying, 'REPORTING'::character varying, 'COMPLETED'::character varying, 'AUTO_CLOSED'::character varying, 'FAILED'::character varying, 'CLOSED_BY_ADMIN'::character varying])::text[])),
    title       varchar(255) not null,
    updated_at  timestamp(6) not null,
    description text,
    incident_id varchar(100),
    metadata    text,
    type        varchar(50)
);

create table soar_approval_policies
(
    id                      bigserial
        primary key,
    action_name             varchar(255),
    auto_approve_on_timeout boolean      not null,
    policy_name             varchar(255) not null
        unique,
    required_approvers      integer      not null,
    required_roles          text,
    severity                varchar(20),
    timeout_minutes         integer      not null
);

create table soar_approval_requests
(
    id                       bigserial
        primary key,
    action_name              varchar(255) not null,
    created_at               timestamp(6) not null,
    description              text,
    organization_id          varchar(100),
    parameters               text,
    playbook_instance_id     varchar(100) not null,
    required_approvers       integer,
    required_roles           text,
    reviewer_comment         text,
    reviewer_id              varchar(255),
    status                   varchar(30)  not null,
    updated_at               timestamp(6) not null,
    request_id               varchar(100) not null
        unique,
    action_type              varchar(50),
    approval_comment         text,
    approval_timeout         integer,
    approval_type            varchar(50),
    approved_at              timestamp(6),
    approved_by              varchar(255),
    incident_id              varchar(100),
    requested_by             varchar(255),
    risk_level               varchar(20),
    session_id               varchar(128),
    tool_name                varchar(255),
    approved_count           integer,
    rejected_count           integer,
    remaining_approvals      integer,
    quorum_satisfied         boolean default false,
    current_step_number      integer,
    total_steps              integer,
    reopened_from_request_id varchar(100),
    break_glass_requested    boolean default false,
    break_glass_reason       text
);

create table soar_approval_steps
(
    id                  bigserial
        primary key,
    request_id          varchar(100) not null,
    step_number         integer      not null,
    step_name           varchar(150) not null,
    status              varchar(30)  not null,
    required_approvers  integer      not null,
    approved_count      integer      not null,
    rejected_count      integer      not null,
    remaining_approvals integer      not null,
    required_roles      text,
    opened_at           timestamp(6),
    completed_at        timestamp(6),
    created_at          timestamp(6) not null,
    updated_at          timestamp(6) not null,
    constraint uk_soar_approval_step_request_number
        unique (request_id, step_number)
);


create index idx_soar_approval_step_request_id
    on soar_approval_steps (request_id);

create index idx_soar_approval_step_status
    on soar_approval_steps (status);

create table soar_approval_assignments
(
    id                bigserial
        primary key,
    request_id        varchar(100) not null,
    step_number       integer      not null,
    assignee_id       varchar(100),
    assignee_role     varchar(100),
    status            varchar(30)  not null,
    assigned_by       varchar(100),
    assigned_at       timestamp(6),
    responded_at      timestamp(6),
    response_decision varchar(30),
    response_comment  text,
    created_at        timestamp(6) not null,
    updated_at        timestamp(6) not null
);


create index idx_soar_approval_assignment_request_id
    on soar_approval_assignments (request_id);

create index idx_soar_approval_assignment_status
    on soar_approval_assignments (status);

create index idx_soar_approval_assignment_step
    on soar_approval_assignments (request_id, step_number);

create table soar_approval_votes
(
    id            bigserial
        primary key,
    request_id    varchar(100) not null,
    approver_id   varchar(100) not null,
    approver_name varchar(150),
    approver_role varchar(100) not null,
    decision      varchar(20)  not null,
    comment       text,
    step_number   integer      not null,
    created_at    timestamp(6) not null,
    updated_at    timestamp(6) not null,
    constraint uk_soar_approval_vote_request_approver_step
        unique (request_id, approver_id, step_number)
);


create index idx_soar_approval_vote_request_id
    on soar_approval_votes (request_id);

create index idx_soar_approval_vote_decision
    on soar_approval_votes (decision);

create index idx_soar_approval_vote_created_at
    on soar_approval_votes (created_at);

create index idx_soar_approval_vote_request_step
    on soar_approval_votes (request_id, step_number);

create table approval_notifications
(
    id                bigserial
        primary key,
    action_required   boolean      not null,
    action_url        varchar(500),
    created_at        timestamp(6) not null,
    expires_at        timestamp(6),
    group_id          varchar(100),
    is_read           boolean      not null,
    message           text,
    notification_data text,
    notification_type varchar(50)  not null,
    priority          varchar(20),
    read_at           timestamp(6),
    read_by           varchar(100),
    request_id        varchar(100) not null,
    target_role       varchar(50),
    title             varchar(255) not null,
    updated_at        timestamp(6) not null,
    user_id           varchar(100)
);


create index idx_notification_request_id
    on approval_notifications (request_id);

create index idx_notification_user_id
    on approval_notifications (user_id);

create index idx_notification_is_read
    on approval_notifications (is_read);

create index idx_notification_created_at
    on approval_notifications (created_at);

create table threat_indicators
(
    indicator_id         varchar(100)  not null
        primary key,
    active               boolean,
    campaign             varchar(255),
    campaign_id          varchar(100),
    cis_control          varchar(100),
    confidence           double precision,
    created_at           timestamp(6)  not null,
    description          text,
    detected_at          timestamp(6),
    detection_count      integer,
    expires_at           timestamp(6),
    false_positive_count integer,
    first_seen           timestamp(6),
    last_seen            timestamp(6),
    malware_family       varchar(255),
    mitre_attack_id      varchar(50),
    mitre_tactic         varchar(100),
    mitre_technique      varchar(100),
    nist_csf_category    varchar(100),
    severity             varchar(255)  not null
        constraint threat_indicators_severity_check
            check ((severity)::text = ANY
                   (ARRAY [('CRITICAL'::character varying)::text, ('HIGH'::character varying)::text, ('MEDIUM'::character varying)::text, ('LOW'::character varying)::text, ('INFO'::character varying)::text])),
    source               varchar(255),
    status               varchar(255)
        constraint threat_indicators_status_check
            check ((status)::text = ANY
                   ((ARRAY ['ACTIVE'::character varying, 'INACTIVE'::character varying, 'EXPIRED'::character varying, 'FALSE_POSITIVE'::character varying, 'UNDER_REVIEW'::character varying])::text[])),
    threat_actor         varchar(255),
    threat_actor_id      varchar(100),
    threat_score         double precision,
    indicator_type       varchar(255)  not null
        constraint threat_indicators_indicator_type_check
            check ((indicator_type)::text = ANY
                   ((ARRAY ['IP_ADDRESS'::character varying, 'DOMAIN'::character varying, 'URL'::character varying, 'FILE_HASH'::character varying, 'FILE_PATH'::character varying, 'REGISTRY_KEY'::character varying, 'PROCESS_NAME'::character varying, 'EMAIL_ADDRESS'::character varying, 'USER_AGENT'::character varying, 'CERTIFICATE'::character varying, 'MUTEX'::character varying, 'YARA_RULE'::character varying, 'BEHAVIORAL'::character varying, 'UNKNOWN'::character varying, 'PATTERN'::character varying, 'USER_ACCOUNT'::character varying, 'COMPLIANCE'::character varying, 'EVENT'::character varying])::text[])),
    updated_at           timestamp(6),
    indicator_value      varchar(1024) not null
);

create table indicator_metadata
(
    indicator_id varchar(100) not null
        references threat_indicators,
    meta_value   varchar(255),
    meta_key     varchar(255) not null,
    primary key (indicator_id, meta_key)
);

create table indicator_tags
(
    indicator_id varchar(100) not null
        references threat_indicators,
    tag          varchar(255)
);

create table related_indicators
(
    indicator_id         varchar(100) not null
        references threat_indicators,
    related_indicator_id varchar(100) not null
        references threat_indicators,
    primary key (indicator_id, related_indicator_id)
);

create table blocked_user
(
    id                   bigserial
        primary key,
    block_count          integer      not null,
    blocked_at           timestamp(6) not null,
    confidence           double precision,
    reasoning            text,
    request_id           varchar(255) not null
        unique,
    resolve_reason       text,
    resolved_action      varchar(255),
    resolved_at          timestamp(6),
    resolved_by          varchar(255),
    risk_score           double precision,
    source_ip            varchar(255),
    status               varchar(255) not null
        constraint blocked_user_status_check
            check ((status)::text = ANY
                   (ARRAY [('BLOCKED'::character varying)::text, ('UNBLOCK_REQUESTED'::character varying)::text, ('RESOLVED'::character varying)::text, ('TIMEOUT_RESPONDED'::character varying)::text, ('MFA_FAILED'::character varying)::text])),
    user_agent           varchar(255),
    user_id              varchar(255) not null,
    username             varchar(255),
    unblock_requested_at timestamp(6),
    unblock_reason       text,
    mfa_verified         boolean,
    mfa_verified_at      timestamp(6)
);

create table oauth2_authorization
(
    id                            varchar(100) not null
        primary key,
    registered_client_id          varchar(100) not null,
    principal_name                varchar(200) not null,
    authorization_grant_type      varchar(100) not null,
    authorized_scopes             varchar(1000),
    attributes                    text,
    state                         varchar(500),
    authorization_code_value      text,
    authorization_code_issued_at  timestamp,
    authorization_code_expires_at timestamp,
    authorization_code_metadata   text,
    access_token_value            text,
    access_token_issued_at        timestamp,
    access_token_expires_at       timestamp,
    access_token_metadata         text,
    access_token_type             varchar(100),
    access_token_scopes           varchar(1000),
    oidc_id_token_value           text,
    oidc_id_token_issued_at       timestamp,
    oidc_id_token_expires_at      timestamp,
    oidc_id_token_metadata        text,
    refresh_token_value           text,
    refresh_token_issued_at       timestamp,
    refresh_token_expires_at      timestamp,
    refresh_token_metadata        text,
    user_code_value               text,
    user_code_issued_at           timestamp,
    user_code_expires_at          timestamp,
    user_code_metadata            text,
    device_code_value             text,
    device_code_issued_at         timestamp,
    device_code_expires_at        timestamp,
    device_code_metadata          text
);


create index idx_oauth2_authorization_registered_client_id
    on oauth2_authorization (registered_client_id);

create index idx_oauth2_authorization_principal_name
    on oauth2_authorization (principal_name);

create table oauth2_registered_client
(
    id                            varchar(100)                        not null
        primary key,
    client_id                     varchar(100)                        not null,
    client_id_issued_at           timestamp default CURRENT_TIMESTAMP not null,
    client_secret                 varchar(200),
    client_secret_expires_at      timestamp,
    client_name                   varchar(200)                        not null,
    client_authentication_methods varchar(1000)                       not null,
    authorization_grant_types     varchar(1000)                       not null,
    redirect_uris                 varchar(1000),
    post_logout_redirect_uris     varchar(1000),
    scopes                        varchar(1000)                       not null,
    client_settings               varchar(2000)                       not null,
    token_settings                varchar(2000)                       not null
);


create unique index idx_oauth2_registered_client_client_id
    on oauth2_registered_client (client_id);

create table user_credentials
(
    credential_id                varchar(1000) not null
        primary key,
    user_entity_user_id          varchar(1000) not null,
    public_key                   bytea         not null,
    signature_count              bigint,
    uv_initialized               boolean,
    backup_eligible              boolean       not null,
    authenticator_transports     varchar(1000),
    public_key_credential_type   varchar(100),
    backup_state                 boolean       not null,
    attestation_object           bytea,
    attestation_client_data_json bytea,
    created                      timestamp,
    last_used                    timestamp,
    label                        varchar(1000) not null
);

create table user_entities
(
    id           varchar(1000) not null
        primary key,
    name         varchar(100)  not null,
    display_name varchar(200)
);

create table one_time_tokens
(
    token_value varchar(36) not null
        primary key,
    username    varchar(50) not null,
    expires_at  timestamp   not null
);

create table oauth2_authorization_consent
(
    registered_client_id varchar(100)  not null
        references oauth2_registered_client,
    principal_name       varchar(200)  not null,
    authorities          varchar(1000) not null,
    primary key (registered_client_id, principal_name)
);

create table baseline_signal_outbox
(
    id                                 bigint generated by default as identity
        primary key,
    access_days_distribution_json      text,
    access_hours_distribution_json     text,
    attempt_count                      integer      not null,
    created_at                         timestamp(6) not null,
    delivered_at                       timestamp(6),
    generated_at                       timestamp(6),
    industry_category                  varchar(80),
    last_error                         varchar(2000),
    next_attempt_at                    timestamp(6),
    operating_system_distribution_json text,
    organization_baseline_count        bigint       not null,
    period_start                       date         not null
        constraint uk_baseline_signal_outbox_period
            unique,
    signal_id                          varchar(64)  not null,
    status                             varchar(32)  not null,
    updated_at                         timestamp(6) not null,
    user_baseline_count                bigint       not null
);


create index idx_baseline_signal_outbox_dispatch
    on baseline_signal_outbox (status, next_attempt_at, period_start);

create table decision_feedback_forwarding_outbox
(
    id                  bigint generated by default as identity
        primary key,
    attempt_count       integer      not null,
    correlation_id      varchar(64)  not null,
    created_at          timestamp(6) not null,
    delivered_at        timestamp(6),
    feedback_id         varchar(64)  not null
        constraint uk_decision_feedback_forwarding_outbox_feedback_id
            unique,
    last_error          varchar(2000),
    next_attempt_at     timestamp(6),
    payload_json        text         not null,
    status              varchar(32)  not null,
    tenant_external_ref varchar(128) not null,
    updated_at          timestamp(6) not null
);


create index idx_decision_feedback_forwarding_outbox_dispatch
    on decision_feedback_forwarding_outbox (status, next_attempt_at, created_at);

create table model_performance_telemetry_outbox
(
    id                            bigint generated by default as identity
        primary key,
    attempt_count                 integer      not null,
    block_count                   bigint       not null,
    challenge_count               bigint       not null,
    created_at                    timestamp(6) not null,
    delivered_at                  timestamp(6),
    escalate_protection_triggered integer      not null,
    last_error                    varchar(2000),
    layer1_escalation_count       bigint       not null,
    layer1_processing_total_ms    bigint       not null,
    layer1_sample_count           bigint       not null,
    layer2_processing_total_ms    bigint       not null,
    layer2_sample_count           bigint       not null,
    next_attempt_at               timestamp(6),
    period                        date         not null
        constraint uk_model_performance_telemetry_outbox_period
            unique,
    status                        varchar(32)  not null,
    telemetry_id                  varchar(64)  not null,
    total_event_count             bigint       not null,
    updated_at                    timestamp(6) not null
);


create index idx_model_performance_telemetry_outbox_dispatch
    on model_performance_telemetry_outbox (status, next_attempt_at, period);

create table prompt_context_audit_forwarding_outbox
(
    id                  bigint generated by default as identity
        primary key,
    attempt_count       integer      not null,
    audit_id            varchar(64)  not null
        constraint uk_prompt_context_audit_forwarding_outbox_audit_id
            unique,
    correlation_id      varchar(64)  not null,
    created_at          timestamp(6) not null,
    delivered_at        timestamp(6),
    last_error          varchar(2000),
    next_attempt_at     timestamp(6),
    payload_json        text         not null,
    status              varchar(32)  not null,
    tenant_external_ref varchar(128) not null,
    updated_at          timestamp(6) not null
);


create index idx_prompt_context_audit_forwarding_outbox_dispatch
    on prompt_context_audit_forwarding_outbox (status, next_attempt_at, created_at);

create table security_decision_forwarding_outbox
(
    id                  bigint generated by default as identity
        primary key,
    attempt_count       integer      not null,
    correlation_id      varchar(64)  not null
        constraint uk_security_decision_forwarding_outbox_correlation_id
            unique,
    created_at          timestamp(6) not null,
    delivered_at        timestamp(6),
    last_error          varchar(2000),
    next_attempt_at     timestamp(6),
    payload_json        text         not null,
    status              varchar(32)  not null,
    tenant_external_ref varchar(128) not null,
    updated_at          timestamp(6) not null
);


create index idx_security_decision_forwarding_outbox_dispatch
    on security_decision_forwarding_outbox (status, next_attempt_at, created_at);

create table threat_outcome_forwarding_outbox
(
    id                  bigint generated by default as identity
        primary key,
    attempt_count       integer      not null,
    correlation_id      varchar(64)  not null,
    created_at          timestamp(6) not null,
    delivered_at        timestamp(6),
    last_error          varchar(2000),
    next_attempt_at     timestamp(6),
    outcome_id          varchar(64)  not null
        constraint uk_threat_outcome_forwarding_outbox_outcome_id
            unique,
    payload_json        text         not null,
    status              varchar(32)  not null,
    tenant_external_ref varchar(128) not null,
    updated_at          timestamp(6) not null
);


create index idx_threat_outcome_forwarding_outbox_dispatch
    on threat_outcome_forwarding_outbox (status, next_attempt_at, created_at);

create table user_roles
(
    role_id     bigint       not null
        constraint fkrhfovtciq1l558cw6udg0h0d3
            references role,
    user_id     bigint       not null
        constraint fkhfh9dx7w3ubf1co1vdev94g3f
            references users,
    assigned_at timestamp(6) not null,
    assigned_by varchar(100),
    primary key (role_id, user_id)
);

create table password_policy
(
    id                       bigint generated by default as identity
        primary key,
    created_at               timestamp(6) not null,
    history_count            integer      not null,
    lockout_duration_minutes integer      not null,
    max_failed_attempts      integer      not null,
    max_length               integer      not null,
    min_length               integer      not null,
    password_expiry_days     integer      not null,
    require_digit            boolean      not null,
    require_lowercase        boolean      not null,
    require_special_char     boolean      not null,
    require_uppercase        boolean      not null,
    updated_at               timestamp(6)
);

create table behavior_anomaly_events
(
    id                 bigint generated by default as identity
        primary key,
    action_taken       varchar(100),
    action_timestamp   timestamp(6),
    activity           varchar(500),
    admin_feedback     varchar(20),
    ai_analysis_id     varchar(255),
    ai_confidence      real,
    ai_summary         text,
    anomaly_factors    json,
    anomaly_score      double precision not null,
    event_timestamp    timestamp(6)     not null,
    feedback_by        varchar(255),
    feedback_comment   text,
    feedback_timestamp timestamp(6),
    remote_ip          varchar(45),
    risk_level         varchar(20),
    user_id            varchar(255)     not null
);

create table behavior_based_permissions
(
    id                    bigint generated by default as identity
        primary key,
    is_active             boolean,
    applicable_to         varchar(50),
    condition_expression  text,
    created_at            timestamp(6),
    created_by            varchar(255),
    description           text,
    permission_adjustment varchar(50),
    priority              integer
);

create table behavior_realtime_cache
(
    user_id                 varchar(255) not null
        primary key,
    current_risk_score      real,
    current_session_id      varchar(255),
    expires_at              timestamp(6),
    last_activity_timestamp timestamp(6),
    recent_activities       json,
    risk_factors            json,
    session_ip              varchar(45),
    session_start_time      timestamp(6)
);

create table document
(
    document_id    bigint generated by default as identity
        primary key,
    content        text,
    created_at     timestamp(6) not null,
    owner_username varchar(255) not null,
    title          varchar(255) not null,
    updated_at     timestamp(6)
);

create table bridge_user_profile
(
    user_id                     bigint       not null
        primary key
        constraint fk6ln576ijwr4i3kdbqmfjyedeo
            references users,
    authentication_assurance    varchar(100),
    authentication_type         varchar(100),
    created_at                  timestamp(6) not null,
    last_attributes_json        text,
    last_authorities_json       text,
    last_sync_hash              varchar(128),
    last_synced_at              timestamp(6),
    mfa_completed_from_customer boolean,
    session_id                  varchar(255),
    source_system               varchar(100),
    updated_at                  timestamp(6)
);

create table active_sessions
(
    session_id       varchar(128) not null
        primary key,
    client_ip        varchar(45),
    created_at       timestamp(6) not null,
    expired          boolean      not null,
    last_accessed_at timestamp(6),
    user_agent       varchar(512),
    user_id          varchar(255) not null,
    username         varchar(255)
);


create index idx_session_user_id
    on active_sessions (user_id);

create index idx_session_expired
    on active_sessions (expired);

create table ip_access_rules
(
    id          bigint generated by default as identity
        primary key,
    created_at  timestamp(6) not null,
    created_by  varchar(255),
    description varchar(500),
    enabled     boolean      not null,
    expires_at  timestamp(6),
    ip_address  varchar(45)  not null,
    rule_type   varchar(10)  not null
        constraint ip_access_rules_rule_type_check
            check ((rule_type)::text = ANY ((ARRAY ['ALLOW'::character varying, 'DENY'::character varying])::text[]))
);


create index idx_ip_rule_type
    on ip_access_rules (rule_type);

create index idx_ip_rule_enabled
    on ip_access_rules (enabled);

create index idx_ip_address
    on ip_access_rules (ip_address);

create table security_spel
(
    id          bigserial
        primary key,
    name        varchar(255)  not null
        unique,
    expression  varchar(2048) not null,
    description varchar(1024),
    category    varchar(100),
    created_at  timestamp default now()
);

create table admin_menu
(
    id         bigserial
        primary key,
    name       varchar(100) not null,
    menu_type  varchar(20)  not null,
    enabled    boolean      not null,
    menu_order integer      not null,
    parent_id  bigint,
    data_page  varchar(50),
    icon       varchar(2000),
    url        varchar(255)
);

create table admin_menu_role
(
    id        bigserial
        primary key,
    menu_id   bigint       not null
        references admin_menu (id),
    role_name varchar(100) not null,
    constraint admin_menu_role_menu_id_role_name_key unique (menu_id, role_name)
);

create table group_role_permissions
(
    group_id      bigint       not null
        references app_group (group_id),
    role_id       bigint       not null
        references role (role_id),
    permission_id bigint       not null
        references permission (permission_id),
    assigned_at   timestamp(6) not null,
    assigned_by   varchar(100),
    primary key (group_id, role_id, permission_id)
);

create table user_role_permissions
(
    user_id       bigint       not null
        references users (id),
    role_id       bigint       not null
        references role (role_id),
    permission_id bigint       not null
        references permission (permission_id),
    assigned_at   timestamp(6) not null,
    assigned_by   varchar(100),
    primary key (user_id, role_id, permission_id)
);

create table password_history
(
    id            bigserial
        primary key,
    user_id       bigint       not null,
    password_hash varchar(512) not null,
    changed_at    timestamp(6) not null
);

create table policy_version
(
    id             bigserial
        primary key,
    policy_id      bigint       not null,
    version_number integer      not null,
    change_type    varchar(20)  not null
        constraint policy_version_change_type_check
            check ((change_type)::text = ANY
                   ((ARRAY ['CREATED'::character varying, 'UPDATED'::character varying, 'DELETED'::character varying, 'ROLLBACK'::character varying])::text[])),
    change_reason  varchar(1024),
    changed_by     varchar(255) not null,
    changed_at     timestamp(6) not null,
    snapshot_json  text         not null
);

create index idx_policy_version_changed_at on policy_version (changed_at);
create index idx_policy_version_policy_id  on policy_version (policy_id);

create table system_settings
(
    id                         bigserial
        primary key,
    audit_log_retention_days   integer      not null,
    registration_enabled       boolean      not null,
    policy_combining_algorithm varchar(50)  not null,
    default_role               varchar(100) not null,
    created_at                 timestamp(6) not null,
    updated_at                 timestamp(6)
);

`;
}

function getDmlScript(seedBcryptHash) {
  if (!seedBcryptHash || typeof seedBcryptHash !== 'string') {
    throw new Error('getDmlScript requires a seedBcryptHash argument');
  }
  const template = `-- ============================================================
-- Contexa AI-Native Zero Trust Security Platform
-- Initial Data (DML)
-- Version: 0.1.0
-- ============================================================
-- Run AFTER ddlScript.sql
-- Password: BCrypt encoded random password (generated at init time, see init output)
-- ============================================================

-- ============================================================
-- 1. Roles
-- ============================================================

INSERT INTO role (role_name, role_desc, expression, enabled, created_at, created_by) VALUES
    ('ROLE_ADMIN',   'System administrator with full access',    FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('ROLE_MANAGER', 'Manager with team-level access',           FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('ROLE_USER',    'Standard user with basic access',          FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('ROLE_DEVELOPER', 'Developer with API and resource access', FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM');

-- ============================================================
-- 2. Groups
-- ============================================================

INSERT INTO app_group (group_name, description, enabled, created_at, created_by) VALUES
    ('Administrators', 'System administrators group',           TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('Managers',       'Team managers group',                   TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('Users',          'Standard users group',                  TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('Developers',     'Developers and engineers group',        TRUE, CURRENT_TIMESTAMP, 'SYSTEM');

-- ============================================================
-- 3. Group-Role Assignments
-- ============================================================

INSERT INTO group_roles (group_id, role_id, assigned_at, assigned_by)
SELECT g.group_id, r.role_id, CURRENT_TIMESTAMP, 'SYSTEM'
FROM app_group g, role r
WHERE (g.group_name = 'Administrators' AND r.role_name IN ('ROLE_ADMIN', 'ROLE_MANAGER', 'ROLE_USER'))
   OR (g.group_name = 'Managers'       AND r.role_name IN ('ROLE_MANAGER', 'ROLE_USER'))
   OR (g.group_name = 'Users'          AND r.role_name IN ('ROLE_USER'))
   OR (g.group_name = 'Developers'     AND r.role_name IN ('ROLE_DEVELOPER', 'ROLE_USER'));

-- ============================================================
-- 4. Users (Seed password: random, see contexa init output)
-- ============================================================

INSERT INTO users (username, email, password, name, phone, department, position, enabled, mfa_enabled, account_locked, bridge_managed, credentials_expired, external_auth_only, failed_login_attempts, created_at) VALUES
    ('admin',       'admin@contexa.io',       '{bcrypt}__SEED_BCRYPT_HASH__', 'System Admin',   '010-0000-0001', 'IT',          'Administrator', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    ('kim_manager', 'kim.manager@contexa.io', '{bcrypt}__SEED_BCRYPT_HASH__', 'Kim Jihoon',     '010-0000-0002', 'Finance',     'Manager',       TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    ('park_user',   'park.user@contexa.io',   '{bcrypt}__SEED_BCRYPT_HASH__', 'Park Minjun',    '010-0000-0003', 'Engineering', 'Developer',     TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    ('dev_lead',    'dev.lead@contexa.io',    '{bcrypt}__SEED_BCRYPT_HASH__', 'Lee Soyeon',     '010-0000-0004', 'Engineering', 'Tech Lead',     TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP);

-- ============================================================
-- 5. User-Group Assignments
-- ============================================================

INSERT INTO user_groups (user_id, group_id, assigned_at, assigned_by)
SELECT u.id, g.group_id, CURRENT_TIMESTAMP, 'SYSTEM'
FROM users u, app_group g
WHERE (u.username = 'admin'       AND g.group_name = 'Administrators')
   OR (u.username = 'kim_manager' AND g.group_name = 'Managers')
   OR (u.username = 'park_user'   AND g.group_name = 'Users')
   OR (u.username = 'dev_lead'    AND g.group_name = 'Developers');

INSERT INTO permission (permission_name, friendly_name, description, auto_created, target_type, action_type, created_at)
VALUES
    ('READ', 'Read Access', 'Permission to read/view resources', false, 'CRUD', 'READ', CURRENT_TIMESTAMP),
    ('WRITE', 'Write Access', 'Permission to create new resources', false, 'CRUD', 'WRITE', CURRENT_TIMESTAMP),
    ('UPDATE', 'Update Access', 'Permission to modify existing resources', false, 'CRUD', 'UPDATE', CURRENT_TIMESTAMP),
    ('DELETE', 'Delete Access', 'Permission to remove resources', false, 'CRUD', 'DELETE', CURRENT_TIMESTAMP)
ON CONFLICT (permission_name) DO NOTHING;
`;
  return template.split('__SEED_BCRYPT_HASH__').join(seedBcryptHash);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Inject Redis/Kafka client dependencies for the distributed PoC profile.
// Idempotent — silently does nothing if any of the markers already exist.
//
// spring-kafka version is omitted: Spring Boot's BOM manages it. redisson's
// version can be overridden via CONTEXA_REDISSON_VERSION env var so that
// customers whose own BOM pins a different redisson can avoid a clash.
async function injectDistributedDeps(buildPath) {
  if (!buildPath || !await fs.pathExists(buildPath)) return false;
  const content = await fs.readFile(buildPath, 'utf8');
  const redissonVersion = process.env.CONTEXA_REDISSON_VERSION || '3.48.0';

  if (buildPath.endsWith('.xml')) {
    if (content.includes('spring-kafka') && content.includes('redisson')) return false;
    const additions = [];
    if (!content.includes('spring-kafka')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.kafka</groupId>\n` +
        `            <artifactId>spring-kafka</artifactId>\n` +
        `        </dependency>`);
    }
    if (!content.includes('redisson')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.redisson</groupId>\n` +
        `            <artifactId>redisson</artifactId>\n` +
        `            <version>${redissonVersion}</version>\n` +
        `        </dependency>`);
    }
    if (additions.length === 0) return false;

    // Reuse the same project-level <dependencies> location logic.
    const mgmtRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
    const mgmtRanges = [];
    let m;
    while ((m = mgmtRegex.exec(content)) !== null) mgmtRanges.push([m.index, m.index + m[0].length]);
    const isInsideMgmt = (idx) => mgmtRanges.some(([a, b]) => idx >= a && idx < b);
    let target = -1, cursor = 0;
    while (true) {
      const found = content.indexOf('</dependencies>', cursor);
      if (found === -1) break;
      if (!isInsideMgmt(found)) { target = found; break; }
      cursor = found + 1;
    }
    if (target === -1) return false;

    const block = additions.join('\n') + '\n    ';
    const updated = content.slice(0, target) + block + content.slice(target);
    await fs.writeFile(buildPath, updated);
    return true;
  }

  // Gradle (Groovy or Kotlin DSL)
  const isKts = buildPath.endsWith('.kts');
  const lines = [];
  if (!content.includes('spring-kafka')) {
    lines.push(isKts
      ? `    implementation("org.springframework.kafka:spring-kafka")`
      : `    implementation 'org.springframework.kafka:spring-kafka'`);
  }
  if (!content.includes('redisson')) {
    lines.push(isKts
      ? `    implementation("org.redisson:redisson:${redissonVersion}")`
      : `    implementation 'org.redisson:redisson:${redissonVersion}'`);
  }
  if (lines.length === 0) return false;
  const updated = content.replace(/dependencies\s*\{/, `dependencies {\n${lines.join('\n')}`);
  await fs.writeFile(buildPath, updated);
  return true;
}

module.exports = { injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps, generateDockerCompose, generateInitDbScripts };
