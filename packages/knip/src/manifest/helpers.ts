import { existsSync, readFileSync } from 'node:fs';
import type { Scripts } from '../types/package-json.ts';
import { dirname, join } from '../util/path.ts';
import { _require } from '../util/require.ts';
import { isFile } from '../util/fs.ts';

type LoadPackageManifestOptions = { dir: string; packageName: string; cwd: string };

const monorepoRootCache = new Map<string, string | undefined>();

const findMonorepoRootAbove = (startDir: string): string | undefined => {
  if (monorepoRootCache.has(startDir)) return monorepoRootCache.get(startDir);
  let current = dirname(startDir);
  let result: string | undefined;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      result = current;
      break;
    }
    try {
      const pkg = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'));
      if (pkg.workspaces) {
        result = current;
        break;
      }
    } catch {}
    current = dirname(current);
  }
  monorepoRootCache.set(startDir, result);
  return result;
};

const pnpStatus = {
  dir: '',
  pnpPath: '',
  enabled: false,
};

export const loadPackageManifest = ({ dir, packageName, cwd }: LoadPackageManifestOptions) => {
  // Try Yarn PnP first
  const manifest = tryLoadManifestWithYarnPnp(dir, packageName);

  if (manifest != null) {
    return manifest;
  }

  // Fallback to traditional node_modules resolution
  try {
    return _require(join(dir, 'node_modules', packageName, 'package.json'));
  } catch {}
  if (dir !== cwd) {
    try {
      return _require(join(cwd, 'node_modules', packageName, 'package.json'));
    } catch {}
    return;
  }
  const root = findMonorepoRootAbove(cwd);
  if (root) {
    try {
      return _require(join(root, 'node_modules', packageName, 'package.json'));
    } catch {}
  }
};

export const getFilteredScripts = (scripts: Scripts) => {
  if (!scripts) return [{}, {}];

  const productionScripts: Scripts = {};
  const developmentScripts: Scripts = {};

  for (const scriptName in scripts) {
    if (!/^\w/.test(scriptName)) continue;
    if (scriptName === 'start') productionScripts[scriptName] = scripts[scriptName];
    else developmentScripts[scriptName] = scripts[scriptName];
  }

  return [productionScripts, developmentScripts];
};

const findNearestPnPFile = (startDir: string) => {
  // Find the nearest .pnp.cjs file by traversing up
  let currentDir = startDir;
  while (currentDir !== '/') {
    const pnpPath = join(currentDir, '.pnp.cjs');
    if (isFile(pnpPath)) {
      const pnpApi = _require(pnpPath);
      pnpApi.setup();
      pnpStatus.dir = startDir;
      pnpStatus.pnpPath = pnpPath;
      pnpStatus.enabled = true;
      return;
    }
    // Move up one directory
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached root
    }
    currentDir = parentDir;
  }
  pnpStatus.dir = startDir;
  pnpStatus.pnpPath = '';
  pnpStatus.enabled = false;
};

const tryLoadManifestWithYarnPnp = (dir: string, packageName: string) => {
  const readManifest = (manifestPath: string) => {
    // We need to require fs dynamically here because pnp patches it.
    const _readFileSync = _require('fs').readFileSync;
    return JSON.parse(_readFileSync(manifestPath, 'utf8'));
  };

  if (pnpStatus.dir === dir && pnpStatus.enabled === false) {
    return null;
  }

  try {
    if (pnpStatus.dir !== dir) {
      findNearestPnPFile(dir);
    }

    if (pnpStatus.enabled) {
      const pnpApi = _require(pnpStatus.pnpPath);

      if (pnpApi != null) {
        const packageJsonPath = join(packageName, 'package.json');
        const resolvedPath = pnpApi.resolveToUnqualified(packageJsonPath, dir);

        return readManifest(resolvedPath);
      }
    }
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: ignore
    console.error(error);
    // Explicitly suppressing errors here
  }

  return null;
};