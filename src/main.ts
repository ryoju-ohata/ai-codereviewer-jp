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

async function generateFileReviews(filteredDiff: File[]): Promise<{ [key: string]: string }> {
  const reviewPromises = filteredDiff.map(async (file) => {
    if (file.to === "/dev/null" || !file.to) return null;
    const prompt = createReviewPrompt(file);
    const review = await generateAIReview(prompt);
    return { [file.to]: review };
  });

  const reviews = await Promise.all(reviewPromises);
  return Object.assign({}, ...reviews.filter(Boolean));
}

function createReviewPrompt(file: File): string {
  return `以下のdiffに基づいて、変更の概要とコードレビューを日本語で提供してください。回答は3〜5文で簡潔にまとめ、以下の評価カテゴリを使用してください：

- 🌟 EXCELLENT: 素晴らしい実装、最適化、セキュリティ向上、またはパフォーマンス改善
- 👍 GOOD: 適切な変更や修正で、全体的に問題がない
- 📝 NOTICE: 軽微な改善の余地がある、または注意が必要な点
- 🛠️ IMPROVE: 改善が推奨される重要な点
- 🚨 CRITICAL: 即時の対応が必要な重大な問題

各コメントの冒頭に適切なカテゴリと絵文字を付けてください。変更の影響、コードの品質、およびプロジェクトのベストプラクティスを考慮してレビューを行ってください。

ファイル: ${file.to}

変更内容:
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

上記の情報を基に、変更の質と影響を評価し、具体的で建設的なフィードバックを提供してください。

出力例：
🌟 EXCELLENT: このコード変更は、パフォーマンスを大幅に向上させる非常に効果的な最適化を実装しています。非同期処理の導入により、アプリケーションの応答性が向上し、ユーザーエクスペリエンスが改善されます。`;
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
    const reviews = await generateFileReviews(filteredDiff);

    await postReviewComment(prDetails, reviews);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
