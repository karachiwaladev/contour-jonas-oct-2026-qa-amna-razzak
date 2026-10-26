#!/usr/bin/env node
// Repo security check, run in CI and by the factory loop before every PR: npm run security
//  1. No secrets in tracked files (token/key patterns and secret-looking filenames).
//  2. No unsafe DOM writes in app code (innerHTML/outerHTML/insertAdjacentHTML/document.write/eval).
//  3. Every HTML page ships a strict Content-Security-Policy (no 'unsafe-inline' / 'unsafe-eval').
// Exits non-zero with a list of findings; prints "security check passed" otherwise.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const files = execSync("git ls-files -z", { cwd: root }).toString().split("\0").filter(Boolean);
const findings = [];
const add = (file, msg) => findings.push(`${file}: ${msg}`);

const SECRET_FILE = /(^|\/)(\.env(\..+)?|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.pem|[^/]*\.key|[^/]*\.p12|hosts\.yml|credentials[^/]*)$/i;
const SECRET_TEXT = [
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{40,}/, "GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/sk-[A-Za-z0-9_-]{32,}/, "API secret key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/xox[abpors]-[A-Za-z0-9-]{10,}/, "Slack token"],
];
const UNSAFE_DOM = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new Function\s*\(/;
const TEXT_EXT = /\.(js|mjs|cjs|ts|json|md|html|css|yml|yaml|sh|txt|jsonl)$/i;

for (const file of files) {
  if (SECRET_FILE.test(file)) add(file, "secret-looking file is tracked");
  if (!TEXT_EXT.test(file) || file.startsWith("node_modules/")) continue;
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const [re, what] of SECRET_TEXT) if (re.test(text)) add(file, `possible ${what}`);

  const isAppCode = /\.(js|mjs|cjs)$/.test(file) && !/(^|\/)(tests?|scripts)\//.test(file) && !/config\.js$/.test(file);
  if (isAppCode) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (UNSAFE_DOM.test(line) && !/^\s*\/\//.test(line)) add(`${file}:${i + 1}`, `unsafe DOM/eval sink: ${line.trim()}`);
    });
  }

  if (/\.html$/.test(file) && !/(^|\/)(tests?|playwright-report)\//.test(file)) {
    const csp = text.match(/http-equiv=["']Content-Security-Policy["']\s+content=["']([^"']+)["']/i);
    if (!csp) add(file, "missing Content-Security-Policy meta tag");
    else if (/unsafe-inline|unsafe-eval/.test(csp[1])) add(file, `weak CSP: ${csp[1]}`);
  }
}

if (findings.length) {
  console.error(`security check failed (${findings.length}):\n  - ${findings.join("\n  - ")}`);
  process.exit(1);
}
console.log(`security check passed (${files.length} tracked files)`);
