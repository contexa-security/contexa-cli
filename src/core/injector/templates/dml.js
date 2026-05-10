'use strict';

// Open-core seed - Option B (minimal-cli, delegate-to-IAM).
//
// Division of responsibility:
//   - contexa-cli (this file): persists ONLY the data that has to exist before
//     Spring Boot starts AND that IAM cannot recover by itself.
//
//        1. Seed users (5) with a freshly generated random BCrypt hash so the
//           operator can sign in immediately. IAM's data.sql ships a sentinel
//           BCrypt placeholder that never matches any plaintext, so without
//           this row the first login is impossible.
//        2. Seed app_group / role / user_groups / group_roles / system_settings
//           so an out-of-band DBA inspecting the DB before the app boots sees
//           a sane minimum.
//        3. Sequence sync DO block, since cli inserts rows with explicit ids
//           (1..5) and the identity sequence must be advanced past them.
//
//   - contexa-iam (IamSeedDataAutoConfiguration runs every Spring Boot start):
//        Everything else - role_hierarchy_config, BUSINESS/METHOD permission
//        catalog, role_permissions grants, managed_resource, canonical
//        policy/target/rule/condition (id=2), condition_template, security_spel,
//        admin_menu (top-level + submenu, including ENTERPRISE/SAAS rows that
//        are hidden by feature flags at runtime).
//
//   IAM data.sql re-INSERTs the same users with a non-matching BCrypt
//   placeholder; ON CONFLICT (id) DO NOTHING preserves the cli random hash so
//   the operator-facing seed password keeps working across restarts.
//
//   The seed password is printed exactly once on stdout at init time -
//   contexa-cli keeps no record of it after that.

module.exports = `-- ============================================================
-- Contexa AI-Native Zero Trust Security Platform
-- Open-core minimal seed (cli scope - Option B)
-- ============================================================
-- Run AFTER 01-core-ddl.sql.
-- Password: BCrypt-encoded random password (generated at init time, see init output).
-- IamSeedDataAutoConfiguration applies the rest of the seed every Spring Boot
-- startup; this script intentionally stops at users/groups/roles/system_settings.
-- ============================================================

-- ----------------------------------------------------------------
-- USERS - 5 seed accounts.
-- email is NOT NULL UNIQUE in the open-core schema; the username is itself in
-- email form here, so we mirror it into email to satisfy both constraints.
-- The bcrypt placeholder in each row is replaced with a freshly generated
-- hash by contexa-cli before the file is written to disk.
-- ----------------------------------------------------------------
INSERT INTO users (id, username, email, password, name, mfa_enabled, enabled, account_locked, bridge_managed, credentials_expired, external_auth_only, failed_login_attempts, created_at) VALUES
    (1, 'admin@example.com',     'admin@example.com',     '{bcrypt}__SEED_BCRYPT_HASH__', '최고관리자', TRUE,  TRUE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    (2, 'manager@example.com',   'manager@example.com',   '{bcrypt}__SEED_BCRYPT_HASH__', '김팀장',     TRUE,  TRUE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    (3, 'developer@example.com', 'developer@example.com', '{bcrypt}__SEED_BCRYPT_HASH__', '박개발',     FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    (4, 'user@example.com',      'user@example.com',      '{bcrypt}__SEED_BCRYPT_HASH__', '이운영',     FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    (5, 'finance@example.com',   'finance@example.com',   '{bcrypt}__SEED_BCRYPT_HASH__', '최재무',     TRUE,  TRUE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------
-- APP_GROUP - mirror of IAM data.sql so the cli row wins on a fresh DB.
-- ----------------------------------------------------------------
INSERT INTO app_group (group_id, group_name, description, enabled, created_at) VALUES
    (1, '시스템관리자',  '시스템 전체 관리 및 최고 권한 보유',  TRUE, CURRENT_TIMESTAMP),
    (2, '개발본부',      '소프트웨어 개발 및 연구 부서',        TRUE, CURRENT_TIMESTAMP),
    (3, '인프라보안팀',  '서버, 네트워크, 보안 인프라 관리팀',  TRUE, CURRENT_TIMESTAMP),
    (4, '재무회계팀',    '회사의 재무 및 회계 업무 담당팀',     TRUE, CURRENT_TIMESTAMP)
ON CONFLICT (group_id) DO NOTHING;

-- ----------------------------------------------------------------
-- ROLE
-- ----------------------------------------------------------------
INSERT INTO role (role_id, role_name, role_desc, enabled, expression, created_at) VALUES
    (1, 'ROLE_ADMIN',     '시스템 전체 관리자 역할',                                   TRUE, FALSE, CURRENT_TIMESTAMP),
    (2, 'ROLE_DEVELOPER', '개발팀 역할 - 소프트웨어 개발 및 고객 데이터 관리',         TRUE, FALSE, CURRENT_TIMESTAMP),
    (3, 'ROLE_INFRA',     '인프라팀 역할 - 시스템 운영 및 보안 관리',                  TRUE, FALSE, CURRENT_TIMESTAMP),
    (4, 'ROLE_FINANCE',   '재무팀 역할 - 회계 및 재무 데이터 관리',                    TRUE, FALSE, CURRENT_TIMESTAMP),
    (5, 'ROLE_USER',      '일반 사용자 역할',                                          TRUE, FALSE, CURRENT_TIMESTAMP)
ON CONFLICT (role_id) DO NOTHING;

-- ----------------------------------------------------------------
-- USER_GROUPS / GROUP_ROLES - minimal mapping so the seed users can sign in
-- with the right authority set even before IAM data.sql runs.
-- ----------------------------------------------------------------
INSERT INTO user_groups (user_id, group_id, assigned_at) VALUES
    (1, 1, CURRENT_TIMESTAMP),
    (2, 2, CURRENT_TIMESTAMP),
    (3, 2, CURRENT_TIMESTAMP),
    (4, 3, CURRENT_TIMESTAMP),
    (5, 4, CURRENT_TIMESTAMP)
ON CONFLICT (group_id, user_id) DO NOTHING;

INSERT INTO group_roles (group_id, role_id, assigned_at) VALUES
    (1, 1, CURRENT_TIMESTAMP),
    (2, 2, CURRENT_TIMESTAMP),
    (3, 3, CURRENT_TIMESTAMP),
    (4, 4, CURRENT_TIMESTAMP)
ON CONFLICT (group_id, role_id) DO NOTHING;

-- ----------------------------------------------------------------
-- SYSTEM_SETTINGS - singleton, idempotent.
-- ----------------------------------------------------------------
INSERT INTO system_settings (audit_log_retention_days, default_role, policy_combining_algorithm, registration_enabled, created_at)
SELECT 90, 'ROLE_USER', 'FIRST_APPLICABLE', FALSE, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM system_settings);

-- ----------------------------------------------------------------
-- Sequence sync.
-- cli inserts users(id=1..5), app_group(group_id=1..4), role(role_id=1..5)
-- with explicit ids; without setval the next IAM-issued INSERT collides.
-- Wrapped in DO so absent sequences (Hibernate-controlled) skip silently.
-- ----------------------------------------------------------------
DO $$
DECLARE
    pairs TEXT[][] := ARRAY[
        ARRAY['users_id_seq',           'users',     'id'],
        ARRAY['app_group_group_id_seq', 'app_group', 'group_id'],
        ARRAY['role_role_id_seq',       'role',      'role_id']
    ];
    pair TEXT[];
    max_id BIGINT;
BEGIN
    FOREACH pair SLICE 1 IN ARRAY pairs LOOP
        BEGIN
            EXECUTE format('SELECT MAX(%I) FROM %I', pair[3], pair[2]) INTO max_id;
            IF max_id IS NOT NULL THEN
                EXECUTE format('SELECT setval(%L, %s, true)', pair[1], max_id);
            END IF;
        EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR insufficient_privilege THEN
            -- Sequence or table absent in this profile; skip silently.
            NULL;
        END;
    END LOOP;
END $$;
`;
