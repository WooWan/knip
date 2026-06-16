import { readFile } from 'node:fs/promises';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import type { PackageJson, WorkspacePackage } from '../types/package-json.ts';
import { debugLog } from './debug.ts';
import { ConfigurationError } from './errors.ts';
import { logWarning } from './log.ts';
import { getPackageName } from './package-name.ts';
import { join } from './path.ts';

type Packages = Map<string, WorkspacePackage>;
type WorkspacePkgNames = Set<string>;
type WorkspaceMatcher = {
  isNegated: boolean;
  matcher: ReturnType<typeof picomatch>;
};

export default async function mapWorkspaces(cwd: string, workspaces: string[]): Promise<[Packages, WorkspacePkgNames]> {
  const packages: Packages = new Map();
  const wsPkgNames: WorkspacePkgNames = new Set();
  const patterns: string[] = [];
  const workspaceMatchers: WorkspaceMatcher[] = [];

  for (const pattern of workspaces) {
    const isNegated = pattern.startsWith('!');
    const normalizedPattern = isNegated ? pattern.slice(1) : pattern;
    if (!isNegated) patterns.push(pattern);
    workspaceMatchers.push({ isNegated, matcher: picomatch(normalizedPattern) });
  }

  if (patterns.length === 0) return [packages, wsPkgNames];

  const manifestPatterns = patterns.map(p => join(p, 'package.json'));

  const matches = await glob(manifestPatterns, {
    cwd,
    ignore: ['**/node_modules/**'],
  });

  for (const match of matches.sort()) {
    const name = match === 'package.json' ? '.' : match.replace(/\/package\.json$/, '');
    if (!isWorkspaceIncluded(name, workspaceMatchers)) continue;

    const dir = join(cwd, name);
    const manifestPath = join(cwd, match);
    try {
      const manifestStr = (await readFile(manifestPath, 'utf8')).replace(/^﻿/, '');
      const manifest: PackageJson = JSON.parse(manifestStr);
      const pkgName = getPackageName(manifest, dir);
      const pkg: WorkspacePackage = { dir, name, pkgName, manifestPath, manifestStr, manifest };
      packages.set(name, pkg);
      if (pkgName) wsPkgNames.add(pkgName);
      else throw new ConfigurationError(`Missing package name in ${manifestPath}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        debugLog('*', `Unable to load package.json for ${name}`);
      } else if (error instanceof SyntaxError) {
        logWarning(`Skipping workspace ${name}: invalid JSON in ${manifestPath} (${error.message})`);
      } else throw error;
    }
  }

  return [packages, wsPkgNames];
}

function isWorkspaceIncluded(name: string, matchers: WorkspaceMatcher[]): boolean {
  for (let i = matchers.length - 1; i >= 0; i--) {
    const { isNegated, matcher } = matchers[i];
    if (matcher(name)) return !isNegated;
  }
  return false;
}
