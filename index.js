const path = require("path");
const core = require("@actions/core");
const aws = require("aws-sdk");
const yaml = require("yaml");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");

const MAX_WAIT_MINUTES = 360; // 6 hours
const WAIT_DEFAULT_DELAY_SEC = 15;

// These codes are extracted from https://github.com/aws-actions/amazon-ecs-deploy-task-definition
// And modified for use another tasks like "notify to slack"

// Notify to Slack channel with http POST request
function notifySlack(data) {
    axios({
        method: "POST",
        data,
        header: {
            "Content-type": "application/json",
        },
    });
}

// Get Slack variables from inputs and return slack variables object
function getSlackInputs() {
    const slackWebHookUrl = core.getInput("slack-webhook-url", { required: false });
    const slackWaitingMsgBlocksPath = core.getInput("slack-waiting-msg-blocks", { required: false });
    const slackSuccessMsgBlocksPath = core.getInput("slack-success-msg-blocks", { required: false });
    const slackFailureMsgBlocksPath = core.getInput("slack-failure-msg-blocks", { required: false });
    const slackChannel = core.getInput("slack-channel", { required: false });
    const slackDisplayText = core.getInput("slack-display-text", { required: false });
    let slackDefaultBlocksLanguage = core.getInput("slack-default-blocks-language", { required: false });
    slackDefaultBlocksLanguage = slackDefaultBlocksLanguage || "eng";
    let blocksObjs = {};
    if (slackWaitingMsgBlocksPath && slackSuccessMsgBlocksPath && slackFailureMsgBlocksPath) {
        blocksObjs = makeBlocksToObject(
            slackWaitingMsgBlocksPath,
            slackSuccessMsgBlocksPath,
            slackFailureMsgBlocksPath,
        );
    }

    const slackVariables = {
        slackWebHookUrl,
        slackChannel,
        slackDisplayText,
        ...blocksObjs,
    };
    return slackVariables;
}

// Get Slack message blocks from filepath
function makeBlocksToObject(slackWaitingMsgBlocksPath, slackSuccessMsgBlocksPath, slackFailureMsgBlocksPath) {
    const blocksObjs = {
        slackWaitingMsgBlocks: stringToObject(jsonFileToString(slackWaitingMsgBlocksPath)),
        slackSuccessMsgBlocks: stringToObject(jsonFileToString(slackSuccessMsgBlocksPath)),
        slackFailureMsgBlocks: stringToObject(jsonFileToString(slackFailureMsgBlocksPath)),
    };
    return blocksObjs;
}

function jsonFileToString(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch {
        throw Error(`${filePath} does not exist!`);
    }
}

function stringToObject(valueKey, stringValue) {
    try {
        return JSON.parse(stringValue);
    } catch {
        throw Error(`your ${valueKey} is not JSON format!`);
    }
}

// Check Slack Webhook Url is given
function isSlackAvailable(slackObj) {
    return slackObj.slackWebHookUrl || false;
}

// Check that user want to use default block template
function isDefaultBlock(slackObj) {
    const isDefault =
        slackObj.slackWaitingMsgBlocks && slackObj.slackSuccessMsgBlocks && slackObj.slackFailureMsgBlocks;
    return isDefault ? true : false;
}

// Make default block template with selected langauge
function slackDefaultBlockTemplate(slackObj, params = { header: "", buttonText: "", buttonUrl: "" }) {
    const lang = slackObj.slackDefaultBlocksLanguage;
    //TODO: make eng template
    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `저장소 : ${process.env.GITHUB_REPOSITORY}\n브랜치 : ${process.env.GITHUB_REF}\n이벤트 : ${process.env.GITHUB_EVENT_NAME}\n커밋 : ${process.env.GITHUB_SHA}`,
            },
        },
        {
            type: "header",
            text: {
                type: "plain_text",
                text: params.header,
                emoji: true,
            },
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: params.buttonText,
                        emoji: true,
                    },
                    url: params.buttonUrl,
                },
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "커밋정보",
                        emoji: true,
                    },
                    url: `https://github.com/${process.env.GITHUB_REPOSITORY}/commit/${process.env.GITHUB_SHA}`,
                },
            ],
        },
    ];
}

// Notify to Slack when Deploy Begin
function notifyDeployStart(slackValues, buttonUrl) {
    if (isDefaultBlock(slackValues)) {
        notifySlack(
            slackDefaultBlockTemplate(slackValues, {
                header: "배포 시작...",
                buttonText: "배포상태",
                buttonUrl: buttonUrl,
            }),
        );
    } else {
        notifySlack(slackValues.slackWaitingMsgBlocks);
    }
}

// Notify to Slack when Deploy Success
function notifyDeploySuccess(slackValues, buttonUrl) {
    if (isDefaultBlock(slackValues)) {
        notifySlack(
            slackDefaultBlockTemplate(slackValues, { header: "배포 완료!!", buttonText: "확인", buttonUrl: buttonUrl }),
        );
    } else {
        notifySlack(slackValues.slackSuccessMsgBlocks);
    }
}

// Notify to Slack when Deploy Failure
function notifyDeployFailure(slackValues, buttonUrl) {
    if (isDefaultBlock(slackValues)) {
        notifySlack(
            slackDefaultBlockTemplate(slackValues, { header: "배포 실패!!", buttonText: "확인", buttonUrl: buttonUrl }),
        );
    } else {
        notifySlack(slackValues.slackFailureMsgBlocks);
    }
}

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
    "compatibilities",
    "taskDefinitionArn",
    "requiresAttributes",
    "revision",
    "status",
];

// Deploy to a service that uses the 'ECS' deployment controller
async function updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes) {
    core.debug("Updating the service");
    await ecs
        .updateService({
            cluster: clusterName,
            service: service,
            taskDefinition: taskDefArn,
        })
        .promise();
    core.info(
        `Deployment started. Watch this deployment's progress in the Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/services/${service}/events`,
    );
    const slackValues = getSlackInputs();
    if (isSlackAvailable(slackValues)) {
        const buttonUrl = `https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/services/${service}/events`;
        notifyDeployStart(slackValues, buttonUrl);
    }

    // Wait for service stability
    if (waitForService && waitForService.toLowerCase() === "true") {
        core.debug(`Waiting for the service to become stable. Will wait for ${waitForMinutes} minutes`);
        const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;
        await ecs
            .waitFor("servicesStable", {
                services: [service],
                cluster: clusterName,
                $waiter: {
                    delay: WAIT_DEFAULT_DELAY_SEC,
                    maxAttempts: maxAttempts,
                },
            })
            .promise();
    } else {
        core.debug("Not waiting for the service to become stable");
    }
}

// Find value in a CodeDeploy AppSpec file with a case-insensitive key
function findAppSpecValue(obj, keyName) {
    return obj[findAppSpecKey(obj, keyName)];
}

function findAppSpecKey(obj, keyName) {
    if (!obj) {
        throw new Error(`AppSpec file must include property '${keyName}'`);
    }

    const keyToMatch = keyName.toLowerCase();

    for (var key in obj) {
        if (key.toLowerCase() == keyToMatch) {
            return key;
        }
    }

    throw new Error(`AppSpec file must include property '${keyName}'`);
}

function isEmptyValue(value) {
    if (value === null || value === undefined || value === "") {
        return true;
    }

    if (Array.isArray(value)) {
        for (var element of value) {
            if (!isEmptyValue(element)) {
                // the array has at least one non-empty element
                return false;
            }
        }
        // the array has no non-empty elements
        return true;
    }

    if (typeof value === "object") {
        for (var childValue of Object.values(value)) {
            if (!isEmptyValue(childValue)) {
                // the object has at least one non-empty property
                return false;
            }
        }
        // the object has no non-empty property
        return true;
    }

    return false;
}

function emptyValueReplacer(_, value) {
    if (isEmptyValue(value)) {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value.filter((e) => !isEmptyValue(e));
    }

    return value;
}

function cleanNullKeys(obj) {
    return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
    for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
        if (taskDef[attribute]) {
            core.warning(
                `Ignoring property '${attribute}' in the task definition file. ` +
                    "This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, " +
                    "but it is not a valid field when registering a new task definition. " +
                    "This field can be safely removed from your task definition file.",
            );
            delete taskDef[attribute];
        }
    }

    return taskDef;
}

// Deploy to a service that uses the 'CODE_DEPLOY' deployment controller
async function createCodeDeployDeployment(
    codedeploy,
    clusterName,
    service,
    taskDefArn,
    waitForService,
    waitForMinutes,
) {
    core.debug("Updating AppSpec file with new task definition ARN");

    let codeDeployAppSpecFile = core.getInput("codedeploy-appspec", { required: false });
    codeDeployAppSpecFile = codeDeployAppSpecFile ? codeDeployAppSpecFile : "appspec.yaml";

    let codeDeployApp = core.getInput("codedeploy-application", { required: false });
    codeDeployApp = codeDeployApp ? codeDeployApp : `AppECS-${clusterName}-${service}`;

    let codeDeployGroup = core.getInput("codedeploy-deployment-group", { required: false });
    codeDeployGroup = codeDeployGroup ? codeDeployGroup : `DgpECS-${clusterName}-${service}`;

    let deploymentGroupDetails = await codedeploy
        .getDeploymentGroup({
            applicationName: codeDeployApp,
            deploymentGroupName: codeDeployGroup,
        })
        .promise();
    deploymentGroupDetails = deploymentGroupDetails.deploymentGroupInfo;

    // Insert the task def ARN into the appspec file
    const appSpecPath = path.isAbsolute(codeDeployAppSpecFile)
        ? codeDeployAppSpecFile
        : path.join(process.env.GITHUB_WORKSPACE, codeDeployAppSpecFile);
    const fileContents = fs.readFileSync(appSpecPath, "utf8");
    const appSpecContents = yaml.parse(fileContents);

    for (var resource of findAppSpecValue(appSpecContents, "resources")) {
        for (var name in resource) {
            const resourceContents = resource[name];
            const properties = findAppSpecValue(resourceContents, "properties");
            const taskDefKey = findAppSpecKey(properties, "taskDefinition");
            properties[taskDefKey] = taskDefArn;
        }
    }

    const appSpecString = JSON.stringify(appSpecContents);
    const appSpecHash = crypto.createHash("sha256").update(appSpecString).digest("hex");

    // Start the deployment with the updated appspec contents
    core.debug("Starting CodeDeploy deployment");
    const createDeployResponse = await codedeploy
        .createDeployment({
            applicationName: codeDeployApp,
            deploymentGroupName: codeDeployGroup,
            revision: {
                revisionType: "AppSpecContent",
                appSpecContent: {
                    content: appSpecString,
                    sha256: appSpecHash,
                },
            },
        })
        .promise();
    core.setOutput("codedeploy-deployment-id", createDeployResponse.deploymentId);
    core.info(
        `Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/${createDeployResponse.deploymentId}?region=${aws.config.region}`,
    );
    const slackValues = getSlackInputs();
    if (isSlackAvailable(slackValues)) {
        const buttonUrl = `https://console.aws.amazon.com/codesuite/codedeploy/deployments/${createDeployResponse.deploymentId}?region=${aws.config.region}`;
        notifyDeployStart(slackValues, buttonUrl);
    }

    // Wait for deployment to complete
    if (waitForService && waitForService.toLowerCase() === "true") {
        // Determine wait time
        const deployReadyWaitMin =
            deploymentGroupDetails.blueGreenDeploymentConfiguration.deploymentReadyOption.waitTimeInMinutes;
        const terminationWaitMin =
            deploymentGroupDetails.blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess
                .terminationWaitTimeInMinutes;
        let totalWaitMin = deployReadyWaitMin + terminationWaitMin + waitForMinutes;
        if (totalWaitMin > MAX_WAIT_MINUTES) {
            totalWaitMin = MAX_WAIT_MINUTES;
        }
        const maxAttempts = (totalWaitMin * 60) / WAIT_DEFAULT_DELAY_SEC;

        core.debug(`Waiting for the deployment to complete. Will wait for ${totalWaitMin} minutes`);
        await codedeploy
            .waitFor("deploymentSuccessful", {
                deploymentId: createDeployResponse.deploymentId,
                $waiter: {
                    delay: WAIT_DEFAULT_DELAY_SEC,
                    maxAttempts: maxAttempts,
                },
            })
            .promise();
    } else {
        core.debug("Not waiting for the deployment to complete");
    }
}

async function run() {
    try {
        const ecs = new aws.ECS({
            customUserAgent: "amazon-ecs-deploy-task-definition-for-github-actions",
        });
        const codedeploy = new aws.CodeDeploy({
            customUserAgent: "amazon-ecs-deploy-task-definition-for-github-actions",
        });

        // Get inputs
        const taskDefinitionFile = core.getInput("task-definition", { required: true });
        const service = core.getInput("service", { required: false });
        const cluster = core.getInput("cluster", { required: false });
        const waitForService = core.getInput("wait-for-service-stability", { required: false });
        let waitForMinutes = parseInt(core.getInput("wait-for-minutes", { required: false })) || 30;
        if (waitForMinutes > MAX_WAIT_MINUTES) {
            waitForMinutes = MAX_WAIT_MINUTES;
        }

        // Register the task definition
        core.debug("Registering the task definition");
        const taskDefPath = path.isAbsolute(taskDefinitionFile)
            ? taskDefinitionFile
            : path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
        const fileContents = fs.readFileSync(taskDefPath, "utf8");
        const taskDefContents = removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents)));
        let registerResponse;
        try {
            registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
        } catch (error) {
            core.setFailed("Failed to register task definition in ECS: " + error.message);
            core.debug("Task definition contents:");
            core.debug(JSON.stringify(taskDefContents, undefined, 4));
            throw error;
        }
        const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
        core.setOutput("task-definition-arn", taskDefArn);

        // Update the service with the new task definition
        if (service) {
            const clusterName = cluster ? cluster : "default";

            // Determine the deployment controller
            const describeResponse = await ecs
                .describeServices({
                    services: [service],
                    cluster: clusterName,
                })
                .promise();

            if (describeResponse.failures && describeResponse.failures.length > 0) {
                const failure = describeResponse.failures[0];
                throw new Error(`${failure.arn} is ${failure.reason}`);
            }

            const serviceResponse = describeResponse.services[0];
            if (serviceResponse.status != "ACTIVE") {
                throw new Error(`Service is ${serviceResponse.status}`);
            }

            if (!serviceResponse.deploymentController) {
                // Service uses the 'ECS' deployment controller, so we can call UpdateService
                await updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes);
            } else if (serviceResponse.deploymentController.type == "CODE_DEPLOY") {
                // Service uses CodeDeploy, so we should start a CodeDeploy deployment
                await createCodeDeployDeployment(
                    codedeploy,
                    clusterName,
                    service,
                    taskDefArn,
                    waitForService,
                    waitForMinutes,
                );
            } else {
                throw new Error(`Unsupported deployment controller: ${serviceResponse.deploymentController.type}`);
            }
        } else {
            core.debug("Service was not specified, no service updated");
        }
        if (isSlackAvailable(slackValues)) {
            const buttonUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/commit/${process.env.GITHUB_SHA}/checks/?check_suite_id=${process.env.GITHUB_RUN_ID}`;
            notifyDeploySuccess(slackValues, buttonUrl);
        }
    } catch (error) {
        core.setFailed(error.message);
        core.debug(error.stack);
        if (isSlackAvailable(slackValues)) {
            const buttonUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/commit/${process.env.GITHUB_SHA}/checks/?check_suite_id=${process.env.GITHUB_RUN_ID}`;
            notifyDeployFailure(slackValues, buttonUrl);
        }
    }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}
