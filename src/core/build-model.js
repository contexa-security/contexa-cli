'use strict';

const path = require('path');

// Structural build-file readers shared by project detection and dependency
// injection. They intentionally do not evaluate Maven properties or execute a
// Gradle script; their job is to identify ownership scopes without treating
// comments, strings, dependencyManagement, buildscript, or pluginManagement as
// installed application dependencies.

function localName(name) {
  const value = String(name || '');
  const separator = value.indexOf(':');
  return (separator === -1 ? value : value.slice(separator + 1)).toLowerCase();
}

function findTagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  throw new Error('Maven XML is malformed: an element is not closed.');
}

function parseXmlTree(source) {
  const roots = [];
  const stack = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening === -1) break;
    if (source.startsWith('<!--', opening)) {
      const end = source.indexOf('-->', opening + 4);
      if (end === -1) throw new Error('Maven XML is malformed: an XML comment is not closed.');
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', opening)) {
      const end = source.indexOf(']]>', opening + 9);
      if (end === -1) throw new Error('Maven XML is malformed: a CDATA section is not closed.');
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', opening)) {
      const end = source.indexOf('?>', opening + 2);
      if (end === -1) throw new Error('Maven XML is malformed: a processing instruction is not closed.');
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('<!', opening)) {
      const end = findTagEnd(source, opening);
      cursor = end + 1;
      continue;
    }

    const tagEnd = findTagEnd(source, opening);
    const raw = source.slice(opening + 1, tagEnd).trim();
    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim().split(/\s+/)[0]);
      const node = stack.pop();
      if (!node || node.name !== name) {
        throw new Error(`Maven XML is malformed: unexpected closing element ${name || '(empty)'}.`);
      }
      node.closeStart = opening;
      node.end = tagEnd + 1;
    } else {
      const selfClosing = /\/\s*$/.test(raw);
      const qualifiedName = raw.replace(/\/\s*$/, '').trim().split(/\s+/)[0];
      const node = {
        name: localName(qualifiedName),
        start: opening,
        openEnd: tagEnd + 1,
        closeStart: selfClosing ? tagEnd : null,
        end: selfClosing ? tagEnd + 1 : null,
        parent: stack.length > 0 ? stack[stack.length - 1] : null,
        children: [],
      };
      if (node.parent) node.parent.children.push(node);
      else roots.push(node);
      if (!selfClosing) stack.push(node);
    }
    cursor = tagEnd + 1;
  }
  if (stack.length > 0) {
    throw new Error(`Maven XML is malformed: element ${stack[stack.length - 1].name} is not closed.`);
  }
  return roots;
}

function directChild(node, name) {
  return node ? node.children.find(child => child.name === name) || null : null;
}

function directChildren(node, name) {
  return node ? node.children.filter(child => child.name === name) : [];
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function elementText(source, node) {
  if (!node || node.closeStart === null) return '';
  return decodeXmlText(source.slice(node.openEnd, node.closeStart).replace(/<[^>]*>/g, ''));
}

function mavenCoordinate(source, node, kind, managed) {
  const group = elementText(source, directChild(node, 'groupid'));
  const artifact = elementText(source, directChild(node, 'artifactid'));
  if (!artifact) return null;
  const version = elementText(source, directChild(node, 'version')) || null;
  const scope = elementText(source, directChild(node, 'scope')) || null;
  return {
    group,
    artifact,
    version,
    versionSource: version && /^\$\{[^}]+\}$/.test(version) ? 'property' : (version ? 'literal' : 'managed'),
    configuration: kind === 'plugin' ? 'plugin' : (scope || 'compile'),
    managed: !!managed,
    start: node.start,
    end: node.end,
  };
}

function coordinatesFromContainer(source, container, kind, managed) {
  if (!container) return [];
  const elementName = kind === 'plugin' ? 'plugin' : 'dependency';
  return directChildren(container, elementName)
    .map(node => mavenCoordinate(source, node, kind, managed))
    .filter(Boolean);
}

function parseMavenModel(source) {
  const roots = parseXmlTree(source);
  const project = roots.find(node => node.name === 'project');
  if (!project) throw new Error('Maven XML is malformed: project root element is required.');

  const parentNode = directChild(project, 'parent');
  const dependenciesNode = directChild(project, 'dependencies');
  const managementNode = directChild(project, 'dependencymanagement');
  const managedDependenciesNode = directChild(managementNode, 'dependencies');
  const buildNode = directChild(project, 'build');
  const pluginsNode = directChild(buildNode, 'plugins');
  const pluginManagementNode = directChild(buildNode, 'pluginmanagement');
  const managedPluginsNode = directChild(pluginManagementNode, 'plugins');
  const modulesNode = directChild(project, 'modules');

  return {
    project,
    projectName: elementText(source, directChild(project, 'artifactid')) || null,
    packaging: elementText(source, directChild(project, 'packaging')) || 'jar',
    parent: parentNode ? mavenCoordinate(source, parentNode, 'parent', false) : null,
    dependencies: coordinatesFromContainer(source, dependenciesNode, 'dependency', false),
    managedDependencies: coordinatesFromContainer(source, managedDependenciesNode, 'dependency', true),
    plugins: coordinatesFromContainer(source, pluginsNode, 'plugin', false),
    managedPlugins: coordinatesFromContainer(source, managedPluginsNode, 'plugin', true),
    modules: directChildren(modulesNode, 'module').map(node => elementText(source, node)).filter(Boolean),
    dependenciesCloseIndex: dependenciesNode ? dependenciesNode.closeStart : -1,
    managedDependenciesCloseIndex: managedDependenciesNode ? managedDependenciesNode.closeStart : -1,
    dependencyManagementCloseIndex: managementNode ? managementNode.closeStart : -1,
    projectCloseIndex: project.closeStart,
  };
}

function tokenizeGradle(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (type, value, start, end, tokenLine = line) =>
    tokens.push({ type, value, start, end, line: tokenLine });
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '\r' || character === '\n') {
      const start = index;
      if (character === '\r' && next === '\n') index++;
      index++;
      push('newline', '\n', start, index, line);
      line++;
      continue;
    }
    if (/\s/.test(character)) { index++; continue; }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line++;
        index++;
      }
      if (index >= source.length) throw new Error('Gradle script is malformed: a block comment is not closed.');
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const triple = source.slice(index, index + 3) === quote.repeat(3);
      const start = index;
      const tokenLine = line;
      index += triple ? 3 : 1;
      let value = '';
      let closed = false;
      while (index < source.length) {
        if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
          index += 3;
          closed = true;
          break;
        }
        if (!triple && source[index] === quote) {
          index++;
          closed = true;
          break;
        }
        if (source[index] === '\\' && !triple && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
          continue;
        }
        if (source[index] === '\n') line++;
        value += source[index++];
      }
      if (!closed) throw new Error('Gradle script is malformed: a string literal is not closed.');
      push('string', value, start, index, tokenLine);
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_$.-]/.test(source[index])) index++;
      push('identifier', source.slice(start, index), start, index);
      continue;
    }
    push('punctuation', character, index, index + 1);
    index++;
  }
  return tokens;
}

function blockName(tokens, braceIndex) {
  for (let index = braceIndex - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token.type === 'newline' || ['}', '{', ';'].includes(token.value)) break;
    if (token.type === 'identifier') return token.value;
  }
  return null;
}

function gradleBlocks(tokens) {
  const blocks = [];
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '{') {
      const block = {
        name: blockName(tokens, index),
        openTokenIndex: index,
        closeTokenIndex: null,
        start: token.start,
        contentStart: token.end,
        end: null,
        parent: stack.length > 0 ? stack[stack.length - 1] : null,
      };
      blocks.push(block);
      stack.push(block);
    } else if (token.value === '}') {
      const block = stack.pop();
      if (!block) throw new Error('Gradle script is malformed: unexpected closing brace.');
      block.closeTokenIndex = index;
      block.end = token.start;
    }
  }
  if (stack.length > 0) throw new Error('Gradle script is malformed: a block is not closed.');
  return blocks;
}

function ancestors(block) {
  const names = [];
  let current = block && block.parent;
  while (current) {
    if (current.name) names.unshift(current.name);
    current = current.parent;
  }
  return names;
}

function dependencyConfiguration(tokens, stringIndex, block) {
  const line = tokens[stringIndex].line;
  for (let index = stringIndex - 1; index > block.openTokenIndex; index--) {
    const token = tokens[index];
    if (token.type === 'newline' && token.line < line) break;
    if (token.type === 'identifier' && !['platform', 'enforcedPlatform'].includes(token.value)) {
      return token.value;
    }
    if ([';', '{', '}'].includes(token.value)) break;
  }
  return null;
}

function coordinatesInGradleBlock(tokens, block) {
  const coordinates = [];
  for (let index = block.openTokenIndex + 1; index < block.closeTokenIndex; index++) {
    const token = tokens[index];
    if (token.type !== 'string') continue;
    const match = token.value.match(/^([^:\s]+):([^:\s]+)(?::(.+))?$/);
    if (!match) continue;
    const configuration = dependencyConfiguration(tokens, index, block);
    if (!configuration) continue;
    coordinates.push({
      group: match[1],
      artifact: match[2],
      version: match[3] || null,
      versionSource: match[3]
        ? (/[$`]/.test(match[3]) ? 'expression' : 'literal')
        : 'managed',
      configuration,
      managed: false,
      start: token.start,
      end: token.end,
      scope: ancestors(block),
    });
  }
  return coordinates;
}

function pluginIds(tokens, blocks) {
  const ids = [];
  for (const block of blocks.filter(item => item.name === 'plugins' && !item.parent)) {
    for (let index = block.openTokenIndex + 1; index < block.closeTokenIndex; index++) {
      if (tokens[index].type !== 'identifier' || tokens[index].value !== 'id') continue;
      const value = tokens.slice(index + 1, block.closeTokenIndex).find(token =>
        token.type === 'string' || token.type === 'newline');
      if (value && value.type === 'string') ids.push(value.value);
    }
  }
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index].type === 'identifier' && tokens[index].value === 'apply') {
      const sameLine = tokens.slice(index + 1).find(token =>
        token.type === 'string' || token.type === 'newline');
      if (sameLine && sameLine.type === 'string') ids.push(sameLine.value);
    }
  }
  return [...new Set(ids)];
}

function parseGradleModel(source) {
  const tokens = tokenizeGradle(source);
  const blocks = gradleBlocks(tokens);
  const dependencyBlocks = blocks
    .filter(block => block.name === 'dependencies')
    .map(block => ({ block, coordinates: coordinatesInGradleBlock(tokens, block) }));
  const topLevelDependencies = dependencyBlocks.find(item => !item.block.parent) || null;
  return {
    tokens,
    blocks,
    pluginIds: pluginIds(tokens, blocks),
    dependencyBlocks,
    topLevelDependencies,
    dependencies: topLevelDependencies ? topLevelDependencies.coordinates : [],
  };
}

function gradleIncludedModules(source) {
  const tokens = tokenizeGradle(source);
  const modules = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'identifier' || token.value !== 'include') continue;
    const startLine = token.line;
    let parentheses = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const candidate = tokens[cursor];
      if (candidate.value === '(') parentheses++;
      else if (candidate.value === ')') {
        parentheses--;
        if (parentheses <= 0) break;
      } else if (candidate.type === 'newline' && parentheses === 0 && candidate.line >= startLine) {
        break;
      } else if (candidate.type === 'string') {
        modules.push(candidate.value);
      }
    }
  }
  return [...new Set(modules)];
}

function gradleProjectName(source) {
  const tokens = tokenizeGradle(source);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'identifier'
        || tokens[index].value !== 'rootProject.name') continue;
    const value = tokens.slice(index + 1).find(token =>
      token.type === 'string' || token.type === 'newline');
    if (value && value.type === 'string') return value.value;
  }
  return null;
}

function gradleModuleDirectories(rootDir, source) {
  const tokens = tokenizeGradle(source);
  const mappings = new Map();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'identifier' || tokens[index].value !== 'project') continue;
    const line = tokens[index].line;
    const lineTokens = [];
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor].type === 'newline' && tokens[cursor].line >= line) break;
      lineTokens.push(tokens[cursor]);
    }
    const strings = lineTokens.filter(token => token.type === 'string');
    const projectDirIndex = lineTokens.findIndex(token =>
      token.type === 'identifier' && token.value === 'projectDir');
    if (strings.length >= 2 && projectDirIndex !== -1) {
      mappings.set(strings[0].value, strings[strings.length - 1].value);
    }
  }
  return gradleIncludedModules(source).map(moduleName => {
    const configured = mappings.get(moduleName)
      || mappings.get(moduleName.startsWith(':') ? moduleName : `:${moduleName}`);
    const relative = configured
      || moduleName.replace(/^:/, '').replace(/:/g, path.sep);
    return path.resolve(rootDir, relative);
  });
}

function hasCoordinate(coordinates, group, artifact) {
  return (coordinates || []).some(item => item.group === group && item.artifact === artifact);
}

module.exports = {
  parseMavenModel,
  parseGradleModel,
  gradleIncludedModules,
  gradleProjectName,
  gradleModuleDirectories,
  hasCoordinate,
};
