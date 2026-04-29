'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const yaml  = require('js-yaml');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');

const DEFAULT_DB_PASSWORD = 'contexa1234!@#';
// Dead keys: present in older CLI output but not bound by any
// @ConfigurationProperties class. Surface them so users migrate away.
const DEAD_KEYS = [
  ['contexa', 'jpa', 'hibernate', 'ddl-auto'],
  ['contexa', 'jpa', 'hibernate', 'ddlAuto'],
];
// Deprecated keys: still bound today but slated for removal. Recommend
// migration to contexa.llm.selection.{chat,embedding}.priority.
const DEPRECATED_KEYS = [
  ['contexa', 'llm', 'chatModelPriority'],
  ['contexa', 'llm', 'embeddingModelPriority'],
];

function getPath(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function flatten(obj, prefix, out) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) {
      flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out[prefix] = obj;
  }
}

module.exports = function (program) {
  program
    .command('scan')
    .description('Scan project for security and configuration issues')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan('\n  ' + t('scan.title') + '\n'));

      const s = ora('...').start();
      const project = await detectSpringProject(opts.dir);
      await new Promise(r => setTimeout(r, 200));
      s.stop();

      const issues = [], warnings = [], passes = [];

      if (!project.isSpring)              { issues.push(t('scan.notSpring')); }

      if (!project.hasContexta)           { issues.push(t('scan.contexaMissing')); }
      else                                { passes.push(t('scan.contexaInstalled')); }

      if (!project.hasSpringSecurityCore) { warnings.push(t('scan.springSecurityMissing')); }
      else                                { passes.push(t('scan.springSecurity')); }

      // @EnableAISecurity ↔ Spring AI / vector dep coupling.
      // Annotation requires a ChatModel + PgVector store; without those the
      // app will fail to start. Conversely, adding them when no annotation is
      // present causes PgVector bean creation errors. Surface both halves.
      if (project.hasEnableAiSecurity) {
        passes.push('@EnableAISecurity declared in src/main/java');
        const buildPath = project.buildFilePath;
        if (buildPath && await fs.pathExists(buildPath)) {
          const buildText = await fs.readFile(buildPath, 'utf8');
          const hasAnyAiStarter =
            buildText.includes('spring-ai-starter-model-ollama') ||
            buildText.includes('spring-ai-starter-model-openai') ||
            buildText.includes('spring-ai-starter-model-anthropic');
          if (!hasAnyAiStarter) {
            issues.push('@EnableAISecurity is declared but no Spring AI provider starter is on the build file. ' +
              'Add at least one of spring-ai-starter-model-{ollama,openai,anthropic}, or run "contexa init" again.');
          }
          const hasVectorStarter = buildText.includes('spring-ai-starter-vector-store-pgvector');
          if (!hasVectorStarter) {
            issues.push('@EnableAISecurity is declared but spring-ai-starter-vector-store-pgvector is missing. ' +
              'Without it the rag-vector capability cannot resolve and the application fails to start. ' +
              'Run "contexa init" again to auto-add it.');
          }
        }
      } else {
        // No annotation. If the build file already pulls Spring AI / vector
        // starters, warn that this will likely trigger bean instantiation
        // errors at startup.
        const buildPath = project.buildFilePath;
        if (buildPath && await fs.pathExists(buildPath)) {
          const buildText = await fs.readFile(buildPath, 'utf8');
          const hasAnyAiStarter =
            buildText.includes('spring-ai-starter-model-ollama') ||
            buildText.includes('spring-ai-starter-model-openai') ||
            buildText.includes('spring-ai-starter-model-anthropic');
          const hasVectorStarter = buildText.includes('spring-ai-starter-vector-store-pgvector');
          if (hasAnyAiStarter || hasVectorStarter) {
            warnings.push('Spring AI / vector starter is on the build file but @EnableAISecurity is NOT declared. ' +
              'PgVector / ChatModel beans may fail at startup. Either declare @EnableAISecurity on your @SpringBootApplication, or remove the unused starters.');
          }
        }
      }

      if (project.appPropertiesPath && project.appYmlPath) {
        warnings.push(t('scan.propertiesAndYml'));
      }

      if (project.appYmlPath) {
        passes.push(t('scan.ymlPresent'));
        const content = await fs.readFile(project.appYmlPath, 'utf8');
        let root = null;
        try { root = yaml.load(content); }
        catch (err) { issues.push(`application.yml parse error: ${err.message}`); }

        if (root && typeof root === 'object' && root.contexa) {
          passes.push(t('scan.blockPresent'));
          const modeRaw = getPath(root, ['contexa', 'security', 'zerotrust', 'mode']);
          const modeValue = (modeRaw || '').toString().toLowerCase();
          if (modeValue === 'shadow')       warnings.push(t('scan.shadowMode'));
          else if (modeValue === 'enforce') passes.push(t('scan.enforceMode'));

          // Default contexa DB password retained anywhere under contexa.datasource
          // or its env-fallback default.
          const flat = {};
          flatten(root.contexa, 'contexa', flat);
          for (const [k, v] of Object.entries(flat)) {
            if (typeof v === 'string' && v.includes(DEFAULT_DB_PASSWORD) &&
                k.startsWith('contexa.datasource.password')) {
              issues.push(t('scan.defaultDbPassword'));
              break;
            }
          }

          // Plaintext API key anywhere under spring.ai.* or contexa.* (sk- prefix)
          const allFlat = {};
          flatten(root, '', allFlat);
          for (const [k, v] of Object.entries(allFlat)) {
            if (typeof v === 'string' && /(api[-_]?key|apikey)/i.test(k) &&
                /^(sk-|sk_)/.test(v) && !v.includes('${')) {
              issues.push(t('scan.apiKeyExposed'));
              break;
            }
          }

          // Dead and deprecated keys
          for (const dk of DEAD_KEYS) {
            if (getPath(root, dk) !== undefined) {
              warnings.push(`Dead key ${dk.join('.')} - not bound by any @ConfigurationProperties; remove or move to spring.jpa.hibernate.ddl-auto`);
            }
          }
          for (const dpk of DEPRECATED_KEYS) {
            if (getPath(root, dpk) !== undefined) {
              warnings.push(`Deprecated key ${dpk.join('.')} - migrate to contexa.llm.selection.{chat,embedding}.priority`);
            }
          }

          // Duplicate top-level contexa: detection (yaml.load already throws on
          // strict-duplicate keys; surface a friendly message in case a non-strict
          // parser somewhere lets it through)
          const occurrences = (content.match(/^contexa\s*:/gm) || []).length;
          if (occurrences > 1) {
            issues.push(`Top-level "contexa:" appears ${occurrences} times in application.yml. Spring Boot will fail to start.`);
          }
        } else if (root) {
          warnings.push(t('scan.blockMissing'));
        }
      } else if (project.isSpring) {
        warnings.push(t('scan.ymlMissing'));
      }

      passes.forEach(p   => console.log(`  ${chalk.green('v')} ${p}`));
      warnings.forEach(w => console.log(`  ${chalk.yellow('!')} ${w}`));
      issues.forEach(i   => console.log(`  ${chalk.red('x')} ${i}`));

      console.log('');
      console.log(`  ${t('scan.passed')}: ${chalk.green(passes.length)}   ${t('scan.warnings')}: ${chalk.yellow(warnings.length)}   ${t('scan.issues')}: ${chalk.red(issues.length)}\n`);

      if (issues.length > 0) process.exitCode = 1;
    });
};
