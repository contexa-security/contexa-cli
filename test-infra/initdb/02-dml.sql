-- ============================================================
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
    ('admin',       'admin@contexa.io',       '{bcrypt}$2a$06$54N5U599n7zQtfQYeO7GD.xbhjpI.X/yoL0KT/NsuDez3vW7patXu', 'System Admin',   '010-0000-0001', 'IT',          'Administrator', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    ('kim_manager', 'kim.manager@contexa.io', '{bcrypt}$2a$06$54N5U599n7zQtfQYeO7GD.xbhjpI.X/yoL0KT/NsuDez3vW7patXu', 'Kim Jihoon',     '010-0000-0002', 'Finance',     'Manager',       TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    ('park_user',   'park.user@contexa.io',   '{bcrypt}$2a$06$54N5U599n7zQtfQYeO7GD.xbhjpI.X/yoL0KT/NsuDez3vW7patXu', 'Park Minjun',    '010-0000-0003', 'Engineering', 'Developer',     TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP),
    ('dev_lead',    'dev.lead@contexa.io',    '{bcrypt}$2a$06$54N5U599n7zQtfQYeO7GD.xbhjpI.X/yoL0KT/NsuDez3vW7patXu', 'Lee Soyeon',     '010-0000-0004', 'Engineering', 'Tech Lead',     TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, 0, CURRENT_TIMESTAMP);

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
