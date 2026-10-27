// Pure, network-free ticket screening. Used by scripts/screen-ticket.js (locally and in CI) and the tests.
// screen(issue) -> { verdict: "clean" | "untrusted" | "quarantine", trusted, findings: [{ category, rule, where, excerpt }] }
// Any finding means quarantine: a human reviews it, the loop never works on it.
const crypto = require("crypto");
const config = require("./config.json");

const MARKER = /<!--\s*factory-loop:[\w-]+(?:\s+[^>]*?)?\s*-->/;
const BOT = /^github-actions(\[bot\])?$/;
const APPROVAL = /^\s*(approved?|lgtm|go ahead|yes)\b/i;

const PROMPT_INJECTION = [
  [/\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|these|system)\b[^.\n]{0,30}\b(instructions?|rules|prompts?|guidelines|directions|guardrails|constraints|polic(y|ies))\b/i, "ignore-your-instructions"],
  [/\byou are (now|no longer)\b/i, "role change"],
  [/\b(new|updated|real|actual|hidden|secret) (system )?instructions?\b/i, "replacement instructions"],
  [/\bsystem prompt\b/i, "system prompt"],
  [/\b(developer|god|admin|unrestricted) mode\b|\bjailbreak\b|\bDAN\b/i, "jailbreak"],
  [/\b(act|behave|respond|operate) as (an? |the )?(admin|administrator|root|system|developer|maintainer|owner)\b/i, "act as privileged role"],
  [/\bpretend (that )?(you are|you're|to be)\b/i, "pretend to be"],
  [/\b(do not|don't|never) (tell|inform|mention|alert|notify|show|ask)\b[^.\n]{0,30}\b(users?|reviewers?|humans?|maintainers?|anyone|owners?|admins?)\b/i, "hide from humans"],
  [/\b(without|skip(ping)?|bypass(ing)?|disabl(e|ing)|turn(ing)? off)\b[^.\n]{0,20}\b(review|approval|security (check|screening)|screening|guards?|hooks?|quarantine|branch protection)\b/i, "skip safeguards"],
  [/<\/?\s*(system|assistant|instructions?)\s*>|\[\/?(INST|SYS)\]|<<\/?SYS>>|\b(BEGIN|END) (SYSTEM|PROMPT|INSTRUCTIONS)\b/i, "fake prompt delimiters"],
];

const SECRET_THING =
  /(\.env\b|\.npmrc\b|\.git-credentials|hosts\.yml|\bid_(rsa|ed25519|ecdsa)\b|~\/\.ssh|\.ssh\/|\b(GITHUB|GH|NPM|AWS)_[A-Z_]*(TOKEN|KEY|SECRET)\b|\bsecrets\.[A-Za-z_]+|\bprivate keys?\b|\b(your|the|repo|repository|our|admin|root|ci|github|gh|npm|aws|azure|gcp|deploy|bot|agent'?s?|claude'?s?|session)\s+(password|passwords|tokens?|credentials?|secrets?|api[ _-]?keys?|access keys?|ssh keys?|cookies?)\b|\b(api[ _-]?keys?|access[ _-]?tokens?|personal access tokens?|auth tokens?|bearer tokens?|credentials)\b)/i;
const SECRET_VERB =
  /\b(print|show|send|post|paste|commit|upload|share|reveal|dump|echo|cat|expose|output|give|include|copy|email|leak|tell|display|list|read|exfiltrate|forward|attach|log|type|get)\b/i;
const SECRET_DUMP = [
  [/\bprintenv\b|\benv\s*\||\bprocess\.env\b[^.\n]{0,20}\b(print|log|dump|send|post|show)|\bset\s*\|\s*curl|\bgh auth token\b|--show-token/i, "dump environment or token"],
];
const SECRET_VALUE = [
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{40,}/, "GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/sk-[A-Za-z0-9_-]{32,}/, "API secret key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/xox[abpors]-[A-Za-z0-9-]{10,}/, "Slack token"],
];

const UNAUTHORIZED = [
  [/\bforce[- ]?push|\bpush\s+(--force|-f)\b|--force-with-lease/i, "force push"],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bRemove-Item\b[^\n]*-Recurse/i, "recursive delete"],
  [/\b(delete|remove|drop|wipe|purge|destroy)\b[^.\n]{0,25}\b(branch(es)?|repo(sitory)?|history|tags?|releases?|all (issues|comments|files|tickets)|main)\b/i, "delete repository data"],
  [/\b(disable|remove|turn off|bypass|weaken|delete|skip)\b[^.\n]{0,25}\b(branch protection|protection rules?|required (checks?|reviews?)|codeowners|security (check|screening)|ci|guards?|quarantine)\b/i, "disable safeguards"],
  [/\b(merge|close|ship|resolve)\b[^.\n]{0,25}\b(without|before|skipping)\b[^.\n]{0,15}\b(review|approval|ci|tests?|checks?)\b/i, "merge without review"],
  [/\bself[- ]?approve|\bapprove (your|its|the bot'?s) own\b/i, "self-approval"],
  [/\b(add|invite|make|grant|give)\b[^.\n]{0,30}\b(collaborator|admin|maintainer|owner|write access|admin access|push access)\b/i, "grant access"],
  [/\b(make|set|change|switch)\b[^.\n]{0,25}\b(repo|repository)\b[^.\n]{0,15}\b(public|private|visibility|settings)\b|\btransfer (the )?(repo|repository)\b/i, "change repository settings"],
  [/\b(edit|modify|change|update|overwrite|replace|delete|remove|disable|rewrite)\b[^.\n]{0,40}(\.github\/workflows|workflow files?|\.claude\/|settings(\.local)?\.json|\bhooks?\b|ticket-guard|screen-ticket|SECURITY\.md|CODEOWNERS)/i, "change protected files"],
  [/\bpush(ing)?\b[^.\n]{0,15}\b(directly )?(to|into) main\b|\bcommit(ting)? (directly )?(to|on|into) main\b/i, "push to main"],
  [/\b(curl|wget|iwr|Invoke-WebRequest|irm)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell|iex|python3?|node)\b/i, "pipe download to shell"],
  [/\bnpm publish\b|\bgh release (create|delete)\b|\bgit tag -d\b/i, "publish or release"],
  [/\b(rotate|revoke|regenerate|reset)\b[^.\n]{0,20}\b(keys?|tokens?|secrets?|passwords?|credentials)\b/i, "change credentials"],
  [/\b(other|another|different|external) (repo|repository|repositories|org|organization)\b/i, "touch another repository"],
];

const HIDDEN = [
  [/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/, "invisible or bidi characters"],
  [/<!--[\s\S]*?-->/, "HTML comment (not visible on the page)"],
  [/style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(white|#fff\b|#ffffff|transparent))/i, "CSS-hidden text"],
  [/<\w+[^>]*\s(hidden|aria-hidden\s*=\s*["']true["'])[\s>]/i, "hidden element"],
  [/[A-Za-z0-9+/]{120,}={0,2}/, "long encoded blob"],
];

const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|ow\.ly|rb\.gy|cutt\.ly|buff\.ly|shorturl\.at|tiny\.cc|rebrand\.ly|s\.id|lnkd\.in)$/i;
const PASTE_OR_HOOK =
  /(^|\.)(pastebin\.com|hastebin\.com|ghostbin\.\w+|0x0\.st|transfer\.sh|file\.io|ngrok(-free)?\.(io|app|dev)|webhook\.site|requestbin\.\w+|pipedream\.net|interact\.sh|oast\.\w+|burpcollaborator\.net|gist\.githubusercontent\.com|raw\.githubusercontent\.com|gist\.github\.com|discord(app)?\.com|trycloudflare\.com)$/i;
const EXECUTABLE = /\.(sh|bash|ps1|psm1|bat|cmd|exe|msi|dll|scr|vbs|jar|apk|dmg|pkg|deb|rpm|py|pl|rb)(\?|#|$)/i;

// Short, safe excerpt for a public comment: no live links, no markup, no secrets, no invisible characters.
function excerpt(text, index, length) {
  const start = Math.max(0, index - 25);
  const raw = text.slice(start, index + Math.min(length, 60) + 25);
  return raw
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/:\/\//g, "[:]//")
    .replace(/\b([a-z0-9-]+)\.(com|net|org|io|sh|dev|app|site|gl|ly|co|gy|at|cc|id|in|st|pk|xyz|ru|cn)\b/gi, "$1[.]$2")
    .replace(/[<>`]/g, (c) => ({ "<": "‹", ">": "›", "`": "'" })[c])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

function linkFindings(text) {
  const out = [];
  const urls = [...text.matchAll(/\b(?:https?|ftp|file|javascript|data|vbscript):[^\s)<>"'`\]]+|\bwww\.[^\s)<>"'`\]]+/gi)];
  for (const m of urls) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    const scheme = (raw.match(/^([a-z]+):/i) || [, "https"])[1].toLowerCase();
    let host = "";
    let path = "";
    try {
      const u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
      host = u.hostname.toLowerCase();
      path = u.pathname;
    } catch {
      out.push(["unparseable link", m]);
      continue;
    }
    const target = `${host}${path}`;
    const allowed = config.allowedLinks.some((a) => target === a || target.startsWith(a.endsWith("/") ? a : `${a}/`) || target === `${a}/` || host === a);
    if (scheme !== "https" && !/^www\./i.test(raw)) out.push([`${scheme}: link`, m]);
    else if (/^\[?[0-9a-f:.]+\]?$/i.test(host) && /\d/.test(host)) out.push(["raw IP address", m]);
    else if (host.includes("xn--")) out.push(["punycode (look-alike) host", m]);
    else if (SHORTENERS.test(host)) out.push(["link shortener hides the destination", m]);
    else if (PASTE_OR_HOOK.test(host)) out.push(["paste, raw-file or webhook host", m]);
    else if (EXECUTABLE.test(path)) out.push(["link to a script or executable", m]);
    else if (!allowed) out.push(["host not on the allowlist", m]);
  }
  // [https://shown.example](https://real.example): the visible link text names a different host.
  for (const m of text.matchAll(/\[\s*(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})[^\]]*\]\(\s*https?:\/\/([^/)\s]+)/gi)) {
    if (m[1].toLowerCase() !== m[2].toLowerCase()) out.push(["link text hides the real target", m]);
  }
  return out;
}

function scanText(text, where) {
  const findings = [];
  const add = (category, rule, m, redact) =>
    findings.push({ category, rule, where, excerpt: redact ? `[redacted ${rule}]` : excerpt(text, m.index ?? 0, m[0].length) });

  for (const [re, rule] of PROMPT_INJECTION) {
    const m = text.match(re);
    if (m) add("prompt-injection", rule, m);
  }
  for (const [re, rule] of HIDDEN) {
    const m = text.match(re);
    if (m) add("hidden-content", rule, m);
  }
  for (const [rule, m] of linkFindings(text)) add("suspicious-link", rule, m);
  for (const [re, rule] of SECRET_VALUE) {
    const m = text.match(re);
    if (m) add("secret-exposure", rule, m, true);
  }
  for (const [re, rule] of SECRET_DUMP) {
    const m = text.match(re);
    if (m) add("secret-request", rule, m);
  }
  // A secret-ish noun and a "give it to me" verb in the same sentence.
  // Sentences end at . ! ? followed by whitespace (not the dot in "~/.ssh" or "hosts.yml"), or at a newline.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const thing = sentence.match(SECRET_THING);
    if (thing && SECRET_VERB.test(sentence)) {
      add("secret-request", `asks for ${thing[0].trim().toLowerCase()}`, { index: text.indexOf(sentence) + thing.index, 0: thing[0] });
      break;
    }
  }
  for (const [re, rule] of UNAUTHORIZED) {
    const m = text.match(re);
    if (m) add("unauthorized-action", rule, m);
  }
  return findings;
}

const isTrustedComment = (c) => c.trusted || BOT.test(c.author || "");

function screen(issue) {
  const labels = issue.labels || [];
  const quarantined = labels.includes(config.quarantineLabel);
  const clearedAt = !quarantined && labels.includes(config.clearedLabel) ? issue.clearedAt || null : null;
  const after = (t) => !clearedAt || (t && t > clearedAt);
  const findings = [];

  if (after(issue.lastEditedAt)) {
    findings.push(...scanText(issue.title || "", "title"));
    findings.push(...scanText(issue.body || "", "body"));
  }
  for (const c of issue.comments || []) {
    // The loop's and CI's own status comments carry a marker; they're only skipped when a trusted account wrote them.
    if (isTrustedComment(c) && MARKER.test(c.body || "")) continue;
    if (clearedAt && !after(c.createdAt) && !after(c.lastEditedAt)) continue;
    findings.push(...scanText(c.body || "", `comment by @${c.author}`));
  }

  const trusted =
    Boolean(issue.authorTrusted) || (issue.comments || []).some((c) => c.trusted && !BOT.test(c.author || "") && APPROVAL.test(c.body || ""));

  if (quarantined && !findings.length) {
    findings.push({ category: "already-quarantined", rule: `has the ${config.quarantineLabel} label`, where: "labels", excerpt: "" });
  }
  const verdict = findings.length ? "quarantine" : trusted ? "clean" : "untrusted";
  return { verdict, trusted, findings };
}

// Stable id for a set of findings, so the quarantine comment is posted once per distinct reason set.
function fingerprint(findings) {
  const keys = findings.map((f) => `${f.category}|${f.rule}|${f.where}`).sort();
  return crypto.createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 12);
}

module.exports = { screen, scanText, fingerprint, excerpt, MARKER };
