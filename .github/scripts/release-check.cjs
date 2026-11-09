'use strict';

const fs = require('node:fs');

function notesPath(tag) {
  return `.github/release-notes/${tag}.md`;
}

// notes is the notes file content, or null when the file is missing.
function checkRelease({ tag, version, notes }) {
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Release tag "${tag ?? ''}" must look like vX.Y.Z.`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package.json version ${version}; expected v${version}.`);
  }
  if (notes === null || notes === undefined) {
    throw new Error(`Missing release notes: add ${notesPath(tag)} before tagging.`);
  }
  if (!notes.trim()) {
    throw new Error(`Empty release notes: ${notesPath(tag)} has no text.`);
  }
}

// Usage: node .github/scripts/release-check.cjs <tag>, from the repository root.
function main(tag) {
  try {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    let notes = null;
    if (typeof tag === 'string' && /^v\d+\.\d+\.\d+$/.test(tag)) {
      try {
        notes = fs.readFileSync(notesPath(tag), 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    checkRelease({ tag, version, notes });
    process.stdout.write(`Release ${tag} is ready: ${notesPath(tag)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv[2]);

module.exports = { checkRelease, main };
