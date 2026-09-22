import * as os from 'os';
import * as path from 'path';
import { existsSync, readdirSync } from 'fs';

const OPENCODE_APP_NAME = 'opencode';
const DEFAULT_DATABASE_NAME = 'opencode.db';
const DATABASE_NAME_PATTERN = /^opencode(?:-[a-z0-9._-]+)?\.db$/i;

export interface PathFs {
	existsSync: (p: string) => boolean;
	readdirSync: (p: string) => string[];
}

const defaultFs: PathFs = {
	existsSync,
	readdirSync: (p) => readdirSync(p).map(String),
};

/** Resolve the OpenCode data directory (XDG on Linux/macOS, Application Support on macOS). */
export function resolveOpencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const xdgDataHome = env.XDG_DATA_HOME?.trim();
	if (xdgDataHome) return path.join(xdgDataHome, OPENCODE_APP_NAME);
	const home = env.HOME || os.homedir();
	return path.join(home, '.local', 'share', OPENCODE_APP_NAME);
}

/** Candidate database file paths, most-likely first. */
export function getOpencodeDatabaseCandidates(env: NodeJS.ProcessEnv = process.env, fs: PathFs = defaultFs): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const home = env.HOME || os.homedir();
	const dataDirs = [
		resolveOpencodeDataDir(env),
		path.join(home, 'Library', 'Application Support', OPENCODE_APP_NAME),
	];

	for (const dataDir of dataDirs) {
		push(candidates, seen, path.join(dataDir, DEFAULT_DATABASE_NAME));
		try {
			const entries = fs.readdirSync(dataDir)
				.filter((entry) => DATABASE_NAME_PATTERN.test(entry))
				.sort((a, b) => (a === DEFAULT_DATABASE_NAME ? -1 : b === DEFAULT_DATABASE_NAME ? 1 : a.localeCompare(b)));
			for (const entry of entries) {
				push(candidates, seen, path.join(dataDir, entry));
			}
		} catch {
			// Missing or unreadable data dirs are expected on fresh installs.
		}
	}

	return candidates;
}

/** Resolve the effective OpenCode database path, or null when none can be found. */
export function resolveOpencodeDatabasePath(env: NodeJS.ProcessEnv = process.env, fs: PathFs = defaultFs): string | null {
	const override = env.OPENCODE_DB?.trim();
	if (override) {
		if (override === ':memory:' || path.isAbsolute(override)) return override;
		return path.join(resolveOpencodeDataDir(env), override);
	}

	const candidates = getOpencodeDatabaseCandidates(env, fs);
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// Ignore unreadable locations.
		}
	}
	return null;
}

function push(candidates: string[], seen: Set<string>, candidate: string): void {
	if (seen.has(candidate)) return;
	seen.add(candidate);
	candidates.push(candidate);
}
