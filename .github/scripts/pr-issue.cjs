'use strict';

// Drop fenced code blocks (``` or ~~~); an unclosed fence runs to the end.
function stripFences(text) {
  const lines = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length
        && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
    } else if (marker) {
      fence = marker;
    } else {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

// PR content is data only. Resolve references within the workflow's repository.
async function validateIssue({ body, github, context }) {
  const visible = stripFences((body || '').replace(/<!--[\s\S]*?(?:-->|$)/g, ''));
  const numbers = [...new Set([...visible.matchAll(/^\s*Closes #([0-9]+)\s*$/gim)]
    .map(match => Number(match[1]))
    .filter(number => Number.isSafeInteger(number) && number > 0))];
  if (!numbers.length) {
    throw new Error('Add a standalone line: Closes #<number>. Read CONTRIBUTING.md for the issue-first workflow.');
  }
  for (const issue_number of numbers) {
    try {
      const { data } = await github.rest.issues.get({ ...context.repo, issue_number });
      if (!data.pull_request) return issue_number;
    } catch (error) {
      // 404: missing or not visible; 410: deleted issue.
      if (error.status !== 404 && error.status !== 410) throw error;
    }
  }
  throw new Error('Closes must reference at least one existing issue in this repository, not a pull request.');
}

module.exports = { validateIssue };
