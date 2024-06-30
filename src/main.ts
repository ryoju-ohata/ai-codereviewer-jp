import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Change, Chunk, File } from "parse-diff";
import minimatch from "minimatch";

// Constants and Configurations
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const SLACK_WEBHOOK_URL = core.getInput("SLACK_WEBHOOK_URL");
const EXCLUDE_PATTERNS: string[] = core
  .getInput("exclude")
  .split(",")
  .map((s) => s.trim());
const DOCS_MD = core.getInput("docs_md");

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Utility Functions
async function getPullRequestDetails() {
  const { repository, number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(prDetails: any, eventData: any): Promise<string | null> {
  if (eventData.action === "opened") {
    const response = await octokit.pulls.get({
      owner: prDetails.owner,
      repo: prDetails.repo,
      pull_number: prDetails.pull_number,
      mediaType: { format: "diff" },
    });
    return response.data as unknown as string;
  } else if (eventData.action === "synchronize") {
    const response = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: eventData.before,
      head: eventData.after,
    });
    return String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return null;
  }
}

function filterDiff(parsedDiff: File[], excludePatterns: string[]): File[] {
  return parsedDiff.filter((file) => !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern)));
}

async function generateAIResponse(prompt: string): Promise<string> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };
  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [{ role: "system", content: prompt }],
    });
    return response.choices[0].message?.content?.trim() || "";
  } catch (error) {
    console.error("Error in generateAIResponse:", error);
    return "";
  }
}

async function generateComments(filteredDiff: File[], prDetails: any): Promise<{ [key: string]: string }> {
  const comments: { [key: string]: string } = {};
  let docsContent = "";

  if (DOCS_MD) {
    try {
      console.log("DEBUG", "DOCS_MD", DOCS_MD);
      docsContent = readFileSync(DOCS_MD, "utf8");
    } catch (error) {
      console.error("Error reading DOCS_MD file:", error);
    }
  }

  for (const file of filteredDiff) {
    if (file.to === "/dev/null" || !file.to) continue;
    const prompt = `diffについて以下の内容を日本語で出力

- 1. 変更点
- 2. テスト項目 / 変更確認方法
- 3. 変数名、関数名、代替機能、代替メソッドなど修正提案

\`\`\`diff
${file.chunks
  // @ts-ignore
  .map((chunk: Chunk) => chunk.changes.map((c: Change) => `${c.ln ? c.ln : c.ln2} ${c.content}`).join("\n"))
  .join("\n")}
\`\`\`

document:
\`\`\`markdown
${docsContent}
\`\`\`
`;
    comments[file.to] = await generateAIResponse(prompt);
  }
  return comments;
}

async function postComment(prDetails: any, comments: { [key: string]: string }) {
  if (Object.keys(comments).length > 0) {
    const comment = {
      owner: prDetails.owner,
      repo: prDetails.repo,
      issue_number: prDetails.pull_number,
      body:
        `# Report - AI Reviewer\n` +
        Object.entries(comments)
          .map(([path, body]) => `## ${path}\n${body}`)
          .join("\n"),
    };
    console.log("DEBUG", "COMMENT", comment);
    await octokit.issues.createComment(comment);
  }
}

async function postSlackAllSummary(comments: { [key: string]: string }) {
  const allSummary = await generateAIResponse(
    `Slackコメントのための全体の要約を出力\n` +
      Object.entries(comments)
        .map(([path, body]) => `## ${path}\n${body}`)
        .join("\n")
  );
  console.log("DEBUG", "ALL_SUMMARY", allSummary);
}

// Main Function
async function main() {
  try {
    const prDetails = await getPullRequestDetails();
    const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
    const diff = await getDiff(prDetails, eventData);

    if (!diff) {
      console.log("No diff found");
      return;
    }

    const parsedDiff = parseDiff(diff);
    const filteredDiff = filterDiff(parsedDiff, EXCLUDE_PATTERNS);
    const comments = await generateComments(filteredDiff, prDetails);
    await postComment(prDetails, comments);

    if (SLACK_WEBHOOK_URL) {
      postSlackAllSummary(comments);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
