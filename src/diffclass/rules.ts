import { isProtectedPath } from '../guards/self-protect.js';
import { compileGlob } from './glob.js';

/**
 * Paths a review-free class may never cover (ADR 0013, "Always class B"). Each entry is one rule with a stable id, so a
 * class-B verdict names which rule put a path there. Globs follow `glob.ts`: no `/` means any depth, matching is
 * case-insensitive, and a folder covers everything under it.
 */
export interface Exclusion {
  id: string;
  /** What the rule covers, as the reason line says it. */
  what: string;
  globs: readonly string[];
}

export const CODE_EXTENSIONS: readonly string[] = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'pyw', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'fsx', 'vb', 'php', 'pl', 'pm', 'lua', 'dart', 'ex', 'exs', 'erl',
  'hrl', 'hs', 'ml', 'mli', 'r', 'jl', 'clj', 'cljs', 'elm', 'zig', 'nim', 'sol', 'vue', 'svelte', 'astro', 'wasm', 'wat', 'coffee', 'sql',
  'tf', 'hcl', 'nix', 'bzl', 'cmake', 'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'vbs', 'wsf', 'applescript',
  'scpt', 'ipynb', 'awk', 'sed', 'tcl', 'el', 'vim', 'node',
];

export const EXCLUSIONS: readonly Exclusion[] = [
  {
    id: 'exclude.ci-config',
    what: 'CI configuration',
    globs: ['.github/', '.gitlab-ci.yml', '.gitlab/', '.circleci/', '.buildkite/', '.travis.yml', 'azure-pipelines.yml', 'azure-pipelines/', 'bitbucket-pipelines.yml', 'Jenkinsfile', '*.jenkinsfile', '.drone.yml', '.woodpecker.yml', '.woodpecker/', '.forgejo/', '.gitea/', 'appveyor.yml', '.appveyor.yml', 'cloudbuild.yaml', 'cloudbuild.yml', '.semaphore/', 'codemagic.yaml', '.teamcity/', 'buildspec.yml'],
  },
  { id: 'exclude.codeowners', what: 'CODEOWNERS', globs: ['CODEOWNERS'] },
  {
    id: 'exclude.lockfile',
    what: 'a lockfile',
    globs: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'Gemfile.lock', 'composer.lock', 'pubspec.lock', 'Package.resolved', 'Podfile.lock', 'flake.lock', 'packages.lock.json', 'gradle.lockfile', 'mix.lock', 'deno.lock', '*.lock'],
  },
  {
    id: 'exclude.manifest',
    what: 'a package manifest or toolchain pin',
    globs: ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Cargo.toml', 'go.mod', 'go.work', 'Gemfile', '*.gemspec', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle/', 'pubspec.yaml', 'composer.json', '*.csproj', '*.fsproj', '*.vbproj', '*.sln', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'nuget.config', 'requirements*.txt', 'constraints*.txt', 'Pipfile', 'environment.yml', 'deno.json', 'deno.jsonc', 'bunfig.toml', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json', 'mix.exs', 'Package.swift', 'Podfile', 'Cartfile', '*.cabal', 'stack.yaml', 'dune-project', '*.opam', 'vcpkg.json', 'conanfile.*', 'flake.nix', '.tool-versions', '.nvmrc', '.node-version', '.python-version', 'rust-toolchain', 'rust-toolchain.toml', 'MANIFEST.in'],
  },
  {
    id: 'exclude.build-script',
    what: 'a build or install script',
    globs: ['Makefile', 'GNUmakefile', '*.mk', 'scripts/', 'script/', 'bin/', 'Dockerfile', 'Dockerfile.*', '*.dockerfile', 'Containerfile', 'docker-compose*.yml', 'docker-compose*.yaml', 'compose.yml', 'compose.yaml', 'Justfile', 'Taskfile*', 'Rakefile', 'Earthfile', 'Tiltfile', 'Vagrantfile', 'Procfile', 'CMakeLists.txt', 'meson.build', 'BUILD', 'BUILD.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel', '.bazelrc', '.husky/', '.githooks/', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', 'tsconfig*.json', 'jsconfig*.json', '*.config.js', '*.config.cjs', '*.config.mjs', '*.config.ts', '*.config.mts', '*.config.cts', '.babelrc', '.babelrc.*', '.swcrc', '.eslintrc', '.eslintrc.*', '.prettierrc', '.prettierrc.*', '.envrc'],
  },
  {
    id: 'exclude.test-runner-config',
    what: 'test-runner configuration',
    globs: ['jest.config.*', 'vitest.config.*', 'vitest.workspace.*', 'karma.conf.*', '.mocharc', '.mocharc.*', 'ava.config.*', 'playwright.config.*', 'cypress.config.*', 'cypress.json', 'pytest.ini', 'conftest.py', 'tox.ini', 'noxfile.py', '.coveragerc', 'dart_test.yaml', 'analysis_options.yaml', 'phpunit.xml', 'phpunit.xml.dist', '.rspec', '.nycrc', '.nycrc.*', '.c8rc', '.c8rc.*', 'jasmine.json', 'wdio.conf.*', 'codecov.yml', '.codecov.yml', '.test-lock'],
  },
  {
    id: 'exclude.test-file',
    what: 'a test file',
    globs: ['test/', 'tests/', '__tests__/', 'spec/', 'specs/', 'e2e/', 'testdata/', '__snapshots__/', '__mocks__/', '*.test.*', '*.spec.*', '*_test.*', 'test_*.py', '*_spec.rb', '*.snap'],
  },
  {
    id: 'exclude.executable',
    what: 'executable source',
    globs: ['src/', 'lib/', 'app/', 'cmd/', 'pkg/', 'internal/', ...CODE_EXTENSIONS.map((e) => `*.${e}`)],
  },
  {
    id: 'exclude.agent-instructions',
    what: 'agent instructions or host configuration',
    globs: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'SKILL.md', 'CONVENTIONS.md', '*.prompt.md', '*.prompt', '*.prompt.yml', '*.instructions.md', 'copilot-instructions.md', '.cursorrules', '.windsurfrules', '.clinerules', '.roorules', '.aider*', '.claude/', '.codex/', '.gemini/', '.opencode/', '.openclaw/', '.cursor/', '.windsurf/', '.vscode/', '.idea/', '.devcontainer/', '.continue/', '.roo/', '.amazonq/', '.kiro/', '.zed/', 'prompts/', '.mcp.json', 'mcp.json', 'opencode.json', 'opencode.jsonc', 'openclaw.json', '.openmorals/'],
  },
  {
    id: 'exclude.readme-legal',
    what: 'a README, security, licence or notice file',
    globs: ['README', 'README.*', 'SECURITY', 'SECURITY.*', 'LICENSE', 'LICENSE.*', 'LICENSE-*', 'LICENCE', 'LICENCE.*', 'NOTICE', 'NOTICE.*', 'COPYING', 'COPYING.*', 'CONTRIBUTING', 'CONTRIBUTING.*'],
  },
  {
    id: 'exclude.secrets',
    what: 'a secrets or credentials file',
    globs: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.netrc', '.pypirc', 'credentials', 'credentials.*', '*.keystore', '*.jks'],
  },
  {
    id: 'exclude.git-config',
    what: 'git configuration (attributes, submodules)',
    globs: ['.gitattributes', '.gitmodules', '.gitconfig', '.lfsconfig'],
  },
  {
    id: 'exclude.classifier',
    what: 'the merge verdict itself',
    globs: ['cases/diff-class.cases.yaml', 'docs/merge-verdict.md', 'docs/test-integrity.md', 'diffclass/'],
  },
];

const COMPILED: ReadonlyMap<string, readonly ((p: string) => boolean)[]> = new Map(EXCLUSIONS.map((x) => [x.id, x.globs.map(compileGlob)]));

/** The bylaws file names at the repository root: the only bylaws file A1 reads. */
export const ROOT_BYLAWS = ['openmorals.yaml', 'openmorals.yml'] as const;

export function isRootBylaws(path: string): boolean {
  return ROOT_BYLAWS.some((n) => n === path);
}

export interface ExclusionHit {
  id: string;
  what: string;
}

/**
 * Every exclusion a path falls under, in list order. Also: a file the self-protect guard protects (hook and host
 * configuration, the openmorals records), except the root bylaws file, which has its own tighten-only check.
 */
export function exclusionsFor(path: string, exclusions: readonly Exclusion[] = EXCLUSIONS): ExclusionHit[] {
  const out: ExclusionHit[] = [];
  for (const x of exclusions) {
    const tests = exclusions === EXCLUSIONS ? (COMPILED.get(x.id) ?? []) : x.globs.map(compileGlob);
    if (tests.some((t) => t(path))) out.push({ id: x.id, what: x.what });
  }
  if (!isRootBylaws(path) && isProtectedPath(path) && !out.some((h) => h.id === 'exclude.agent-instructions')) out.push({ id: 'exclude.self-protected', what: 'a file the self-protect guard protects' });
  return out;
}

/** Scanner rules run over the added text of a review-free candidate: hidden instructions and obfuscation. */
export const SCAN_RULE_PREFIXES: readonly string[] = ['inject.', 'obfusc.'];

/** What `diff-class` cannot see from a diff (ADR 0013 preconditions), printed with every verdict. */
export const CANNOT_SEE: readonly string[] = [
  'whether this ran on CI from the base branch\'s code and settings, reading the head only as git objects',
  'whether the verdict is a required status pinned to an app identity the agent holds no credential for',
  'whether CI itself ran the tests on the commit to be merged',
  'whether merging publishes or deploys anything',
  'whether the base folder it read is the base of this diff (it checks the git hashes of the files it rebuilds, nothing else)',
];

/** Added for a reproduced diff: the tool and its pin live outside the diff. */
export const CANNOT_SEE_REPRODUCED = 'whether the reproduced diff came from a deterministic, network-free tool pinned in the base branch and run by CI on the base tree';
