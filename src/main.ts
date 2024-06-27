import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
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

async function getDiff(owner: string, repo: string, pull_number: number): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return response.data as unknown as string; // Explicitly cast to string
}

async function getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });
  const content = Buffer.from((response.data as any).content || "", "base64").toString("utf8");
  return content;
}

function createPrompt(fileContent: string, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewTitle": "<review title>", "reviewComment": "<review comment>", "improveDiff": "<improve diff>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Do not generate JSON code blocks
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- Write in Japanese.

Review the following code and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Code to review:

\`\`\`
${fileContent}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewTitle: string;
  reviewComment: string;
  improveDiff: string;
}> | null> {
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
      return parsedResponse.reviews;
    } catch (jsonError) {
      console.error("Invalid JSON response:", res);
      return null;
    }
  } catch (error) {
    console.error("Error in getAIResponse:", error);
    return null;
  }
}

async function createComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ title: string; body: string; path: string; line: number; improve: string }>
): Promise<void> {
  const comment = {
    owner,
    repo,
    issue_number: pull_number,
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
  await octokit.issues.createComment(comment);
}

async function main() {
  const prDetails = await getPRDetails();
  const diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const comments: Array<{ title: string; body: string; path: string; line: number; improve: string }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    const fileContent = await getFileContent(prDetails.owner, prDetails.repo, file.to!, "main");
    const prompt = createPrompt(fileContent, prDetails);
    const aiResponse = await getAIResponse(prompt);
    if (aiResponse) {
      comments.push(
        ...aiResponse.map((response) => ({
          title: response.reviewTitle,
          body: response.reviewComment,
          path: file.to || "",
          line: Number(response.lineNumber),
          improve: response.improveDiff,
        }))
      );
    }
  }

  if (comments.length > 0) {
    await createComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
