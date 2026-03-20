'use strict';

const fs = require('fs-extra');
const path = require('path');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';

const CONTEXA_GROUP_ID = 'io.contexa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';
const CONTEXA_VERSION = '0.1.0';

async function injectYml(ymlPath, opts = {}) {
  const { mode = 'shadow', llmProviders = ['ollama'],
          securityMode = 'full', infra = 'standalone' } = opts;

  const priority = llmProviders.join(',');
  const embeddingPriority = llmProviders.filter(p => p !== 'anthropic').join(',') || 'ollama';
  const lines = [];

  // ── contexa ──
  lines.push('contexa:');
  lines.push('  llm:');
  lines.push(`    chatModelPriority: ${priority}`);
  lines.push(`    embeddingModelPriority: ${embeddingPriority}`);
  if (infra === 'distributed') {
    lines.push('  infrastructure:');
    lines.push('    mode: DISTRIBUTED');
  }

  // ── security.zerotrust ──
  lines.push('');
  lines.push('security:');
  lines.push('  zerotrust:');
  lines.push(`    mode: ${mode === 'enforce' ? 'ENFORCE' : 'SHADOW'}`);

  // ── hcad ──
  lines.push('');
  lines.push('hcad:');
  lines.push('  geoip:');
  lines.push('    dbPath: data/GeoLite2-City.mmdb');

  // ── spring ──
  lines.push('');
  lines.push('spring:');
  lines.push('  datasource:');
  lines.push('    url: jdbc:postgresql://localhost:5432/contexa');
  lines.push('    username: contexa');
  lines.push('    password: contexa1234!@#');
  lines.push('    driver-class-name: org.postgresql.Driver');
  lines.push('  auth:');
  lines.push('    token-transport-type: header_cookie');
  lines.push('    oauth2-csrf: false');
  lines.push('    token-persistence: localstorage');

  // ── spring.ai (selected providers only) ──
  lines.push('  ai:');
  if (llmProviders.includes('ollama')) {
    lines.push('    ollama:');
    lines.push('      base-url: http://127.0.0.1:11434');
    lines.push('      chat:');
    lines.push('        options:');
    lines.push('          model: qwen2.5:7b');
    lines.push('          keep-alive: "24h"');
    lines.push('      embedding:');
    lines.push('        model: mxbai-embed-large');
  }
  if (llmProviders.includes('openai')) {
    lines.push('    openai:');
    lines.push('      api-key: ${OPENAI_API_KEY:your-openai-api-key}');
    lines.push('      base-url: https://api.openai.com');
    lines.push('      chat:');
    lines.push('        options:');
    lines.push('          model: gpt-4o-mini');
    lines.push('          temperature: 0.3');
  }
  if (llmProviders.includes('anthropic')) {
    lines.push('    anthropic:');
    lines.push('      api-key: ${ANTHROPIC_API_KEY:your-anthropic-api-key}');
    lines.push('      chat:');
    lines.push('        options:');
    lines.push('          model: claude-3-sonnet-20240229');
  } else {
    // Anthropic bean requires api-key even when disabled
    lines.push('    anthropic:');
    lines.push('      api-key: ${ANTHROPIC_API_KEY:your-anthropic-api-key}');
  }
  lines.push('    security:');
  lines.push('      tiered:');
  lines.push('        security:');
  lines.push('          trusted-proxy-validation-enabled: true');
  lines.push('          trusted-proxies:');
  lines.push('            - "127.0.0.1"');
  lines.push('            - "::1"');
  lines.push('            - "0:0:0:0:0:0:0:1"');
  lines.push('    vectorstore:');
  lines.push('      pgvector:');
  lines.push('        dimensions: 1024');
  lines.push('        initialize-schema: true');
  lines.push('  jpa:');
  lines.push('    database: POSTGRESQL');
  lines.push('    hibernate:');
  lines.push('      ddl-auto: validate');
  lines.push('    properties:');
  lines.push('      hibernate:');
  lines.push('        jdbc:');
  lines.push('          lob:');
  lines.push('            non_contextual_creation: true');
  lines.push('    show-sql: false');

  // ── spring.data.redis (distributed only) ──
  if (infra === 'distributed') {
    lines.push('  data:');
    lines.push('    redis:');
    lines.push('      host: localhost');
    lines.push('      port: 6379');
  }

  const block = `\n${MARKER_START}\n${lines.join('\n')}\n${MARKER_END}`;

  await fs.ensureDir(path.dirname(ymlPath));

  if (await fs.pathExists(ymlPath)) {
    await fs.copy(ymlPath, ymlPath + '.bak');
    let content = await fs.readFile(ymlPath, 'utf8');
    const regex = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`);
    content = content.match(regex)
      ? content.replace(regex, block.trim())
      : content + block;
    await fs.writeFile(ymlPath, content);
  } else {
    await fs.writeFile(ymlPath, block.trim());
  }
}

async function injectMavenDep(pomPath) {
  if (!await fs.pathExists(pomPath)) return false;
  let pom = await fs.readFile(pomPath, 'utf8');
  if (pom.includes(CONTEXA_ARTIFACT_ID)) return false;

  // Backup
  await fs.copy(pomPath, pomPath + '.bak');

  const dep = `
        <dependency>
            <groupId>${CONTEXA_GROUP_ID}</groupId>
            <artifactId>${CONTEXA_ARTIFACT_ID}</artifactId>
            <version>${CONTEXA_VERSION}</version>
        </dependency>`;
  pom = pom.replace('</dependencies>', `${dep}\n    </dependencies>`);
  await fs.writeFile(pomPath, pom);
  return true;
}

async function injectGradleDep(gradlePath) {
  if (!await fs.pathExists(gradlePath)) return false;
  let gradle = await fs.readFile(gradlePath, 'utf8');
  if (gradle.includes(CONTEXA_ARTIFACT_ID)) return false;

  // Backup
  await fs.copy(gradlePath, gradlePath + '.bak');

  gradle = gradle.replace(
    /dependencies\s*\{/,
    `dependencies {\n    implementation '${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}'`
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
services:
  # PostgreSQL with PGVector
  postgres:
    image: pgvector/pgvector:pg16
    container_name: contexa-postgres
    environment:
      POSTGRES_DB: contexa
      POSTGRES_USER: contexa
      POSTGRES_PASSWORD: contexa1234!@#
      POSTGRES_INITDB_ARGS: "-E UTF8 --locale=C"
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U contexa -d contexa"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # Ollama - Local LLM for AI security analysis
  ollama:
    image: ollama/ollama:latest
    container_name: contexa-ollama
    ports:
      - "11434:11434"
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
  # Redis - Session store, cache, distributed locks
  redis:
    image: redis:7.2-alpine
    container_name: contexa-redis
    ports:
      - "6379:6379"
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
      - "2181:2181"
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
      - "9092:9092"
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

async function generateInitDbScripts(projectDir, opts = {}) {
  const { enterprise = false } = opts;
  const initdbDir = path.join(projectDir, 'initdb');
  await fs.ensureDir(initdbDir);

  // 01-ddl.sql (numbered for execution order)
  await fs.writeFile(path.join(initdbDir, '01-ddl.sql'), getDdlScript());

  // 02-dml.sql
  await fs.writeFile(path.join(initdbDir, '02-dml.sql'), getDmlScript());

  // 03-enterprise.sql (optional)
  if (enterprise) {
    await fs.writeFile(path.join(initdbDir, '03-enterprise.sql'), getEnterpriseDdlScript());
  }

  return initdbDir;
}

function getDdlScript() {
  return `-- Contexa DDL - Auto-generated by contexa init
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id                      BIGSERIAL PRIMARY KEY,
    username                VARCHAR(100) NOT NULL UNIQUE,
    email                   VARCHAR(255) NOT NULL UNIQUE,
    password                VARCHAR(255) NOT NULL,
    name                    VARCHAR(100) NOT NULL,
    phone                   VARCHAR(20),
    department              VARCHAR(100),
    position                VARCHAR(100),
    profile_image_url       VARCHAR(500),
    enabled                 BOOLEAN DEFAULT TRUE NOT NULL,
    account_locked          BOOLEAN DEFAULT FALSE NOT NULL,
    credentials_expired     BOOLEAN DEFAULT FALSE NOT NULL,
    failed_login_attempts   INTEGER DEFAULT 0 NOT NULL,
    lock_expires_at         TIMESTAMP(6),
    mfa_enabled             BOOLEAN DEFAULT FALSE NOT NULL,
    preferred_mfa_factor    VARCHAR(50),
    last_used_mfa_factor    VARCHAR(50),
    last_mfa_used_at        TIMESTAMP(6),
    last_login_at           TIMESTAMP(6),
    last_login_ip           VARCHAR(45),
    password_changed_at     TIMESTAMP(6),
    locale                  VARCHAR(10) DEFAULT 'ko',
    timezone                VARCHAR(50) DEFAULT 'Asia/Seoul',
    created_at              TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP(6)
);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_department ON users (department);
CREATE INDEX idx_users_enabled ON users (enabled);

CREATE TABLE app_group (
    group_id    BIGSERIAL PRIMARY KEY,
    group_name  VARCHAR(100) NOT NULL UNIQUE,
    description VARCHAR(500),
    enabled     BOOLEAN DEFAULT TRUE NOT NULL,
    created_at  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP(6),
    created_by  VARCHAR(100)
);

CREATE TABLE role (
    role_id       BIGSERIAL PRIMARY KEY,
    role_name     VARCHAR(100) NOT NULL UNIQUE,
    role_desc     VARCHAR(500),
    is_expression BOOLEAN DEFAULT FALSE NOT NULL,
    enabled       BOOLEAN DEFAULT TRUE NOT NULL,
    created_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP(6),
    created_by    VARCHAR(100)
);

CREATE TABLE managed_resource (
    id                          BIGSERIAL PRIMARY KEY,
    resource_identifier         VARCHAR(512) NOT NULL UNIQUE,
    resource_type               VARCHAR(100) NOT NULL,
    http_method                 VARCHAR(10),
    friendly_name               VARCHAR(255),
    description                 VARCHAR(1024),
    service_owner               VARCHAR(100),
    parameter_types             VARCHAR(255),
    return_type                 VARCHAR(255),
    api_docs_url                VARCHAR(500),
    source_code_location        VARCHAR(500),
    status                      VARCHAR(50) DEFAULT 'NEEDS_DEFINITION' NOT NULL,
    created_at                  TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at                  TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    available_context_variables VARCHAR(1024)
);

CREATE TABLE permission (
    permission_id        BIGSERIAL PRIMARY KEY,
    permission_name      VARCHAR(255) NOT NULL UNIQUE,
    friendly_name        VARCHAR(255),
    description          VARCHAR(1024),
    target_type          VARCHAR(100),
    action_type          VARCHAR(100),
    condition_expression VARCHAR(2048),
    managed_resource_id  BIGINT UNIQUE REFERENCES managed_resource ON DELETE SET NULL,
    created_at           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP(6)
);

CREATE TABLE user_groups (
    user_id     BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
    group_id    BIGINT NOT NULL REFERENCES app_group ON DELETE CASCADE,
    assigned_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by VARCHAR(100),
    PRIMARY KEY (user_id, group_id)
);

CREATE TABLE group_roles (
    group_id    BIGINT NOT NULL REFERENCES app_group ON DELETE CASCADE,
    role_id     BIGINT NOT NULL REFERENCES role ON DELETE CASCADE,
    assigned_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by VARCHAR(100),
    PRIMARY KEY (group_id, role_id)
);

CREATE TABLE role_permissions (
    role_id       BIGINT NOT NULL REFERENCES role ON DELETE CASCADE,
    permission_id BIGINT NOT NULL REFERENCES permission ON DELETE CASCADE,
    assigned_at   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_by   VARCHAR(100),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE policy (
    id                   BIGSERIAL PRIMARY KEY,
    name                 VARCHAR(255) NOT NULL UNIQUE,
    description          VARCHAR(255),
    effect               VARCHAR(255) NOT NULL,
    priority             INTEGER NOT NULL,
    friendly_description VARCHAR(2048),
    ai_model             VARCHAR(255),
    approval_status      VARCHAR(50) CHECK (approval_status IN ('PENDING','APPROVED','REJECTED','NOT_REQUIRED')),
    approved_at          TIMESTAMP(6),
    approved_by          VARCHAR(255),
    confidence_score     DOUBLE PRECISION,
    source               VARCHAR(50) CHECK (source IN ('MANUAL','AI_GENERATED','AI_EVOLVED','IMPORTED')),
    updated_at           TIMESTAMP(6),
    created_at           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active            BOOLEAN DEFAULT TRUE NOT NULL
);

CREATE TABLE policy_target (
    id                BIGSERIAL PRIMARY KEY,
    policy_id         BIGINT NOT NULL REFERENCES policy ON DELETE CASCADE,
    target_type       VARCHAR(255) NOT NULL,
    target_identifier VARCHAR(255) NOT NULL,
    http_method       VARCHAR(255)
);

CREATE TABLE policy_rule (
    id          BIGSERIAL PRIMARY KEY,
    policy_id   BIGINT NOT NULL REFERENCES policy ON DELETE CASCADE,
    description VARCHAR(255)
);

CREATE TABLE policy_condition (
    id                   BIGSERIAL PRIMARY KEY,
    rule_id              BIGINT NOT NULL REFERENCES policy_rule ON DELETE CASCADE,
    condition_expression VARCHAR(2048) NOT NULL,
    authorization_phase  VARCHAR(255) DEFAULT 'PRE_AUTHORIZE' NOT NULL,
    description          VARCHAR(255)
);

CREATE TABLE role_hierarchy_config (
    hierarchy_id     BIGSERIAL PRIMARY KEY,
    description      VARCHAR(500),
    hierarchy_string TEXT NOT NULL UNIQUE,
    is_active        BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE audit_log (
    id                  BIGSERIAL PRIMARY KEY,
    timestamp           TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    principal_name      VARCHAR(255) NOT NULL,
    resource_identifier VARCHAR(512) NOT NULL,
    action              VARCHAR(255),
    decision            VARCHAR(255) NOT NULL,
    reason              VARCHAR(1024),
    client_ip           VARCHAR(45),
    details             TEXT,
    outcome             VARCHAR(255),
    resource_uri        VARCHAR(1024),
    session_id          VARCHAR(255),
    correlation_id      VARCHAR(64),
    event_category      VARCHAR(50),
    event_source        VARCHAR(50),
    http_method         VARCHAR(10),
    request_uri         VARCHAR(2048),
    risk_score          DOUBLE PRECISION,
    user_agent          VARCHAR(512)
);

CREATE TABLE business_resource (
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL UNIQUE,
    resource_type VARCHAR(255) NOT NULL,
    description   VARCHAR(1024)
);

CREATE TABLE business_action (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL UNIQUE,
    action_type VARCHAR(255) NOT NULL,
    description VARCHAR(1024)
);

CREATE TABLE business_resource_action (
    business_resource_id   BIGINT NOT NULL REFERENCES business_resource ON DELETE CASCADE,
    business_action_id     BIGINT NOT NULL REFERENCES business_action ON DELETE CASCADE,
    mapped_permission_name VARCHAR(255) NOT NULL,
    PRIMARY KEY (business_resource_id, business_action_id)
);

CREATE TABLE condition_template (
    id                    BIGSERIAL PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL UNIQUE,
    spel_template         VARCHAR(2048) NOT NULL,
    category              VARCHAR(255),
    parameter_count       INTEGER DEFAULT 0 NOT NULL,
    description           VARCHAR(1024),
    required_target_type  VARCHAR(1024),
    created_at            TIMESTAMP(6),
    is_auto_generated     BOOLEAN,
    is_universal          BOOLEAN,
    source_method         VARCHAR(255),
    template_type         VARCHAR(255),
    updated_at            TIMESTAMP(6),
    approval_required     BOOLEAN,
    classification        VARCHAR(255) CHECK (classification IN ('UNIVERSAL','CONTEXT_DEPENDENT','CUSTOM_COMPLEX')),
    complexity_score      INTEGER,
    context_dependent     BOOLEAN
);

CREATE TABLE wizard_session (
    session_id    VARCHAR(36) NOT NULL PRIMARY KEY,
    context_data  TEXT NOT NULL,
    owner_user_id VARCHAR(255) NOT NULL,
    created_at    TIMESTAMP(6) NOT NULL,
    expires_at    TIMESTAMP(6) NOT NULL
);

CREATE TABLE function_group (
    id   BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE function_catalog (
    id                  BIGSERIAL PRIMARY KEY,
    description         VARCHAR(1024),
    friendly_name       VARCHAR(255) NOT NULL,
    status              VARCHAR(50) NOT NULL CHECK (status IN ('UNCONFIRMED','ACTIVE','INACTIVE')),
    function_group_id   BIGINT REFERENCES function_group,
    managed_resource_id BIGINT NOT NULL UNIQUE REFERENCES managed_resource
);

CREATE TABLE policy_template (
    id                BIGSERIAL PRIMARY KEY,
    category          VARCHAR(255),
    description       VARCHAR(1024),
    name              VARCHAR(255) NOT NULL,
    policy_draft_json JSONB NOT NULL,
    template_id       VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE vector_store (
    id        UUID DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    content   TEXT NOT NULL,
    metadata  JSONB,
    embedding vector(1024)
);
CREATE INDEX vector_store_embedding_idx ON vector_store USING hnsw (embedding vector_cosine_ops);

CREATE TABLE user_behavior_profiles (
    id                      BIGSERIAL PRIMARY KEY,
    cluster_centroid_vector  TEXT,
    cluster_size             INTEGER,
    common_activities        JSON,
    common_ip_ranges         JSON,
    confidence_score         REAL,
    last_updated             TIMESTAMP(6),
    learning_count           INTEGER,
    normal_range_metadata    JSON,
    profile_type             VARCHAR(50) NOT NULL,
    user_id                  VARCHAR(255) NOT NULL,
    vector_cluster_id        VARCHAR(255)
);

CREATE TABLE soar_incidents (
    id           UUID NOT NULL PRIMARY KEY,
    created_at   TIMESTAMP(6) NOT NULL,
    history      TEXT,
    severity     VARCHAR(255),
    status       VARCHAR(255) NOT NULL CHECK (status IN ('NEW','TRIAGE','INVESTIGATION','PLANNING','PENDING_APPROVAL','EXECUTION','REPORTING','COMPLETED','AUTO_CLOSED','FAILED','CLOSED_BY_ADMIN')),
    title        VARCHAR(255) NOT NULL,
    updated_at   TIMESTAMP(6) NOT NULL,
    description  TEXT,
    incident_id  VARCHAR(255),
    metadata     TEXT,
    type         VARCHAR(255)
);

CREATE TABLE soar_approval_policies (
    id                      BIGSERIAL PRIMARY KEY,
    action_name             VARCHAR(255),
    auto_approve_on_timeout BOOLEAN NOT NULL,
    policy_name             VARCHAR(255) NOT NULL UNIQUE,
    required_approvers      INTEGER NOT NULL,
    required_roles          TEXT,
    severity                VARCHAR(255),
    timeout_minutes         INTEGER NOT NULL
);

CREATE TABLE soar_approval_requests (
    id                        BIGSERIAL PRIMARY KEY,
    action_name               VARCHAR(255) NOT NULL,
    created_at                TIMESTAMP(6) NOT NULL,
    description               TEXT,
    organization_id           VARCHAR(255),
    parameters                TEXT,
    playbook_instance_id      VARCHAR(255) NOT NULL,
    required_approvers        INTEGER,
    required_roles            TEXT,
    reviewer_comment          TEXT,
    reviewer_id               VARCHAR(255),
    status                    VARCHAR(255) NOT NULL,
    updated_at                TIMESTAMP(6) NOT NULL,
    request_id                VARCHAR(255) NOT NULL UNIQUE,
    action_type               VARCHAR(255),
    approval_comment          TEXT,
    approval_timeout          INTEGER,
    approval_type             VARCHAR(255),
    approved_at               TIMESTAMP(6),
    approved_by               VARCHAR(255),
    incident_id               VARCHAR(255),
    requested_by              VARCHAR(255),
    risk_level                VARCHAR(255),
    session_id                VARCHAR(255),
    tool_name                 VARCHAR(255),
    approved_count            INTEGER,
    rejected_count            INTEGER,
    remaining_approvals       INTEGER,
    quorum_satisfied          BOOLEAN DEFAULT FALSE,
    current_step_number       INTEGER,
    total_steps               INTEGER,
    reopened_from_request_id  VARCHAR(255),
    break_glass_requested     BOOLEAN DEFAULT FALSE,
    break_glass_reason        TEXT
);

CREATE TABLE soar_approval_steps (
    id                  BIGSERIAL PRIMARY KEY,
    request_id          VARCHAR(100) NOT NULL,
    step_number         INTEGER NOT NULL,
    step_name           VARCHAR(150) NOT NULL,
    status              VARCHAR(30) NOT NULL,
    required_approvers  INTEGER NOT NULL,
    approved_count      INTEGER NOT NULL,
    rejected_count      INTEGER NOT NULL,
    remaining_approvals INTEGER NOT NULL,
    required_roles      TEXT,
    opened_at           TIMESTAMP(6),
    completed_at        TIMESTAMP(6),
    created_at          TIMESTAMP(6) NOT NULL,
    updated_at          TIMESTAMP(6) NOT NULL,
    CONSTRAINT uk_soar_approval_step_request_number UNIQUE (request_id, step_number)
);

CREATE INDEX idx_soar_approval_step_request_id ON soar_approval_steps (request_id);
CREATE INDEX idx_soar_approval_step_status ON soar_approval_steps (status);

CREATE TABLE soar_approval_assignments (
    id                BIGSERIAL PRIMARY KEY,
    request_id        VARCHAR(100) NOT NULL,
    step_number       INTEGER NOT NULL,
    assignee_id       VARCHAR(100),
    assignee_role     VARCHAR(100),
    status            VARCHAR(30) NOT NULL,
    assigned_by       VARCHAR(100),
    assigned_at       TIMESTAMP(6),
    responded_at      TIMESTAMP(6),
    response_decision VARCHAR(30),
    response_comment  TEXT,
    created_at        TIMESTAMP(6) NOT NULL,
    updated_at        TIMESTAMP(6) NOT NULL
);

CREATE INDEX idx_soar_approval_assignment_request_id ON soar_approval_assignments (request_id);
CREATE INDEX idx_soar_approval_assignment_status ON soar_approval_assignments (status);
CREATE INDEX idx_soar_approval_assignment_step ON soar_approval_assignments (request_id, step_number);

CREATE TABLE soar_approval_votes (
    id            BIGSERIAL PRIMARY KEY,
    request_id    VARCHAR(100) NOT NULL,
    approver_id   VARCHAR(100) NOT NULL,
    approver_name VARCHAR(150),
    approver_role VARCHAR(100) NOT NULL,
    decision      VARCHAR(20) NOT NULL,
    comment       TEXT,
    step_number   INTEGER NOT NULL,
    created_at    TIMESTAMP(6) NOT NULL,
    updated_at    TIMESTAMP(6) NOT NULL,
    CONSTRAINT uk_soar_approval_vote_request_approver_step UNIQUE (request_id, approver_id, step_number)
);

CREATE INDEX idx_soar_approval_vote_request_id ON soar_approval_votes (request_id);
CREATE INDEX idx_soar_approval_vote_decision ON soar_approval_votes (decision);
CREATE INDEX idx_soar_approval_vote_created_at ON soar_approval_votes (created_at);
CREATE INDEX idx_soar_approval_vote_request_step ON soar_approval_votes (request_id, step_number);

CREATE TABLE approval_notifications (
    id                BIGSERIAL PRIMARY KEY,
    action_required   BOOLEAN NOT NULL,
    action_url        VARCHAR(500),
    created_at        TIMESTAMP(6) NOT NULL,
    expires_at        TIMESTAMP(6),
    group_id          VARCHAR(100),
    is_read           BOOLEAN NOT NULL,
    message           TEXT,
    notification_data TEXT,
    notification_type VARCHAR(50) NOT NULL,
    priority          VARCHAR(20),
    read_at           TIMESTAMP(6),
    read_by           VARCHAR(100),
    request_id        VARCHAR(100) NOT NULL,
    target_role       VARCHAR(50),
    title             VARCHAR(255) NOT NULL,
    updated_at        TIMESTAMP(6) NOT NULL,
    user_id           VARCHAR(100)
);
CREATE INDEX idx_notification_request_id ON approval_notifications (request_id);
CREATE INDEX idx_notification_user_id ON approval_notifications (user_id);
CREATE INDEX idx_notification_is_read ON approval_notifications (is_read);
CREATE INDEX idx_notification_created_at ON approval_notifications (created_at);

CREATE TABLE threat_indicators (
    indicator_id         VARCHAR(255) NOT NULL PRIMARY KEY,
    active               BOOLEAN,
    campaign             VARCHAR(255),
    campaign_id          VARCHAR(255),
    cis_control          VARCHAR(255),
    confidence           DOUBLE PRECISION,
    created_at           TIMESTAMP(6) NOT NULL,
    description          TEXT,
    detected_at          TIMESTAMP(6),
    detection_count      INTEGER,
    expires_at           TIMESTAMP(6),
    false_positive_count INTEGER,
    first_seen           TIMESTAMP(6),
    last_seen            TIMESTAMP(6),
    malware_family       VARCHAR(255),
    mitre_attack_id      VARCHAR(255),
    mitre_tactic         VARCHAR(255),
    mitre_technique      VARCHAR(255),
    nist_csf_category    VARCHAR(255),
    severity             VARCHAR(255) NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW','INFO')),
    source               VARCHAR(255),
    status               VARCHAR(255) CHECK (status IN ('ACTIVE','INACTIVE','EXPIRED','FALSE_POSITIVE','UNDER_REVIEW')),
    threat_actor         VARCHAR(255),
    threat_actor_id      VARCHAR(255),
    threat_score         DOUBLE PRECISION,
    indicator_type       VARCHAR(255) NOT NULL CHECK (indicator_type IN ('IP_ADDRESS','DOMAIN','URL','FILE_HASH','FILE_PATH','REGISTRY_KEY','PROCESS_NAME','EMAIL_ADDRESS','USER_AGENT','CERTIFICATE','MUTEX','YARA_RULE','BEHAVIORAL','UNKNOWN','PATTERN','USER_ACCOUNT','COMPLIANCE','EVENT')),
    updated_at           TIMESTAMP(6),
    indicator_value      VARCHAR(255) NOT NULL
);

CREATE TABLE indicator_metadata (
    indicator_id VARCHAR(255) NOT NULL REFERENCES threat_indicators,
    meta_value   VARCHAR(255),
    meta_key     VARCHAR(255) NOT NULL,
    PRIMARY KEY (indicator_id, meta_key)
);

CREATE TABLE indicator_tags (
    indicator_id VARCHAR(255) NOT NULL REFERENCES threat_indicators,
    tag          VARCHAR(255)
);

CREATE TABLE related_indicators (
    indicator_id         VARCHAR(255) NOT NULL REFERENCES threat_indicators,
    related_indicator_id VARCHAR(255) NOT NULL REFERENCES threat_indicators,
    PRIMARY KEY (indicator_id, related_indicator_id)
);

CREATE TABLE blocked_user (
    id                   BIGSERIAL PRIMARY KEY,
    block_count          INTEGER NOT NULL,
    blocked_at           TIMESTAMP(6) NOT NULL,
    confidence           DOUBLE PRECISION,
    reasoning            TEXT,
    request_id           VARCHAR(255) NOT NULL UNIQUE,
    resolve_reason       TEXT,
    resolved_action      VARCHAR(255),
    resolved_at          TIMESTAMP(6),
    resolved_by          VARCHAR(255),
    risk_score           DOUBLE PRECISION,
    source_ip            VARCHAR(45),
    status               VARCHAR(50) NOT NULL CHECK (status IN ('BLOCKED','UNBLOCK_REQUESTED','RESOLVED','TIMEOUT_RESPONDED','MFA_FAILED')),
    user_agent           VARCHAR(512),
    user_id              VARCHAR(100) NOT NULL,
    username             VARCHAR(100),
    unblock_requested_at TIMESTAMP(6),
    unblock_reason       TEXT,
    mfa_verified         BOOLEAN,
    mfa_verified_at      TIMESTAMP(6)
);

CREATE TABLE oauth2_authorization (
    id                            VARCHAR(100) NOT NULL PRIMARY KEY,
    registered_client_id          VARCHAR(100) NOT NULL,
    principal_name                VARCHAR(200) NOT NULL,
    authorization_grant_type      VARCHAR(100) NOT NULL,
    authorized_scopes             VARCHAR(1000),
    attributes                    TEXT,
    state                         VARCHAR(500),
    authorization_code_value      TEXT,
    authorization_code_issued_at  TIMESTAMP,
    authorization_code_expires_at TIMESTAMP,
    authorization_code_metadata   TEXT,
    access_token_value            TEXT,
    access_token_issued_at        TIMESTAMP,
    access_token_expires_at       TIMESTAMP,
    access_token_metadata         TEXT,
    access_token_type             VARCHAR(100),
    access_token_scopes           VARCHAR(1000),
    oidc_id_token_value           TEXT,
    oidc_id_token_issued_at       TIMESTAMP,
    oidc_id_token_expires_at      TIMESTAMP,
    oidc_id_token_metadata        TEXT,
    refresh_token_value           TEXT,
    refresh_token_issued_at       TIMESTAMP,
    refresh_token_expires_at      TIMESTAMP,
    refresh_token_metadata        TEXT,
    user_code_value               TEXT,
    user_code_issued_at           TIMESTAMP,
    user_code_expires_at          TIMESTAMP,
    user_code_metadata            TEXT,
    device_code_value             TEXT,
    device_code_issued_at         TIMESTAMP,
    device_code_expires_at        TIMESTAMP,
    device_code_metadata          TEXT
);

CREATE TABLE oauth2_registered_client (
    id                            VARCHAR(100) NOT NULL PRIMARY KEY,
    client_id                     VARCHAR(100) NOT NULL,
    client_id_issued_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    client_secret                 VARCHAR(200),
    client_secret_expires_at      TIMESTAMP,
    client_name                   VARCHAR(200) NOT NULL,
    client_authentication_methods VARCHAR(1000) NOT NULL,
    authorization_grant_types     VARCHAR(1000) NOT NULL,
    redirect_uris                 VARCHAR(1000),
    post_logout_redirect_uris     VARCHAR(1000),
    scopes                        VARCHAR(1000) NOT NULL,
    client_settings               VARCHAR(2000) NOT NULL,
    token_settings                VARCHAR(2000) NOT NULL
);

CREATE TABLE user_credentials (
    credential_id                VARCHAR(1000) NOT NULL PRIMARY KEY,
    user_entity_user_id          VARCHAR(1000) NOT NULL,
    public_key                   BYTEA NOT NULL,
    signature_count              BIGINT,
    uv_initialized               BOOLEAN,
    backup_eligible              BOOLEAN NOT NULL,
    authenticator_transports     VARCHAR(1000),
    public_key_credential_type   VARCHAR(100),
    backup_state                 BOOLEAN NOT NULL,
    attestation_object           BYTEA,
    attestation_client_data_json BYTEA,
    created                      TIMESTAMP,
    last_used                    TIMESTAMP,
    label                        VARCHAR(1000) NOT NULL
);

CREATE TABLE user_entities (
    id           VARCHAR(1000) NOT NULL PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    display_name VARCHAR(200)
);

CREATE TABLE one_time_tokens (
    token_value VARCHAR(36) NOT NULL PRIMARY KEY,
    username    VARCHAR(50) NOT NULL,
    expires_at  TIMESTAMP NOT NULL
);
`;
}

function getDmlScript() {
  return `-- Contexa Initial Data
INSERT INTO role (role_name, role_desc, is_expression, enabled, created_at, created_by) VALUES
    ('ROLE_ADMIN',     'System administrator with full access',    FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('ROLE_MANAGER',   'Manager with team-level access',           FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('ROLE_USER',      'Standard user with basic access',          FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('ROLE_DEVELOPER', 'Developer with API and resource access',   FALSE, TRUE, CURRENT_TIMESTAMP, 'SYSTEM');

INSERT INTO app_group (group_name, description, enabled, created_at, created_by) VALUES
    ('Administrators', 'System administrators group',  TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('Managers',       'Team managers group',          TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('Users',          'Standard users group',         TRUE, CURRENT_TIMESTAMP, 'SYSTEM'),
    ('Developers',     'Developers and engineers',     TRUE, CURRENT_TIMESTAMP, 'SYSTEM');

INSERT INTO group_roles (group_id, role_id, assigned_at, assigned_by)
SELECT g.group_id, r.role_id, CURRENT_TIMESTAMP, 'SYSTEM'
FROM app_group g, role r
WHERE (g.group_name = 'Administrators' AND r.role_name IN ('ROLE_ADMIN', 'ROLE_MANAGER', 'ROLE_USER'))
   OR (g.group_name = 'Managers'       AND r.role_name IN ('ROLE_MANAGER', 'ROLE_USER'))
   OR (g.group_name = 'Users'          AND r.role_name IN ('ROLE_USER'))
   OR (g.group_name = 'Developers'     AND r.role_name IN ('ROLE_DEVELOPER', 'ROLE_USER'));

-- All passwords: 1234
INSERT INTO users (username, email, password, name, department, position, enabled, mfa_enabled, created_at) VALUES
    ('admin',       'admin@contexa.io',       '$2a$10$EqKcp1WFKumxl9EtWnyKVeJgLGQDP5FPvMflDbVzxjFPqzJHPe3oO', 'System Admin', 'IT',          'Administrator', TRUE, FALSE, CURRENT_TIMESTAMP),
    ('kim_manager', 'kim.manager@contexa.io', '$2a$10$EqKcp1WFKumxl9EtWnyKVeJgLGQDP5FPvMflDbVzxjFPqzJHPe3oO', 'Kim Jihoon',   'Finance',     'Manager',       TRUE, FALSE, CURRENT_TIMESTAMP),
    ('park_user',   'park.user@contexa.io',   '$2a$10$EqKcp1WFKumxl9EtWnyKVeJgLGQDP5FPvMflDbVzxjFPqzJHPe3oO', 'Park Minjun',  'Engineering', 'Developer',     TRUE, FALSE, CURRENT_TIMESTAMP),
    ('dev_lead',    'dev.lead@contexa.io',    '$2a$10$EqKcp1WFKumxl9EtWnyKVeJgLGQDP5FPvMflDbVzxjFPqzJHPe3oO', 'Lee Soyeon',   'Engineering', 'Tech Lead',     TRUE, FALSE, CURRENT_TIMESTAMP);

INSERT INTO user_groups (user_id, group_id, assigned_at, assigned_by)
SELECT u.id, g.group_id, CURRENT_TIMESTAMP, 'SYSTEM'
FROM users u, app_group g
WHERE (u.username = 'admin'       AND g.group_name = 'Administrators')
   OR (u.username = 'kim_manager' AND g.group_name = 'Managers')
   OR (u.username = 'park_user'   AND g.group_name = 'Users')
   OR (u.username = 'dev_lead'    AND g.group_name = 'Developers');
`;
}

function getEnterpriseDdlScript() {
  return `-- Contexa Enterprise - SaaS Platform Database Schema
CREATE TABLE mcp_client_states (
    client_name            VARCHAR(100) NOT NULL PRIMARY KEY,
    enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    health_status          VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN',
    health_message         VARCHAR(500),
    last_health_checked_at TIMESTAMP(6),
    updated_at             TIMESTAMP(6) NOT NULL
);

CREATE TABLE mcp_surface_states (
    surface_key          VARCHAR(180) NOT NULL PRIMARY KEY,
    surface_type         VARCHAR(30) NOT NULL,
    surface_name         VARCHAR(140) NOT NULL,
    client_name          VARCHAR(100) NOT NULL,
    enabled              BOOLEAN NOT NULL DEFAULT TRUE,
    version              VARCHAR(64) NOT NULL,
    last_refreshed_at    TIMESTAMP(6),
    updated_at           TIMESTAMP(6) NOT NULL
);

CREATE TABLE tool_execution_contexts (
    id                   BIGSERIAL PRIMARY KEY,
    request_id           VARCHAR(100) NOT NULL UNIQUE,
    permit_id            VARCHAR(100) UNIQUE,
    approval_id          VARCHAR(100),
    status               VARCHAR(20) NOT NULL,
    tool_name            VARCHAR(255) NOT NULL,
    tool_type            VARCHAR(50),
    tool_call_id         VARCHAR(255),
    tool_arguments       TEXT,
    tool_definitions     TEXT,
    prompt_content       TEXT NOT NULL,
    execution_class      VARCHAR(30),
    arguments_hash       VARCHAR(128),
    required_scope       VARCHAR(500),
    available_tools      TEXT,
    chat_options         TEXT,
    chat_response        TEXT,
    execution_result     TEXT,
    execution_error      TEXT,
    execution_start_time TIMESTAMP(6),
    execution_end_time   TIMESTAMP(6),
    incident_id          VARCHAR(100),
    session_id           VARCHAR(100),
    risk_level           VARCHAR(20),
    soar_context         TEXT,
    pipeline_context     TEXT,
    metadata             TEXT,
    max_retries          INTEGER,
    retry_count          INTEGER,
    expires_at           TIMESTAMP(6),
    created_at           TIMESTAMP(6) NOT NULL,
    updated_at           TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tool_context_status ON tool_execution_contexts (status);
CREATE INDEX idx_tool_context_created_at ON tool_execution_contexts (created_at);
CREATE INDEX idx_tool_context_tool_name ON tool_execution_contexts (tool_name);

CREATE TABLE tenant_lifecycle_events (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   VARCHAR(120) NOT NULL,
    event_type  VARCHAR(80) NOT NULL,
    actor_id    VARCHAR(120),
    payload_json TEXT,
    created_at  TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_lifecycle_event_tenant_created ON tenant_lifecycle_events (tenant_id, created_at);

CREATE TABLE saas_tenants (
    id                 BIGSERIAL PRIMARY KEY,
    tenant_id          VARCHAR(120) NOT NULL UNIQUE,
    display_name       VARCHAR(255) NOT NULL,
    organization_id    VARCHAR(120) NOT NULL UNIQUE,
    deployment_mode    VARCHAR(40) NOT NULL DEFAULT 'SHARED_CLOUD',
    region             VARCHAR(80) NOT NULL,
    status             VARCHAR(40) NOT NULL DEFAULT 'PENDING',
    plan_code          VARCHAR(80) NOT NULL,
    billing_account_id VARCHAR(120),
    activated_at       TIMESTAMP(6),
    suspended_at       TIMESTAMP(6),
    terminated_at      TIMESTAMP(6),
    created_at         TIMESTAMP(6) NOT NULL,
    updated_at         TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_saas_tenant_status ON saas_tenants (status);
CREATE INDEX idx_saas_tenant_plan ON saas_tenants (plan_code);

CREATE TABLE tenant_subscriptions (
    id                       BIGSERIAL PRIMARY KEY,
    tenant_id                VARCHAR(120) NOT NULL UNIQUE,
    plan_code                VARCHAR(80) NOT NULL,
    billing_model            VARCHAR(40) NOT NULL DEFAULT 'MONTHLY_TRUE_UP',
    contract_start_at        TIMESTAMP(6) NOT NULL,
    contract_end_at          TIMESTAMP(6),
    support_tier             VARCHAR(40) NOT NULL DEFAULT 'STANDARD',
    auto_renew               BOOLEAN NOT NULL DEFAULT TRUE,
    committed_monthly_amount DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    created_at               TIMESTAMP(6) NOT NULL,
    updated_at               TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_sub_plan ON tenant_subscriptions (plan_code);
CREATE INDEX idx_tenant_sub_contract_end ON tenant_subscriptions (contract_end_at);

CREATE TABLE tenant_environments (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(120) NOT NULL,
    environment_key VARCHAR(80) NOT NULL,
    display_name    VARCHAR(120) NOT NULL,
    deployment_mode VARCHAR(40) NOT NULL,
    region          VARCHAR(80) NOT NULL,
    status          VARCHAR(40) NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMP(6) NOT NULL,
    updated_at      TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_env_key ON tenant_environments (tenant_id, environment_key);

CREATE TABLE tenant_entitlements (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(120) NOT NULL,
    entitlement_key   VARCHAR(120) NOT NULL,
    entitlement_value VARCHAR(500) NOT NULL,
    value_type        VARCHAR(40) NOT NULL,
    effective_from    TIMESTAMP(6) NOT NULL,
    effective_to      TIMESTAMP(6),
    source            VARCHAR(40) NOT NULL DEFAULT 'PLAN',
    created_at        TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_entitlement ON tenant_entitlements (tenant_id, entitlement_key, effective_to);

CREATE TABLE tenant_operator_assignments (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(120) NOT NULL,
    user_id         VARCHAR(160) NOT NULL,
    role_code       VARCHAR(80) NOT NULL,
    status          VARCHAR(40) NOT NULL DEFAULT 'INVITED',
    invited_at      TIMESTAMP(6) NOT NULL,
    activated_at    TIMESTAMP(6),
    deactivated_at  TIMESTAMP(6),
    created_by      VARCHAR(160),
    deactivated_by  VARCHAR(160),
    created_at      TIMESTAMP(6) NOT NULL,
    updated_at      TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_operator_user ON tenant_operator_assignments (tenant_id, user_id);
CREATE INDEX idx_tenant_operator_status ON tenant_operator_assignments (tenant_id, status);

CREATE TABLE tenant_provisioning_tasks (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     VARCHAR(120) NOT NULL,
    task_type     VARCHAR(120) NOT NULL,
    status        VARCHAR(40) NOT NULL DEFAULT 'PENDING',
    reference_key VARCHAR(160),
    payload_json  TEXT,
    scheduled_at  TIMESTAMP(6),
    started_at    TIMESTAMP(6),
    completed_at  TIMESTAMP(6),
    failed_at     TIMESTAMP(6),
    error_message VARCHAR(1000),
    created_at    TIMESTAMP(6) NOT NULL,
    updated_at    TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_prov_status ON tenant_provisioning_tasks (tenant_id, task_type, status);
CREATE INDEX idx_tenant_prov_ref ON tenant_provisioning_tasks (tenant_id, reference_key);

CREATE TABLE tenant_purge_requests (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            VARCHAR(120) NOT NULL,
    provisioning_task_id BIGINT,
    reference_key        VARCHAR(160) NOT NULL,
    status               VARCHAR(40) NOT NULL,
    approval_state       VARCHAR(60) NOT NULL,
    data_domains_json    TEXT,
    requested_by         VARCHAR(120) NOT NULL,
    request_reason       VARCHAR(1000),
    approved_by          VARCHAR(120),
    rejected_by          VARCHAR(120),
    executed_by          VARCHAR(120),
    approved_at          TIMESTAMP(6),
    rejected_at          TIMESTAMP(6),
    executed_at          TIMESTAMP(6),
    scheduled_at         TIMESTAMP(6) NOT NULL,
    execution_summary    VARCHAR(1000),
    metadata_json        TEXT,
    created_at           TIMESTAMP(6) NOT NULL,
    updated_at           TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_purge_status ON tenant_purge_requests (tenant_id, status, scheduled_at);
CREATE INDEX idx_tenant_purge_prov ON tenant_purge_requests (tenant_id, provisioning_task_id);

CREATE TABLE tenant_backup_policies (
    id                              BIGSERIAL PRIMARY KEY,
    tenant_id                       VARCHAR(120) NOT NULL UNIQUE,
    backup_frequency                VARCHAR(40) NOT NULL,
    backup_window_start_hour        INTEGER NOT NULL,
    backup_window_duration_hours    INTEGER NOT NULL,
    backup_retention_days           INTEGER NOT NULL,
    restore_drill_cadence_days      INTEGER NOT NULL,
    restore_evidence_retention_days INTEGER NOT NULL,
    export_window_start_hour        INTEGER NOT NULL,
    export_window_end_hour          INTEGER NOT NULL,
    purge_approval_required         BOOLEAN NOT NULL,
    last_backup_completed_at        TIMESTAMP(6),
    last_restore_drill_completed_at TIMESTAMP(6),
    notes                           VARCHAR(1000),
    created_at                      TIMESTAMP(6) NOT NULL,
    updated_at                      TIMESTAMP(6) NOT NULL
);

CREATE TABLE tenant_restore_drills (
    id                 BIGSERIAL PRIMARY KEY,
    tenant_id          VARCHAR(120) NOT NULL,
    target_environment VARCHAR(80) NOT NULL,
    backup_reference   VARCHAR(255),
    evidence_reference VARCHAR(255),
    status             VARCHAR(40) NOT NULL,
    initiated_by       VARCHAR(120) NOT NULL,
    started_at         TIMESTAMP(6) NOT NULL,
    completed_at       TIMESTAMP(6) NOT NULL,
    notes              VARCHAR(1000),
    metadata_json      TEXT,
    created_at         TIMESTAMP(6) NOT NULL,
    updated_at         TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_drill_status ON tenant_restore_drills (tenant_id, status, completed_at);

CREATE TABLE tenant_quotas (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   VARCHAR(120) NOT NULL,
    quota_key   VARCHAR(120) NOT NULL,
    limit_value BIGINT NOT NULL,
    policy_type VARCHAR(40) NOT NULL DEFAULT 'HARD_LIMIT',
    grace_until TIMESTAMP(6),
    updated_at  TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_quota ON tenant_quotas (tenant_id, quota_key);

CREATE TABLE tenant_quota_violations (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(120) NOT NULL,
    quota_key       VARCHAR(120) NOT NULL,
    policy_type     VARCHAR(40) NOT NULL,
    attempted_usage BIGINT NOT NULL,
    limit_value     BIGINT NOT NULL,
    message         VARCHAR(500) NOT NULL,
    billing_period  VARCHAR(20) NOT NULL,
    metadata_json   TEXT,
    occurred_at     TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_violation_time ON tenant_quota_violations (tenant_id, occurred_at);
CREATE INDEX idx_tenant_violation_key ON tenant_quota_violations (tenant_id, quota_key, billing_period);

CREATE TABLE tenant_isolation_states (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(120) NOT NULL,
    scope_type        VARCHAR(40) NOT NULL,
    scope_key         VARCHAR(160) NOT NULL,
    workload_type     VARCHAR(80) NOT NULL,
    status            VARCHAR(40) NOT NULL,
    reason_code       VARCHAR(120) NOT NULL,
    message           VARCHAR(500) NOT NULL,
    trigger_count     INTEGER NOT NULL,
    contained_until   TIMESTAMP(6) NOT NULL,
    last_triggered_at TIMESTAMP(6) NOT NULL,
    created_at        TIMESTAMP(6) NOT NULL,
    updated_at        TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_isolation_scope ON tenant_isolation_states (tenant_id, scope_type, scope_key, workload_type);
CREATE INDEX idx_tenant_isolation_status ON tenant_isolation_states (tenant_id, status, contained_until);

CREATE TABLE tenant_isolation_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(120) NOT NULL,
    scope_type      VARCHAR(40) NOT NULL,
    scope_key       VARCHAR(160) NOT NULL,
    workload_type   VARCHAR(80) NOT NULL,
    decision        VARCHAR(60) NOT NULL,
    attempted_value BIGINT NOT NULL,
    limit_value     BIGINT NOT NULL,
    window_seconds  INTEGER NOT NULL,
    message         VARCHAR(500) NOT NULL,
    metadata_json   TEXT,
    occurred_at     TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_tenant_iso_event_time ON tenant_isolation_events (tenant_id, occurred_at);
CREATE INDEX idx_tenant_iso_event_scope ON tenant_isolation_events (tenant_id, scope_type, scope_key, workload_type, decision);

CREATE TABLE tenant_workload_leases (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     VARCHAR(120) NOT NULL,
    workload_type VARCHAR(80) NOT NULL,
    owner_id      VARCHAR(160) NOT NULL,
    resource_key  VARCHAR(200),
    status        VARCHAR(40) NOT NULL,
    metadata_json TEXT,
    acquired_at   TIMESTAMP(6) NOT NULL,
    expires_at    TIMESTAMP(6) NOT NULL,
    released_at   TIMESTAMP(6)
);
CREATE INDEX idx_tenant_lease_active ON tenant_workload_leases (tenant_id, workload_type, status, expires_at);
CREATE INDEX idx_tenant_lease_acquired ON tenant_workload_leases (tenant_id, workload_type, acquired_at);

CREATE TABLE protected_app_groups (
    id                BIGSERIAL PRIMARY KEY,
    app_group_id      VARCHAR(120) NOT NULL UNIQUE,
    tenant_id         VARCHAR(120) NOT NULL,
    display_name      VARCHAR(255) NOT NULL,
    environment       VARCHAR(80) NOT NULL,
    binding_type      VARCHAR(40) NOT NULL,
    status            VARCHAR(40) NOT NULL DEFAULT 'PENDING_HEARTBEAT',
    last_heartbeat_at TIMESTAMP(6),
    created_at        TIMESTAMP(6) NOT NULL,
    updated_at        TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_app_group_tenant_status ON protected_app_groups (tenant_id, status);
CREATE INDEX idx_app_group_tenant_heartbeat ON protected_app_groups (tenant_id, last_heartbeat_at);

CREATE TABLE protected_app_endpoints (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    VARCHAR(120) NOT NULL,
    app_group_id VARCHAR(120) NOT NULL,
    path_pattern VARCHAR(300) NOT NULL,
    http_method  VARCHAR(20) NOT NULL,
    sensitivity  VARCHAR(40) NOT NULL DEFAULT 'STANDARD',
    status       VARCHAR(40) NOT NULL DEFAULT 'ACTIVE',
    created_at   TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_app_endpoint_group ON protected_app_endpoints (app_group_id);
CREATE INDEX idx_app_endpoint_tenant ON protected_app_endpoints (tenant_id, status);

CREATE TABLE protected_app_bindings (
    id           BIGSERIAL PRIMARY KEY,
    app_group_id VARCHAR(120) NOT NULL,
    binding_key  VARCHAR(120) NOT NULL,
    binding_value VARCHAR(500) NOT NULL,
    status       VARCHAR(40) NOT NULL DEFAULT 'ACTIVE',
    created_at   TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_app_binding_group ON protected_app_bindings (app_group_id);

CREATE TABLE protected_app_heartbeats (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     VARCHAR(120) NOT NULL,
    app_group_id  VARCHAR(120) NOT NULL,
    client_id     VARCHAR(160),
    occurred_at   TIMESTAMP(6) NOT NULL,
    source_module VARCHAR(120) NOT NULL,
    metadata_json TEXT
);
CREATE INDEX idx_app_heartbeat_group ON protected_app_heartbeats (tenant_id, app_group_id, occurred_at);
CREATE INDEX idx_app_heartbeat_client ON protected_app_heartbeats (tenant_id, client_id, occurred_at);

CREATE TABLE billing_contracts (
    id                     BIGSERIAL PRIMARY KEY,
    tenant_id              VARCHAR(120) NOT NULL UNIQUE,
    billing_channel        VARCHAR(40) NOT NULL DEFAULT 'DIRECT',
    billing_model          VARCHAR(40) NOT NULL,
    currency               VARCHAR(16) NOT NULL DEFAULT 'USD',
    annual_commit_amount   DECIMAL(18,2),
    reseller_partner_id    VARCHAR(120),
    marketplace_provider   VARCHAR(80),
    marketplace_account_id VARCHAR(180),
    settlement_account_id  VARCHAR(180),
    effective_from         TIMESTAMP(6) NOT NULL,
    effective_to           TIMESTAMP(6),
    status                 VARCHAR(40) NOT NULL DEFAULT 'ACTIVE',
    notes                  TEXT,
    created_at             TIMESTAMP(6) NOT NULL,
    updated_at             TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_billing_contract_channel ON billing_contracts (billing_channel);
CREATE INDEX idx_billing_contract_status ON billing_contracts (status);

CREATE TABLE billing_invoices (
    id               BIGSERIAL PRIMARY KEY,
    invoice_id       VARCHAR(160) NOT NULL UNIQUE,
    tenant_id        VARCHAR(120) NOT NULL,
    billing_period   VARCHAR(20) NOT NULL,
    currency         VARCHAR(16) NOT NULL DEFAULT 'USD',
    committed_amount DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    overage_amount   DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    total_amount     DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    status           VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    issued_at        TIMESTAMP(6),
    due_at           TIMESTAMP(6),
    created_at       TIMESTAMP(6) NOT NULL,
    updated_at       TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_billing_invoice_tenant ON billing_invoices (tenant_id, billing_period);

CREATE TABLE billing_line_items (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  VARCHAR(160) NOT NULL,
    line_type   VARCHAR(40) NOT NULL,
    meter_key   VARCHAR(80),
    description VARCHAR(255) NOT NULL,
    quantity    DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    unit_price  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    amount      DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    created_at  TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_billing_line_invoice ON billing_line_items (invoice_id);
CREATE INDEX idx_billing_line_meter ON billing_line_items (meter_key);

CREATE TABLE billing_adjustments (
    id              BIGSERIAL PRIMARY KEY,
    adjustment_id   VARCHAR(180) NOT NULL UNIQUE,
    tenant_id       VARCHAR(120) NOT NULL,
    billing_period  VARCHAR(20) NOT NULL,
    invoice_id      VARCHAR(160),
    adjustment_type VARCHAR(40) NOT NULL,
    reason_code     VARCHAR(80) NOT NULL,
    description     VARCHAR(255) NOT NULL,
    amount          DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    status          VARCHAR(60) NOT NULL,
    requested_by    VARCHAR(120) NOT NULL,
    applied_at      TIMESTAMP(6),
    voided_at       TIMESTAMP(6),
    voided_by       VARCHAR(120),
    void_reason     VARCHAR(255),
    metadata_json   TEXT,
    created_at      TIMESTAMP(6) NOT NULL,
    updated_at      TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_billing_adj_tenant ON billing_adjustments (tenant_id, billing_period);
CREATE INDEX idx_billing_adj_status ON billing_adjustments (status);
CREATE INDEX idx_billing_adj_invoice ON billing_adjustments (invoice_id);

CREATE TABLE invoice_export_batches (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       VARCHAR(120) NOT NULL,
    invoice_id      VARCHAR(160),
    billing_period  VARCHAR(20) NOT NULL,
    export_type     VARCHAR(60) NOT NULL,
    export_format   VARCHAR(20) NOT NULL,
    status          VARCHAR(40) NOT NULL,
    requested_by    VARCHAR(120),
    file_name       VARCHAR(220) NOT NULL,
    checksum_sha256 VARCHAR(128),
    metadata_json   TEXT,
    exported_at     TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_invoice_export_tenant ON invoice_export_batches (tenant_id, billing_period);
CREATE INDEX idx_invoice_export_type ON invoice_export_batches (export_type, export_format);

CREATE TABLE usage_meter_events (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      VARCHAR(120) NOT NULL,
    meter_key      VARCHAR(120) NOT NULL,
    quantity       BIGINT NOT NULL,
    unit           VARCHAR(40) NOT NULL,
    source_module  VARCHAR(120) NOT NULL,
    source_ref     VARCHAR(180),
    occurred_at    TIMESTAMP(6) NOT NULL,
    billing_period VARCHAR(20) NOT NULL,
    metadata_json  TEXT
);
CREATE INDEX idx_usage_meter_period ON usage_meter_events (tenant_id, billing_period);
CREATE INDEX idx_usage_meter_key ON usage_meter_events (tenant_id, meter_key, billing_period);

CREATE TABLE usage_aggregations (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           VARCHAR(120) NOT NULL,
    billing_period      VARCHAR(20) NOT NULL,
    meter_key           VARCHAR(120) NOT NULL,
    aggregated_quantity BIGINT NOT NULL,
    included_quantity   BIGINT NOT NULL,
    overage_quantity    BIGINT NOT NULL,
    calculated_at       TIMESTAMP(6) NOT NULL,
    UNIQUE (tenant_id, billing_period, meter_key)
);

CREATE TABLE dedicated_deployment_profiles (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         VARCHAR(120) NOT NULL UNIQUE,
    region            VARCHAR(80) NOT NULL,
    previous_region   VARCHAR(80),
    network_isolation VARCHAR(80) NOT NULL,
    retention_policy  VARCHAR(80) NOT NULL,
    support_tier      VARCHAR(40) NOT NULL,
    billing_model     VARCHAR(40) NOT NULL,
    allocation_state  VARCHAR(40) NOT NULL DEFAULT 'REQUESTED',
    requested_at      TIMESTAMP(6),
    activated_at      TIMESTAMP(6),
    notes             TEXT,
    created_at        TIMESTAMP(6) NOT NULL,
    updated_at        TIMESTAMP(6) NOT NULL
);
CREATE INDEX idx_dedicated_deploy_state ON dedicated_deployment_profiles (allocation_state);
`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { injectYml, injectMavenDep, injectGradleDep, generateDockerCompose, generateInitDbScripts };
