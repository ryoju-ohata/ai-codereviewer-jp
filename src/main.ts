import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Change, Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

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
    return response.data as unknown as string; // Explicitly cast to string
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;
    const response = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });
    return String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return null;
  }
}

function filterDiff(parsedDiff: File[], excludePatterns: string[]): File[] {
  return parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern));
  });
}

async function generateComments(filteredDiff: File[], prDetails: any): Promise<{ [key: string]: string }> {
  const comments: { [key: string]: string } = {};
  for (const file of filteredDiff) {
    if (file.to === "/dev/null" || !file.to) continue; // Ignore deleted files or undefined paths

    const prompt = `diffについて日本語で要約と改善点を出力
\`\`\`diff
${file.chunks
  // @ts-ignore
  .map((chunk: Chunk) => chunk.changes.map((c: Change) => `${c.ln ? c.ln : c.ln2} ${c.content}`).join("\n"))
  .join("\n")}
\`\`\`
`;

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

      const res = response.choices[0].message?.content?.trim() || "{}";
      comments[file.to!] = res;
    } catch (error) {
      console.error("Error in getAIResponse:", error);
    }
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
        `# AI Reviewer
## Summary
` +
        Object.entries(comments)
          .map(([path, body]) => `### ${path}\n- ${body}`)
          .join("\n"),
    };
    console.log("DEBUG", "COMMENT", comment);
    await octokit.issues.createComment(comment);
  }
}

async function main() {
  const prDetails = await getPullRequestDetails();
  const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const diff = await getDiff(prDetails, eventData);

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());
  const filteredDiff = filterDiff(parsedDiff, excludePatterns);
  const comments = await generateComments(filteredDiff, prDetails);
  await postComment(prDetails, comments);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
