#!/usr/bin/env node
// Security screening for factory tickets. The factory loop runs it before touching any issue, and
// .github/workflows/ticket-screen.yml runs it on every new or edited issue and comment.
//
//   node scripts/screen-ticket.js <issue>                       screen; quarantine automatically on any finding
//   node scripts/screen-ticket.js <issue> --quarantine "<why>"  quarantine now (e.g. after a hook blocked an action)
//   node scripts/screen-ticket.js --pr-gate <pr>                CI: fail if the PR closes a quarantined issue
//   options: --ci (exit 0 for every verdict, 1 only on errors), --dry-run (no GitHub or state writes)
//
// Quarantine = add the label, assign and @mention the reviewers with the reasons (once per reason set),
// record it in .claude/logs/quarantine.jsonl and the screening state. It never removes a label: only a
// reviewer releases a ticket, in the GitHub UI (remove `quarantine`, add `security-cleared`).
// Exit codes: 0 clean, 3 quarantined, 4 untrusted author, 1 error (callers treat errors as "stop").
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./ticket-guard/config.json");
const { screen, fingerprint, excerpt } = require("./ticket-guard/screen.js");
const state = require("../.claude/hooks/guard-state.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const CI = flag("--ci");
const DRY = flag("--dry-run");
const SOURCE = CI ? "CI" : "local";
const repo = config.repo;
const BOT = /^github-actions(\[bot\])?$/;

const gh = (ghArgs) => execFileSync("gh", ghArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const trustCache = new Map();
function isTrusted(login) {
  if (!login) return false;
  if (config.trustedAuthors.includes(login)) return true;
  if (!trustCache.has(login)) {
    let ok = false;
    try {
      ok = ["admin", "maintain", "write"].includes(gh(["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"]).trim());
    } catch {
      ok = false; // unknown means untrusted
    }
    trustCache.set(login, ok);
  }
  return trustCache.get(login);
}

function fetchIssue(n) {
  const [owner, name] = repo.split("/");
  const query = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
    number title body state url lastEditedAt author{login} labels(first:50){nodes{name}}
    comments(first:100){nodes{author{login} body createdAt lastEditedAt url}}
    timelineItems(last:100,itemTypes:[LABELED_EVENT]){nodes{... on LabeledEvent{createdAt label{name}}}}}}}`;
  const data = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${n}`]));
  const i = data.data.repository.issue;
  if (!i) throw new Error(`#${n} is not an issue in ${repo}`);
  const clearedAt = i.timelineItems.nodes.filter((e) => e.label && e.label.name === config.clearedLabel).map((e) => e.createdAt).sort().pop() || null;
  return {
    number: i.number,
    url: i.url,
    state: i.state,
    title: i.title,
    body: i.body,
    lastEditedAt: i.lastEditedAt,
    author: i.author ? i.author.login : "ghost",
    authorTrusted: isTrusted(i.author && i.author.login),
    labels: i.labels.nodes.map((l) => l.name),
    clearedAt,
    comments: i.comments.nodes.map((c) => {
      const author = c.author ? c.author.login : "ghost";
      return { author, trusted: BOT.test(author) || isTrusted(author), body: c.body, createdAt: c.createdAt, lastEditedAt: c.lastEditedAt, url: c.url };
    }),
  };
}

function ensureLabel(name, color, description) {
  try {
    gh(["label", "create", name, "--repo", repo, "--color", color, "--description", description]);
  } catch (e) {
    if (!/already exists/i.test(String(e.stderr || e.message))) throw e;
  }
}

function postComment(n, body) {
  const tmp = path.join(os.tmpdir(), `screen-ticket-${process.pid}-${n}.md`);
  fs.writeFileSync(tmp, body);
  try {
    gh(["issue", "comment", String(n), "--repo", repo, "--body-file", tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const hasOwnComment = (issue, text) => issue.comments.some((c) => c.trusted && (c.body || "").includes(text));

function quarantineComment(fp, findings) {
  const lines = findings.map((f) => `- **${f.category}**: ${f.rule} (in ${f.where})${f.excerpt ? `: \`${f.excerpt}\`` : ""}`);
  return [
    `<!-- factory-loop:quarantine fp=${fp} -->`,
    `🔒 **Quarantined by the factory's security screening.** The factory loop will not work on, resolve or close this ticket.`,
    ``,
    `${config.reviewers.map((r) => `@${r}`).join(" ")} please review.`,
    ``,
    `**Why** (${findings.length} finding${findings.length === 1 ? "" : "s"})`,
    ...lines,
    ``,
    `**To release it** (reviewers, in the GitHub UI): confirm the ticket is safe, remove the \`${config.quarantineLabel}\` label and add \`${config.clearedLabel}\`. Anything edited or added after that is screened again.`,
    ``,
    `_Recorded by \`scripts/screen-ticket.js\` (${SOURCE}). Links are defanged and excerpts shortened on purpose._`,
  ].join("\n");
}

function logQuarantine(issue, fp, findings) {
  const dir = path.join(path.resolve(__dirname, ".."), ".claude", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const entry = { at: new Date().toISOString(), issue: issue.number, source: SOURCE, fingerprint: fp, findings: findings.map(({ category, rule, where }) => ({ category, rule, where })) };
  fs.appendFileSync(path.join(dir, "quarantine.jsonl"), JSON.stringify(entry) + "\n");
}

function quarantine(issue, findings) {
  const fp = fingerprint(findings);
  if (DRY) return { fp, actions: ["(dry run) would label, alert and record"] };
  const actions = [];
  ensureLabel(config.quarantineLabel, "B60205", "Security screening: the factory loop must not touch this ticket");
  ensureLabel(config.clearedLabel, "0E8A16", "A reviewer checked a quarantined ticket and released it");
  if (!issue.labels.includes(config.quarantineLabel)) {
    gh(["issue", "edit", String(issue.number), "--repo", repo, "--add-label", config.quarantineLabel]);
    actions.push(`labeled ${config.quarantineLabel}`);
  }
  try {
    gh(["issue", "edit", String(issue.number), "--repo", repo, "--add-assignee", config.reviewers.join(",")]);
  } catch {
    // assignment is a convenience; the @mention below is the alert
  }
  if (!hasOwnComment(issue, `factory-loop:quarantine fp=${fp}`)) {
    postComment(issue.number, quarantineComment(fp, findings));
    actions.push(`alerted ${config.reviewers.map((r) => "@" + r).join(", ")}`);
  }
  logQuarantine(issue, fp, findings);
  actions.push("recorded in .claude/logs/quarantine.jsonl");
  return { fp, actions };
}

function screenIssue(n) {
  const issue = fetchIssue(n);
  const result = screen(issue);
  const forced = value("--quarantine");
  if (forced) {
    result.findings.push({ category: "blocked-action", rule: excerpt(forced, 0, 200), where: "factory loop", excerpt: "" });
    result.verdict = "quarantine";
  }

  let actions = [];
  let fp = null;
  if (result.verdict === "quarantine") ({ fp, actions } = quarantine(issue, result.findings));
  if (result.verdict === "untrusted" && !DRY && !hasOwnComment(issue, "factory-loop:untrusted")) {
    postComment(n, "<!-- factory-loop:untrusted -->\nThanks! Tickets here are worked on once a maintainer picks them up.");
    actions.push("posted the untrusted-author note");
  }
  if (!DRY) {
    state.writeScreen(n, { issue: n, verdict: result.verdict, trusted: result.trusted, fingerprint: fp, findings: result.findings, screenedAt: new Date().toISOString(), source: SOURCE });
  }

  const head = { clean: "CLEAN", untrusted: "UNTRUSTED AUTHOR", quarantine: "QUARANTINED" }[result.verdict];
  console.log(`#${n} screened: ${head}${result.findings.length ? ` (${result.findings.length} finding${result.findings.length === 1 ? "" : "s"})` : ""}`);
  for (const f of result.findings) console.log(`- ${f.category} / ${f.rule} in ${f.where}${f.excerpt ? `: ${f.excerpt}` : ""}`);
  for (const a of actions) console.log(`  done: ${a}`);
  if (result.verdict === "quarantine") console.log("STOP: do not work on, comment on, resolve or close this ticket. A reviewer decides.");
  if (result.verdict === "untrusted") console.log("STOP: author is not trusted; leave it for a maintainer.");
  return { clean: 0, quarantine: 3, untrusted: 4 }[result.verdict];
}

function prGate(pr) {
  const refs = JSON.parse(gh(["pr", "view", String(pr), "--repo", repo, "--json", "closingIssuesReferences"])).closingIssuesReferences || [];
  const bad = refs
    .map((r) => r.number)
    .filter((n) => JSON.parse(gh(["issue", "view", String(n), "--repo", repo, "--json", "labels"])).labels.some((l) => l.name === config.quarantineLabel));
  if (bad.length) {
    console.error(`PR #${pr} closes quarantined issue(s): ${bad.map((n) => "#" + n).join(", ")}. A reviewer must release them first.`);
    return 1;
  }
  console.log(`PR #${pr}: no quarantined issues (${refs.length ? refs.map((r) => "#" + r.number).join(", ") : "closes none"})`);
  return 0;
}

function main() {
  const pr = value("--pr-gate");
  if (pr) return prGate(pr);
  const n = args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== "--quarantine");
  if (!n) {
    console.error("usage: screen-ticket.js <issue> [--quarantine <reason>] [--ci] [--dry-run] | --pr-gate <pr>");
    return 1;
  }
  const code = screenIssue(Number(n));
  return CI ? 0 : code;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`screen-ticket failed: ${String(e.stderr || e.message).trim()}`);
  console.error("STOP: screening could not complete, so treat the ticket as unsafe until it does.");
  process.exitCode = 1;
}
