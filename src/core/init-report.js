'use strict';

const chalk = require('chalk');
const { t } = require('./i18n');
const { aiProviderSelected } = require('./init-plan');
const { simulationRunCommand } = require('./simulation');

function printInitCompletion(context) {
  const {
    answers,
    project,
    standaloneDir,
    shouldWriteHostConfig,
    standaloneResult,
    simulate,
    projectDir,
    aiAnnotationApplied,
    aiDependenciesProcessed,
  } = context;

  console.log(chalk.cyan('\n  ============================================================'));
  console.log(chalk.cyan(`     Contexa ${t('init.done')}`));
  console.log(chalk.cyan('  ============================================================\n'));

  console.log(chalk.green(`  [${t('init.report.automated')}]:`));
  if (answers.integrationMode === 'standalone') {
    console.log(chalk.gray(`    v ${t('init.report.standaloneCreated', standaloneDir)}`));
  } else {
    console.log(chalk.gray(shouldWriteHostConfig
      ? `    v ${t('init.report.hostConfigMerged')}`
      : `    v ${t('init.report.hostConfigPreserved')}`));
    console.log(chalk.gray(`    v ${t('init.report.starterAdded')}`));
  }

  if (answers.infra !== 'skip') {
    console.log(chalk.gray(`    v ${t('init.report.infrastructureProcessed')}`));
  }

  if (standaloneResult) {
    console.log(chalk.yellow(`\n  [${t('init.report.standaloneWiring')}]:`));
    console.log(chalk.gray(`    ${t('standalone.imports.yml')}`));
    console.log(chalk.cyan('       spring:'));
    console.log(chalk.cyan('         config:'));
    console.log(chalk.cyan('           import: "optional:file:./contexa/application.yml"'));

    if (standaloneResult.importHints.isMaven) {
      console.log(chalk.gray(`\n    ${t('standalone.imports.maven')}`));
      console.log(chalk.cyan(`       ${standaloneResult.buildFragmentPath}`));
      console.log(chalk.gray(`      ${t('standalone.imports.mavenNote')}`));
    } else {
      console.log(chalk.gray(`\n    ${t('standalone.imports.gradleGroovy')}`));
      console.log(chalk.cyan("       apply from: 'contexa/contexa.gradle'"));
    }
  }

  console.log(chalk.yellow(`\n  [${t('init.report.nextChecks')}]:`));
  if (simulate) {
    console.log(chalk.white(`    ${t('init.report.simulationRun')}`));
    console.log(chalk.cyan(`       ${simulationRunCommand(projectDir)}`));
    console.log(chalk.gray(`    ${t('init.report.simulationLauncher')}`));
  } else {
    let manualStep = 1;
    if (answers.enableAiSecurity && !aiAnnotationApplied) {
      console.log(chalk.white(`    ${manualStep++}. ${t('init.report.addAnnotation')}`));
      console.log(chalk.cyan('       ----------------------------------------------------'));
      console.log(chalk.cyan(`       @EnableAISecurity(mode = SecurityMode.${answers.securityMode.toUpperCase()})`));
      console.log(chalk.cyan('       @SpringBootApplication'));
      console.log(chalk.cyan('       public class YourApplication { }'));
      console.log(chalk.cyan('       ----------------------------------------------------'));
    }

    if (answers.enableAiSecurity) {
      console.log(chalk.white(`    ${manualStep++}. ${t('init.report.verifyProviders')}`));
      console.log(chalk.gray(`       - ${t('init.report.providers', answers.llmProviders.join(', '))}`));
      console.log(chalk.gray(`       - ${t('init.report.secrets')}`));
      if (aiDependenciesProcessed) {
        console.log(chalk.gray(`       - ${t('init.report.dependenciesProcessed')}`));
      }
    } else {
      console.log(chalk.white(`    ${manualStep++}. ${t('init.report.aiDisabled')}`));
      console.log(chalk.gray(`       ${t('init.report.aiDisabledHint')}`));
    }

    console.log(chalk.white(`    ${manualStep++}. ${t('init.report.runAndDiagnose')}`));
    console.log(chalk.gray(`       - ${t('init.report.startServer')}: ${project.buildTool === 'maven' ? './mvnw spring-boot:run' : './gradlew bootRun'}`));
    const doctorProvider = aiProviderSelected(answers) ? ` --provider ${answers.llmProviders.join(',')}` : '';
    console.log(chalk.gray(`       - ${t('init.report.diagnose')}: contexa doctor${doctorProvider}`));
  }

  if (!simulate && answers.enableAiSecurity && answers.mode === 'shadow') {
    console.log(chalk.yellow(`\n  * ${t('init.report.shadowActive')}`));
    console.log(chalk.gray(`    ${t('init.report.shadowSwitch')}`));
  }

  console.log(chalk.red.bold(`\n  [${t('init.report.securityChecklist')}]:`));
  console.log(chalk.red(`    - ${t('warn.security.envVars')}`));
  console.log(chalk.red(`    - ${t('warn.security.gitignore')}`));
  console.log(chalk.red(`    - ${t('warn.security.demoUsers')}`));
  console.log(chalk.cyan('\n  ============================================================\n'));
}

module.exports = { printInitCompletion };
