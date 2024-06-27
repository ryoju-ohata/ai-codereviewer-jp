"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs_1 = require("fs");
var core = require("@actions/core");
var openai_1 = require("openai");
var rest_1 = require("@octokit/rest");
var parse_diff_1 = require("parse-diff");
var minimatch_1 = require("minimatch");
var GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
var OPENAI_API_KEY = core.getInput("OPENAI_API_KEY");
var OPENAI_API_MODEL = core.getInput("OPENAI_API_MODEL");
var octokit = new rest_1.Octokit({ auth: GITHUB_TOKEN });
var openai = new openai_1.default({
    apiKey: OPENAI_API_KEY,
});
function main() {
    var _a, _b, _c, _d, _e;
    return __awaiter(this, void 0, void 0, function () {
        var _f, repository, number, prResponse, prDetails, diff, eventData, response, newBaseSha, newHeadSha, response, parsedDiff, excludePatterns, filteredDiff, comments, _loop_1, _i, filteredDiff_1, file, comment;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    _f = JSON.parse((0, fs_1.readFileSync)(process.env.GITHUB_EVENT_PATH || "", "utf8")), repository = _f.repository, number = _f.number;
                    return [4 /*yield*/, octokit.pulls.get({
                            owner: repository.owner.login,
                            repo: repository.name,
                            pull_number: number,
                        })];
                case 1:
                    prResponse = _g.sent();
                    prDetails = {
                        owner: repository.owner.login,
                        repo: repository.name,
                        pull_number: number,
                        title: (_a = prResponse.data.title) !== null && _a !== void 0 ? _a : "",
                        description: (_b = prResponse.data.body) !== null && _b !== void 0 ? _b : "",
                    };
                    eventData = JSON.parse((0, fs_1.readFileSync)((_c = process.env.GITHUB_EVENT_PATH) !== null && _c !== void 0 ? _c : "", "utf8"));
                    if (!(eventData.action === "opened")) return [3 /*break*/, 3];
                    return [4 /*yield*/, octokit.pulls.get({
                            owner: prDetails.owner,
                            repo: prDetails.repo,
                            pull_number: prDetails.pull_number,
                            mediaType: { format: "diff" },
                        })];
                case 2:
                    response = _g.sent();
                    diff = response.data; // Explicitly cast to string
                    return [3 /*break*/, 6];
                case 3:
                    if (!(eventData.action === "synchronize")) return [3 /*break*/, 5];
                    newBaseSha = eventData.before;
                    newHeadSha = eventData.after;
                    return [4 /*yield*/, octokit.repos.compareCommits({
                            headers: {
                                accept: "application/vnd.github.v3.diff",
                            },
                            owner: prDetails.owner,
                            repo: prDetails.repo,
                            base: newBaseSha,
                            head: newHeadSha,
                        })];
                case 4:
                    response = _g.sent();
                    diff = String(response.data);
                    return [3 /*break*/, 6];
                case 5:
                    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
                    return [2 /*return*/];
                case 6:
                    if (!diff) {
                        console.log("No diff found");
                        return [2 /*return*/];
                    }
                    parsedDiff = (0, parse_diff_1.default)(diff);
                    excludePatterns = core
                        .getInput("exclude")
                        .split(",")
                        .map(function (s) { return s.trim(); });
                    filteredDiff = parsedDiff.filter(function (file) {
                        return !excludePatterns.some(function (pattern) { var _a; return (0, minimatch_1.default)((_a = file.to) !== null && _a !== void 0 ? _a : "", pattern); });
                    });
                    comments = [];
                    _loop_1 = function (file) {
                        var fileContent, prompt_1, queryConfig, response, res, parsedResponse, aiResponses, error_1;
                        return __generator(this, function (_h) {
                            switch (_h.label) {
                                case 0:
                                    if (file.to === "/dev/null" || !file.to)
                                        return [2 /*return*/, "continue"]; // Ignore deleted files or undefined paths
                                    return [4 /*yield*/, octokit.repos.getContent({
                                            owner: prDetails.owner,
                                            repo: prDetails.repo,
                                            path: file.to,
                                            ref: "main",
                                        })];
                                case 1:
                                    fileContent = _h.sent();
                                    prompt_1 = "Your task is to review pull requests. Instructions:\n- Provide the response in following JSON format:  {\"reviews\": [{\"lineNumber\":  <line_number>, \"reviewTitle\": \"<review title>\", \"reviewComment\": \"<review comment>\", \"improveDiff\": \"<improve diff>\"}]}\n- Do not give positive comments or compliments.\n- Provide comments and suggestions ONLY if there is something to improve, otherwise \"reviews\" should be an empty array.\n- Write the comment in GitHub Markdown format.\n- Do not generate JSON code blocks\n- Use the given description only for the overall context and only comment the code.\n- IMPORTANT: NEVER suggest adding comments to the code.\n- Write in Japanese.\n\nReview the following code diff in the file \"".concat(file.to, "\" and take the pull request title and description into account when writing the response.\n  \nPull request title: ").concat(prDetails.title, "\nPull request description:\n\n---\n").concat(prDetails.description, "\n---\n\nGit diff to review:\n\n```diff\n").concat(file.chunks
                                        .map(function (chunk) { return chunk.changes.map(function (c) { return "".concat(c.ln ? c.ln : c.ln2, " ").concat(c.content); }).join("\n"); })
                                        .join("\n"), "\n```\n");
                                    queryConfig = {
                                        model: OPENAI_API_MODEL,
                                        temperature: 0.2,
                                        max_tokens: 700,
                                        top_p: 1,
                                        frequency_penalty: 0,
                                        presence_penalty: 0,
                                    };
                                    _h.label = 2;
                                case 2:
                                    _h.trys.push([2, 4, , 5]);
                                    return [4 /*yield*/, openai.chat.completions.create(__assign(__assign({}, queryConfig), { messages: [
                                                {
                                                    role: "system",
                                                    content: prompt_1,
                                                },
                                            ] }))];
                                case 3:
                                    response = _h.sent();
                                    res = ((_e = (_d = response.choices[0].message) === null || _d === void 0 ? void 0 : _d.content) === null || _e === void 0 ? void 0 : _e.trim()) || "{}";
                                    try {
                                        parsedResponse = JSON.parse(res);
                                        aiResponses = parsedResponse.reviews;
                                        aiResponses.forEach(function (aiResponse) {
                                            comments.push({
                                                title: aiResponse.reviewTitle,
                                                body: aiResponse.reviewComment,
                                                path: file.to,
                                                line: Number(aiResponse.lineNumber),
                                                improve: aiResponse.improveDiff,
                                            });
                                        });
                                    }
                                    catch (jsonError) {
                                        console.error("Invalid JSON response:", res);
                                    }
                                    return [3 /*break*/, 5];
                                case 4:
                                    error_1 = _h.sent();
                                    console.error("Error in getAIResponse:", error_1);
                                    return [3 /*break*/, 5];
                                case 5: return [2 /*return*/];
                            }
                        });
                    };
                    _i = 0, filteredDiff_1 = filteredDiff;
                    _g.label = 7;
                case 7:
                    if (!(_i < filteredDiff_1.length)) return [3 /*break*/, 10];
                    file = filteredDiff_1[_i];
                    return [5 /*yield**/, _loop_1(file)];
                case 8:
                    _g.sent();
                    _g.label = 9;
                case 9:
                    _i++;
                    return [3 /*break*/, 7];
                case 10:
                    if (!(comments.length > 0)) return [3 /*break*/, 12];
                    comment = {
                        owner: prDetails.owner,
                        repo: prDetails.repo,
                        issue_number: prDetails.pull_number,
                        body: "# AI Reviewer\n\n" +
                            comments
                                .map(function (comment) { return "### ".concat(comment.title, "(").concat(comment.path, ":").concat(comment.line, ")\n").concat(comment.body, "\n```diff\n").concat(comment.improve, "\n```\n"); })
                                .join("\n"),
                    };
                    console.log("DEBUG", "COMMENT", comment);
                    return [4 /*yield*/, octokit.issues.createComment(comment)];
                case 11:
                    _g.sent();
                    _g.label = 12;
                case 12: return [2 /*return*/];
            }
        });
    });
}
main().catch(function (error) {
    console.error("Error:", error);
    process.exit(1);
});
