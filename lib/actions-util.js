"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.printDebugLogs = exports.isAnalyzingDefaultBranch = exports.getRelativeScriptPath = exports.isRunningLocalAction = exports.workflowEventName = exports.sendStatusReport = exports.createStatusReportBase = exports.getActionVersion = exports.getActionsStatus = exports.getRef = exports.computeAutomationID = exports.getAutomationID = exports.getAnalysisKey = exports.determineMergeBaseCommitOid = exports.getCommitOid = exports.getTemporaryDirectory = exports.getOptionalInput = exports.getRequiredInput = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const core = __importStar(require("@actions/core"));
const toolrunner = __importStar(require("@actions/exec/lib/toolrunner"));
const safeWhich = __importStar(require("@chrisgavin/safe-which"));
const api = __importStar(require("./api-client"));
const sharedEnv = __importStar(require("./shared-environment"));
const util_1 = require("./util");
const workflow_1 = require("./workflow");
// eslint-disable-next-line import/no-commonjs
const pkg = require("../package.json");
/**
 * Wrapper around core.getInput for inputs that always have a value.
 * Also see getOptionalInput.
 *
 * This allows us to get stronger type checking of required/optional inputs.
 */
function getRequiredInput(name) {
    return core.getInput(name, { required: true });
}
exports.getRequiredInput = getRequiredInput;
/**
 * Wrapper around core.getInput that converts empty inputs to undefined.
 * Also see getRequiredInput.
 *
 * This allows us to get stronger type checking of required/optional inputs.
 */
const getOptionalInput = function (name) {
    const value = core.getInput(name);
    return value.length > 0 ? value : undefined;
};
exports.getOptionalInput = getOptionalInput;
function getTemporaryDirectory() {
    const value = process.env["CODEQL_ACTION_TEMP"];
    return value !== undefined && value !== ""
        ? value
        : (0, util_1.getRequiredEnvParam)("RUNNER_TEMP");
}
exports.getTemporaryDirectory = getTemporaryDirectory;
/**
 * Gets the SHA of the commit that is currently checked out.
 */
const getCommitOid = async function (checkoutPath, ref = "HEAD") {
    // Try to use git to get the current commit SHA. If that fails then
    // log but otherwise silently fall back to using the SHA from the environment.
    // The only time these two values will differ is during analysis of a PR when
    // the workflow has changed the current commit to the head commit instead of
    // the merge commit, which must mean that git is available.
    // Even if this does go wrong, it's not a huge problem for the alerts to
    // reported on the merge commit.
    try {
        let commitOid = "";
        await new toolrunner.ToolRunner(await safeWhich.safeWhich("git"), ["rev-parse", ref], {
            silent: true,
            listeners: {
                stdout: (data) => {
                    commitOid += data.toString();
                },
                stderr: (data) => {
                    process.stderr.write(data);
                },
            },
            cwd: checkoutPath,
        }).exec();
        return commitOid.trim();
    }
    catch (e) {
        core.info("Could not determine current commit SHA using git. Continuing with data from user input or environment.");
        core.debug(`Reason: ${e.message}`);
        core.debug(e.stack || "NO STACK");
        return (0, exports.getOptionalInput)("sha") || (0, util_1.getRequiredEnvParam)("GITHUB_SHA");
    }
};
exports.getCommitOid = getCommitOid;
/**
 * If the action was triggered by a pull request, determine the commit sha of the merge base.
 * Returns undefined if run by other triggers or the merge base cannot be determined.
 */
const determineMergeBaseCommitOid = async function () {
    if (workflowEventName() !== "pull_request") {
        return undefined;
    }
    const mergeSha = (0, util_1.getRequiredEnvParam)("GITHUB_SHA");
    const checkoutPath = (0, exports.getOptionalInput)("checkout_path");
    try {
        let commitOid = "";
        let baseOid = "";
        let headOid = "";
        await new toolrunner.ToolRunner(await safeWhich.safeWhich("git"), ["show", "-s", "--format=raw", mergeSha], {
            silent: true,
            listeners: {
                stdline: (data) => {
                    if (data.startsWith("commit ") && commitOid === "") {
                        commitOid = data.substring(7);
                    }
                    else if (data.startsWith("parent ")) {
                        if (baseOid === "") {
                            baseOid = data.substring(7);
                        }
                        else if (headOid === "") {
                            headOid = data.substring(7);
                        }
                    }
                },
                stderr: (data) => {
                    process.stderr.write(data);
                },
            },
            cwd: checkoutPath,
        }).exec();
        // Let's confirm our assumptions: We had a merge commit and the parsed parent data looks correct
        if (commitOid === mergeSha &&
            headOid.length === 40 &&
            baseOid.length === 40) {
            return baseOid;
        }
        return undefined;
    }
    catch (e) {
        core.info(`Failed to call git to determine merge base. Continuing with data from environment: ${e}`);
        core.info(e.stack || "NO STACK");
        return undefined;
    }
};
exports.determineMergeBaseCommitOid = determineMergeBaseCommitOid;
/**
 * Get the analysis key parameter for the current job.
 *
 * This will combine the workflow path and current job name.
 * Computing this the first time requires making requests to
 * the github API, but after that the result will be cached.
 */
async function getAnalysisKey() {
    const analysisKeyEnvVar = "CODEQL_ACTION_ANALYSIS_KEY";
    let analysisKey = process.env[analysisKeyEnvVar];
    if (analysisKey !== undefined) {
        return analysisKey;
    }
    const workflowPath = await (0, workflow_1.getWorkflowPath)();
    const jobName = (0, util_1.getRequiredEnvParam)("GITHUB_JOB");
    analysisKey = `${workflowPath}:${jobName}`;
    core.exportVariable(analysisKeyEnvVar, analysisKey);
    return analysisKey;
}
exports.getAnalysisKey = getAnalysisKey;
async function getAutomationID() {
    const analysis_key = await getAnalysisKey();
    const environment = getRequiredInput("matrix");
    return computeAutomationID(analysis_key, environment);
}
exports.getAutomationID = getAutomationID;
function computeAutomationID(analysis_key, environment) {
    let automationID = `${analysis_key}/`;
    const matrix = (0, util_1.parseMatrixInput)(environment);
    if (matrix !== undefined) {
        // the id has to be deterministic so we sort the fields
        for (const entry of Object.entries(matrix).sort()) {
            if (typeof entry[1] === "string") {
                automationID += `${entry[0]}:${entry[1]}/`;
            }
            else {
                // In code scanning we just handle the string values,
                // the rest get converted to the empty string
                automationID += `${entry[0]}:/`;
            }
        }
    }
    return automationID;
}
exports.computeAutomationID = computeAutomationID;
/**
 * Get the ref currently being analyzed.
 */
async function getRef() {
    // Will be in the form "refs/heads/master" on a push event
    // or in the form "refs/pull/N/merge" on a pull_request event
    const refInput = (0, exports.getOptionalInput)("ref");
    const shaInput = (0, exports.getOptionalInput)("sha");
    const checkoutPath = (0, exports.getOptionalInput)("checkout_path") ||
        (0, exports.getOptionalInput)("source-root") ||
        (0, util_1.getRequiredEnvParam)("GITHUB_WORKSPACE");
    const hasRefInput = !!refInput;
    const hasShaInput = !!shaInput;
    // If one of 'ref' or 'sha' are provided, both are required
    if ((hasRefInput || hasShaInput) && !(hasRefInput && hasShaInput)) {
        throw new Error("Both 'ref' and 'sha' are required if one of them is provided.");
    }
    const ref = refInput || getRefFromEnv();
    const sha = shaInput || (0, util_1.getRequiredEnvParam)("GITHUB_SHA");
    // If the ref is a user-provided input, we have to skip logic
    // and assume that it is really where they want to upload the results.
    if (refInput) {
        return refInput;
    }
    // For pull request refs we want to detect whether the workflow
    // has run `git checkout HEAD^2` to analyze the 'head' ref rather
    // than the 'merge' ref. If so, we want to convert the ref that
    // we report back.
    const pull_ref_regex = /refs\/pull\/(\d+)\/merge/;
    if (!pull_ref_regex.test(ref)) {
        return ref;
    }
    const head = await (0, exports.getCommitOid)(checkoutPath, "HEAD");
    // in actions/checkout@v2+ we can check if git rev-parse HEAD == GITHUB_SHA
    // in actions/checkout@v1 this may not be true as it checks out the repository
    // using GITHUB_REF. There is a subtle race condition where
    // git rev-parse GITHUB_REF != GITHUB_SHA, so we must check
    // git rev-parse GITHUB_REF == git rev-parse HEAD instead.
    const hasChangedRef = sha !== head &&
        (await (0, exports.getCommitOid)(checkoutPath, ref.replace(/^refs\/pull\//, "refs/remotes/pull/"))) !== head;
    if (hasChangedRef) {
        const newRef = ref.replace(pull_ref_regex, "refs/pull/$1/head");
        core.debug(`No longer on merge commit, rewriting ref from ${ref} to ${newRef}.`);
        return newRef;
    }
    else {
        return ref;
    }
}
exports.getRef = getRef;
function getRefFromEnv() {
    // To workaround a limitation of Actions dynamic workflows not setting
    // the GITHUB_REF in some cases, we accept also the ref within the
    // CODE_SCANNING_REF variable. When possible, however, we prefer to use
    // the GITHUB_REF as that is a protected variable and cannot be overwritten.
    let refEnv;
    try {
        refEnv = (0, util_1.getRequiredEnvParam)("GITHUB_REF");
    }
    catch (e) {
        // If the GITHUB_REF is not set, we try to rescue by getting the
        // CODE_SCANNING_REF.
        const maybeRef = process.env["CODE_SCANNING_REF"];
        if (maybeRef === undefined || maybeRef.length === 0) {
            throw e;
        }
        refEnv = maybeRef;
    }
    return refEnv;
}
function getActionsStatus(error, otherFailureCause) {
    if (error || otherFailureCause) {
        return error instanceof util_1.UserError ? "user-error" : "failure";
    }
    else {
        return "success";
    }
}
exports.getActionsStatus = getActionsStatus;
function getActionVersion() {
    return pkg.version;
}
exports.getActionVersion = getActionVersion;
/**
 * Compose a StatusReport.
 *
 * @param actionName The name of the action, e.g. 'init', 'finish', 'upload-sarif'
 * @param status The status. Must be 'success', 'failure', or 'starting'
 * @param startedAt The time this action started executing.
 * @param cause  Cause of failure (only supply if status is 'failure')
 * @param exception Exception (only supply if status is 'failure')
 */
async function createStatusReportBase(actionName, status, actionStartedAt, cause, exception) {
    const commitOid = (0, exports.getOptionalInput)("sha") || process.env["GITHUB_SHA"] || "";
    const ref = await getRef();
    const workflowRunIDStr = process.env["GITHUB_RUN_ID"];
    let workflowRunID = -1;
    if (workflowRunIDStr) {
        workflowRunID = parseInt(workflowRunIDStr, 10);
    }
    const workflowName = process.env["GITHUB_WORKFLOW"] || "";
    const jobName = process.env["GITHUB_JOB"] || "";
    const analysis_key = await getAnalysisKey();
    let workflowStartedAt = process.env[sharedEnv.CODEQL_WORKFLOW_STARTED_AT];
    if (workflowStartedAt === undefined) {
        workflowStartedAt = actionStartedAt.toISOString();
        core.exportVariable(sharedEnv.CODEQL_WORKFLOW_STARTED_AT, workflowStartedAt);
    }
    const runnerOs = (0, util_1.getRequiredEnvParam)("RUNNER_OS");
    const codeQlCliVersion = (0, util_1.getCachedCodeQlVersion)();
    const actionRef = process.env["GITHUB_ACTION_REF"];
    const testingEnvironment = process.env[sharedEnv.CODEQL_ACTION_TESTING_ENVIRONMENT] || "";
    // re-export the testing environment variable so that it is available to subsequent steps,
    // even if it was only set for this step
    if (testingEnvironment !== "") {
        core.exportVariable(sharedEnv.CODEQL_ACTION_TESTING_ENVIRONMENT, testingEnvironment);
    }
    const statusReport = {
        workflow_run_id: workflowRunID,
        workflow_name: workflowName,
        job_name: jobName,
        analysis_key,
        commit_oid: commitOid,
        ref,
        action_name: actionName,
        action_ref: actionRef,
        action_oid: "unknown",
        started_at: workflowStartedAt,
        action_started_at: actionStartedAt.toISOString(),
        status,
        testing_environment: testingEnvironment,
        runner_os: runnerOs,
        action_version: getActionVersion(),
    };
    // Add optional parameters
    if (cause) {
        statusReport.cause = cause;
    }
    if (exception) {
        statusReport.exception = exception;
    }
    if (status === "success" ||
        status === "failure" ||
        status === "aborted" ||
        status === "user-error") {
        statusReport.completed_at = new Date().toISOString();
    }
    const matrix = getRequiredInput("matrix");
    if (matrix) {
        statusReport.matrix_vars = matrix;
    }
    if ("RUNNER_ARCH" in process.env) {
        // RUNNER_ARCH is available only in GHES 3.4 and later
        // Values other than X86, X64, ARM, or ARM64 are discarded server side
        statusReport.runner_arch = process.env["RUNNER_ARCH"];
    }
    if (runnerOs === "Windows" || runnerOs === "macOS") {
        statusReport.runner_os_release = os.release();
    }
    if (codeQlCliVersion !== undefined) {
        statusReport.codeql_version = codeQlCliVersion;
    }
    return statusReport;
}
exports.createStatusReportBase = createStatusReportBase;
const GENERIC_403_MSG = "The repo on which this action is running is not opted-in to CodeQL code scanning.";
const GENERIC_404_MSG = "Not authorized to use the CodeQL code scanning feature on this repo.";
const OUT_OF_DATE_MSG = "CodeQL Action is out-of-date. Please upgrade to the latest version of codeql-action.";
const INCOMPATIBLE_MSG = "CodeQL Action version is incompatible with the code scanning endpoint. Please update to a compatible version of codeql-action.";
/**
 * Send a status report to the code_scanning/analysis/status endpoint.
 *
 * Optionally checks the response from the API endpoint and sets the action
 * as failed if the status report failed. This is only expected to be used
 * when sending a 'starting' report.
 *
 * Returns whether sending the status report was successful of not.
 */
async function sendStatusReport(statusReport) {
    const statusReportJSON = JSON.stringify(statusReport);
    core.debug(`Sending status report: ${statusReportJSON}`);
    // If in test mode we don't want to upload the results
    if ((0, util_1.isInTestMode)()) {
        core.debug("In test mode. Status reports are not uploaded.");
        return true;
    }
    const nwo = (0, util_1.getRequiredEnvParam)("GITHUB_REPOSITORY");
    const [owner, repo] = nwo.split("/");
    const client = api.getApiClient();
    try {
        await client.request("PUT /repos/:owner/:repo/code-scanning/analysis/status", {
            owner,
            repo,
            data: statusReportJSON,
        });
        return true;
    }
    catch (e) {
        console.log(e);
        if ((0, util_1.isHTTPError)(e)) {
            switch (e.status) {
                case 403:
                    if (workflowIsTriggeredByPushEvent() && isDependabotActor()) {
                        core.setFailed('Workflows triggered by Dependabot on the "push" event run with read-only access. ' +
                            "Uploading Code Scanning results requires write access. " +
                            'To use Code Scanning with Dependabot, please ensure you are using the "pull_request" event for this workflow and avoid triggering on the "push" event for Dependabot branches. ' +
                            "See https://docs.github.com/en/code-security/secure-coding/configuring-code-scanning#scanning-on-push for more information on how to configure these events.");
                    }
                    else {
                        core.setFailed(e.message || GENERIC_403_MSG);
                    }
                    return false;
                case 404:
                    core.setFailed(GENERIC_404_MSG);
                    return false;
                case 422:
                    // schema incompatibility when reporting status
                    // this means that this action version is no longer compatible with the API
                    // we still want to continue as it is likely the analysis endpoint will work
                    if ((0, util_1.getRequiredEnvParam)("GITHUB_SERVER_URL") !== util_1.GITHUB_DOTCOM_URL) {
                        core.debug(INCOMPATIBLE_MSG);
                    }
                    else {
                        core.debug(OUT_OF_DATE_MSG);
                    }
                    return true;
            }
        }
        // something else has gone wrong and the request/response will be logged by octokit
        // it's possible this is a transient error and we should continue scanning
        core.error("An unexpected error occurred when sending code scanning status report.");
        return true;
    }
}
exports.sendStatusReport = sendStatusReport;
function workflowEventName() {
    // If the original event is dynamic CODESCANNING_EVENT_NAME will contain the right info (push/pull_request)
    if (process.env["GITHUB_EVENT_NAME"] === "dynamic") {
        const value = process.env["CODESCANNING_EVENT_NAME"];
        if (value === undefined || value.length === 0) {
            return process.env["GITHUB_EVENT_NAME"];
        }
        return value;
    }
    return process.env["GITHUB_EVENT_NAME"];
}
exports.workflowEventName = workflowEventName;
// Was the workflow run triggered by a `push` event, for example as opposed to a `pull_request` event.
function workflowIsTriggeredByPushEvent() {
    return workflowEventName() === "push";
}
// Is dependabot the actor that triggered the current workflow run.
function isDependabotActor() {
    return process.env["GITHUB_ACTOR"] === "dependabot[bot]";
}
// Is the current action executing a local copy (i.e. we're running a workflow on the codeql-action repo itself)
// as opposed to running a remote action (i.e. when another repo references us)
function isRunningLocalAction() {
    const relativeScriptPath = getRelativeScriptPath();
    return (relativeScriptPath.startsWith("..") || path.isAbsolute(relativeScriptPath));
}
exports.isRunningLocalAction = isRunningLocalAction;
// Get the location where the action is running from.
// This can be used to get the actions name or tell if we're running a local action.
function getRelativeScriptPath() {
    const runnerTemp = (0, util_1.getRequiredEnvParam)("RUNNER_TEMP");
    const actionsDirectory = path.join(path.dirname(runnerTemp), "_actions");
    return path.relative(actionsDirectory, __filename);
}
exports.getRelativeScriptPath = getRelativeScriptPath;
// Reads the contents of GITHUB_EVENT_PATH as a JSON object
function getWorkflowEvent() {
    const eventJsonFile = (0, util_1.getRequiredEnvParam)("GITHUB_EVENT_PATH");
    try {
        return JSON.parse(fs.readFileSync(eventJsonFile, "utf-8"));
    }
    catch (e) {
        throw new Error(`Unable to read workflow event JSON from ${eventJsonFile}: ${e}`);
    }
}
function removeRefsHeadsPrefix(ref) {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
// Is the version of the repository we are currently analyzing from the default branch,
// or alternatively from another branch or a pull request.
async function isAnalyzingDefaultBranch() {
    // Get the current ref and trim and refs/heads/ prefix
    let currentRef = await getRef();
    currentRef = removeRefsHeadsPrefix(currentRef);
    const event = getWorkflowEvent();
    let defaultBranch = event?.repository?.default_branch;
    if (process.env.GITHUB_EVENT_NAME === "schedule") {
        defaultBranch = removeRefsHeadsPrefix((0, util_1.getRequiredEnvParam)("GITHUB_REF"));
    }
    return currentRef === defaultBranch;
}
exports.isAnalyzingDefaultBranch = isAnalyzingDefaultBranch;
async function printDebugLogs(config) {
    for (const language of config.languages) {
        const databaseDirectory = (0, util_1.getCodeQLDatabasePath)(config, language);
        const logsDirectory = path.join(databaseDirectory, "log");
        if (!(0, util_1.doesDirectoryExist)(logsDirectory)) {
            core.info(`Directory ${logsDirectory} does not exist.`);
            continue; // Skip this language database.
        }
        const walkLogFiles = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            if (entries.length === 0) {
                core.info(`No debug logs found at directory ${logsDirectory}.`);
            }
            for (const entry of entries) {
                if (entry.isFile()) {
                    const absolutePath = path.resolve(dir, entry.name);
                    core.startGroup(`CodeQL Debug Logs - ${language} - ${entry.name} from file at path ${absolutePath}`);
                    process.stdout.write(fs.readFileSync(absolutePath));
                    core.endGroup();
                }
                else if (entry.isDirectory()) {
                    walkLogFiles(path.resolve(dir, entry.name));
                }
            }
        };
        walkLogFiles(logsDirectory);
    }
}
exports.printDebugLogs = printDebugLogs;
//# sourceMappingURL=actions-util.js.map