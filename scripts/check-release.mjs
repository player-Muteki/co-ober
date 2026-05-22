import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');

if (pkg.version !== manifest.version) {
  throw new Error(`package.json version (${pkg.version}) must match manifest.json version (${manifest.version})`);
}

if (!changelog.includes(`## ${pkg.version} -`)) {
  throw new Error(`CHANGELOG.md is missing an entry for ${pkg.version}`);
}

console.log(`Release metadata verified for ${pkg.version}`);
