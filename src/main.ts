import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";
import minimatch from "minimatch";

// Types
type PullRequestDetails = {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  description: string;
};

type EventData = {
  action: string;
  before?: string;
  after?: string;
};

// Constants and Configurations
const CONFIG = {
  GITHUB_TOKEN: core.getInput("GITHUB_TOKEN"),
  OPENAI_API_KEY: core.getInput("OPENAI_API_KEY"),
  OPENAI_API_MODEL: core.getInput("OPENAI_API_MODEL"),
  EXCLUDE_PATTERNS: core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim()),
  DOCS_MD: core.getInput("docs_md"),
};

const octokit = new Octokit({ auth: CONFIG.GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

// Utility Functions
async function fetchPullRequestDetails(): Promise<PullRequestDetails> {
  const { repository, number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pullNumber: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function fetchDiff(prDetails: PullRequestDetails, eventData: EventData): Promise<string | null> {
  if (eventData.action === "opened") {
    const response = await octokit.pulls.get({
      owner: prDetails.owner,
      repo: prDetails.repo,
      pull_number: prDetails.pullNumber,
      mediaType: { format: "diff" },
    });
    return response.data as unknown as string;
  } else if (eventData.action === "synchronize" && eventData.before && eventData.after) {
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

function filterDiffFiles(parsedDiff: File[], excludePatterns: string[]): File[] {
  return parsedDiff.filter((file) => !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern)));
}

async function generateAIReview(prompt: string): Promise<string> {
  const queryConfig = {
    model: CONFIG.OPENAI_API_MODEL,
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
    return response.choices[0].message?.content?.trim() ?? "";
  } catch (error) {
    console.error("Error in generateAIReview:", error);
    return "";
  }
}

async function generateFileReviews(filteredDiff: File[], docsContent: string): Promise<{ [key: string]: string }> {
  const reviewPromises = filteredDiff.map(async (file) => {
    if (file.to === "/dev/null" || !file.to) return null;
    const prompt = createReviewPrompt(file, docsContent);
    const review = await generateAIReview(prompt);
    return { [file.to]: review };
  });

  const reviews = await Promise.all(reviewPromises);
  return Object.assign({}, ...reviews.filter(Boolean));
}

function createReviewPrompt(file: File, docsContent: string): string {
  return `diffについて変更概要とコードレビューを合わせて3行以内の日本語で出力
またコメントの先頭には、以下の種別をつける (出力例: EXCELLENT: コメント)
- EXCELLENT: 素晴らしい実装や変更
- GOOD: 良い変更や修正で、全体的に問題がない
- NOTICE: 注意が必要な点があるが、致命的ではない
- IMPROVE: 改善が必要な点があり、修正を推奨
- CRITICAL: 重大な問題があり、修正が必須
\`\`\`diff
${file.chunks
  .map((chunk) =>
    chunk.changes
      .map((c) => {
        // @ts-ignore
        return `${c.ln ?? c.ln2} ${c.content}`;
      })
      .join("\n")
  )
  .join("\n")}
\`\`\`

document:
\`\`\`markdown
${docsContent}
\`\`\`
`;
}

async function fetchLatestCommitMessage(prDetails: PullRequestDetails): Promise<string> {
  const response = await octokit.pulls.listCommits({
    owner: prDetails.owner,
    repo: prDetails.repo,
    pull_number: prDetails.pullNumber,
  });
  const latestCommit = response.data[response.data.length - 1];
  return latestCommit.commit.message;
}

async function postReviewComment(prDetails: PullRequestDetails, reviews: { [key: string]: string }) {
  if (Object.keys(reviews).length > 0) {
    const commitMessage = await fetchLatestCommitMessage(prDetails);
    const comment = {
      owner: prDetails.owner,
      repo: prDetails.repo,
      issue_number: prDetails.pullNumber,
      body:
        `# ${commitMessage} - AI Reviewer\n` +
        Object.entries(reviews)
          .map(([path, body]) => `## ${path}\n${body}`)
          .join("\n"),
    };
    console.log("DEBUG", "COMMENT", comment);
    await octokit.issues.createComment(comment);
  }
}

function readDocsContent(): string {
  if (!CONFIG.DOCS_MD) return "";
  try {
    return readFileSync(CONFIG.DOCS_MD, "utf8");
  } catch (error) {
    console.error("Error reading DOCS_MD file:", error);
    return "";
  }
}

// Main Function
async function main() {
  try {
    const prDetails = await fetchPullRequestDetails();
    const eventData: EventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
    const diff = await fetchDiff(prDetails, eventData);

    if (!diff) {
      console.log("No diff found");
      return;
    }

    const parsedDiff = parseDiff(diff);
    const filteredDiff = filterDiffFiles(parsedDiff, CONFIG.EXCLUDE_PATTERNS);
    const docsContent = readDocsContent();
    const reviews = await generateFileReviews(filteredDiff, docsContent);

    await postReviewComment(prDetails, reviews);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
