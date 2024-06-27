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

async function main() {
  const { repository, number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  const prDetails = {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };

  let diff: string | null;
  const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));

  if (eventData.action === "opened") {
    const response = await octokit.pulls.get({
      owner: prDetails.owner,
      repo: prDetails.repo,
      pull_number: prDetails.pull_number,
      mediaType: { format: "diff" },
    });
    diff = response.data as unknown as string; // Explicitly cast to string
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) => minimatch(file.to ?? "", pattern));
  });

  const comments: Array<{ title: string; body: string; path: string; line: number; improve: string }> = [];

  for (const file of filteredDiff) {
    if (file.to === "/dev/null" || !file.to) continue; // Ignore deleted files or undefined paths

    const fileContent = await octokit.repos.getContent({
      owner: prDetails.owner,
      repo: prDetails.repo,
      path: file.to,
      ref: "main",
    });

    const prompt = `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewTitle": "<review title>", "reviewComment": "<review comment>", "improveDiff": "<improve diff>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Do not generate JSON code blocks
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- Write in Japanese.

Review the following code diff in the file "${
      file.to
    }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

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
        messages: [
          {
            role: "system",
            content: prompt,
          },
        ],
      });

      const res = response.choices[0].message?.content?.trim() || "{}";

      try {
        const parsedResponse = JSON.parse(res);
        const aiResponses = parsedResponse.reviews;

        aiResponses.forEach(
          (aiResponse: { lineNumber: string; reviewTitle: string; reviewComment: string; improveDiff: string }) => {
            comments.push({
              title: aiResponse.reviewTitle,
              body: aiResponse.reviewComment,
              path: file.to!,
              line: Number(aiResponse.lineNumber),
              improve: aiResponse.improveDiff,
            });
          }
        );
      } catch (jsonError) {
        console.error("Invalid JSON response:", res);
      }
    } catch (error) {
      console.error("Error in getAIResponse:", error);
    }
  }

  if (comments.length > 0) {
    const comment = {
      owner: prDetails.owner,
      repo: prDetails.repo,
      issue_number: prDetails.pull_number,
      body:
        "# AI Reviewer\n\n" +
        comments
          .map(
            (comment) => `### ${comment.title}(${comment.path}:${comment.line})
${comment.body}
\`\`\`diff
${comment.improve}
\`\`\`
`
          )
          .join("\n"),
    };
    console.log("DEBUG", "COMMENT", comment);
    await octokit.issues.createComment(comment);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
