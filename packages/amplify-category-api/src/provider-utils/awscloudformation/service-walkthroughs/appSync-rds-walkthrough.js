const inquirer = require('inquirer');
const ora = require('ora');
const { DataApiParams } = require('graphql-relational-schema-transformer');
const { ResourceDoesNotExistError, ResourceCredentialsNotFoundError, exitOnNextTick } = require('amplify-cli-core');

const spinner = ora('');
const category = 'api';
const providerName = 'awscloudformation';

async function serviceWalkthrough(context, defaultValuesFilename, datasourceMetadata) {
  const amplifyMeta = context.amplify.getProjectMeta();

  // Verify that an API exists in the project before proceeding.
  if (amplifyMeta == null || amplifyMeta[category] == null || Object.keys(amplifyMeta[category]).length === 0) {
    const errMessage =
      'You must create an AppSync API in your project before adding a graphql datasource. Please use "amplify api add" to create the API.';
    context.print.error(errMessage);
    await context.usageData.emitError(new ResourceDoesNotExistError(errMessage));
    exitOnNextTick(0);
  }

  // Loop through to find the AppSync API Resource Name
  let appSyncApi;
  const apis = Object.keys(amplifyMeta[category]);

  for (let i = 0; i < apis.length; i += 1) {
    if (amplifyMeta[category][apis[i]].service === 'AppSync') {
      appSyncApi = apis[i];
      break;
    }
  }

  // If an AppSync API does not exist, inform the user to create the AppSync API
  if (!appSyncApi) {
    const errMessage =
      'You must create an AppSync API in your project before adding a graphql datasource. Please use "amplify api add" to create the API.';
    context.print.error(errMessage);
    await context.usageData.emitError(new ResourceDoesNotExistError(errMessage));
    exitOnNextTick(0);
  }

  const { inputs, availableRegions } = datasourceMetadata;

  // Region Question
  const selectedRegion = await promptWalkthroughQuestion(inputs, 0, availableRegions);

  const AWS = await getAwsClient(context, 'list');

  // Prepare the SDK with the region
  AWS.config.update({
    region: selectedRegion,
  });

  // RDS Cluster Question
  const { selectedClusterArn, clusterResourceId } = await selectCluster(context, inputs, AWS);

  // Secret Store Question
  const selectedSecretArn = await getSecretStoreArn(context, inputs, clusterResourceId, AWS);

  // Database Name Question
  const selectedDatabase = await selectDatabase(context, inputs, selectedClusterArn, selectedSecretArn, AWS);

  return {
    region: selectedRegion,
    dbClusterArn: selectedClusterArn,
    secretStoreArn: selectedSecretArn,
    databaseName: selectedDatabase,
    resourceName: appSyncApi,
  };
}

/**
 *
 * @param {*} inputs
 */
async function selectCluster(context, inputs, AWS) {
  const RDS = new AWS.RDS();

  const describeDBClustersResult = await RDS.describeDBClusters().promise();
  const rawClusters = describeDBClustersResult.DBClusters;
  const clusters = new Map();

  for (let i = 0; i < rawClusters.length; i += 1) {
    if (rawClusters[i].EngineMode === 'serverless') {
      clusters.set(rawClusters[i].DBClusterIdentifier, rawClusters[i]);
    }
  }

  if (clusters.size > 0) {
    const clusterIdentifier = await promptWalkthroughQuestion(inputs, 1, Array.from(clusters.keys()));
    const selectedCluster = clusters.get(clusterIdentifier);

    return {
      selectedClusterArn: selectedCluster.DBClusterArn,
      clusterResourceId: selectedCluster.DbClusterResourceId,
    };
  }
  const errMessage = 'No properly configured Aurora Serverless clusters found.';
  context.print.error(errMessage);
  await context.usageData.emitError(new ResourceDoesNotExistError(errMessage));
  exitOnNextTick(0);
}

/**
 *
 * @param {*} inputs
 * @param {*} clusterResourceId
 */
async function getSecretStoreArn(context, inputs, clusterResourceId, AWS) {
  const SecretsManager = new AWS.SecretsManager();
  const NextToken = 'NextToken';
  let rawSecrets = [];
  const params = {
    MaxResults: 20,
  };

  const listSecretsResult = await SecretsManager.listSecrets(params).promise();

  rawSecrets = listSecretsResult.SecretList;
  let token = listSecretsResult.NextToken;
  while (token) {
    params[NextToken] = token;
    const tempSecretsResult = await SecretsManager.listSecrets(params).promise();
    rawSecrets = [...rawSecrets, ...tempSecretsResult.SecretList];
    token = tempSecretsResult.NextToken;
  }

  const secrets = new Map();
  let selectedSecretArn;

  for (let i = 0; i < rawSecrets.length; i += 1) {
    /**
     * Attempt to auto-detect Secret Store that was created by Aurora Serverless
     * as it follows a specfic format for the Secret Name
     */
    if (rawSecrets[i].Name.startsWith(`rds-db-credentials/${clusterResourceId}`)) {
      // Found the secret store - store the details and break out.
      selectedSecretArn = rawSecrets[i].ARN;
      break;
    }
    secrets.set(rawSecrets[i].Name, rawSecrets[i].ARN);
  }

  if (!selectedSecretArn) {
    if (secrets.size > 0) {
      // Kick off questions flow
      const selectedSecretName = await promptWalkthroughQuestion(inputs, 2, Array.from(secrets.keys()));
      selectedSecretArn = secrets.get(selectedSecretName);
    } else {
      const errMessage = 'No RDS access credentials found in the AWS Secrect Manager.';
      context.print.error(errMessage);
      await context.usageData.emitError(new ResourceCredentialsNotFoundError(errMessage));
      exitOnNextTick(0);
    }
  }

  return selectedSecretArn;
}

/**
 *
 * @param {*} inputs
 * @param {*} clusterArn
 * @param {*} secretArn
 */
async function selectDatabase(context, inputs, clusterArn, secretArn, AWS) {
  // Database Name Question
  const DataApi = new AWS.RDSDataService();
  const params = new DataApiParams();
  const databaseList = [];
  params.secretArn = secretArn;
  params.resourceArn = clusterArn;
  const dbCluster = await new AWS.RDS().describeDBClusters({ DBClusterIdentifier: clusterArn }).promise();
  context.isPostgres = dbCluster.DBClusters.some(cluster => cluster.Engine.includes('postgres'));
  params.sql = context.isPostgres ? 'SELECT datname FROM pg_database;' : 'show databases';
  spinner.start('Fetching Aurora Serverless cluster...');
  try {
    const dataApiResult = await DataApi.executeStatement(params).promise();
    const records = dataApiResult.records;
    const validRecordValues = context.isPostgres
      ? ['rdsadmin', 'postgres', 'template1', 'template0']
      : ['information_schema', 'performance_schema', 'mysql'];
    for (const record of records) {
      const recordValue = record[0].stringValue;
      if (!validRecordValues.includes(recordValue)) {
        databaseList.push(recordValue);
      }
    }
    spinner.succeed('Fetched Aurora Serverless cluster.');
  } catch (err) {
    spinner.fail(err.message);

    if (err.code === 'BadRequestException' && /Access denied for user/.test(err.message)) {
      const msg =
        `Ensure that '${secretArn}' contains your database credentials. ` +
        'Please note that Aurora Serverless does not support IAM database authentication.';
      context.print.error(msg);
    }
  }

  if (databaseList.length > 0) {
    return await promptWalkthroughQuestion(inputs, 3, databaseList);
  }

  const errMessage = 'No properly configured databases found.';
  context.print.error(errMessage);
  await context.usageData.emitError(new ResourceDoesNotExistError(errMessage));
  exitOnNextTick(0);
}

/**
 *
 * @param {*} inputs
 * @param {*} questionNumber
 * @param {*} choicesList
 */
async function promptWalkthroughQuestion(inputs, questionNumber, choicesList) {
  const question = [
    {
      type: inputs[questionNumber].type,
      name: inputs[questionNumber].key,
      message: inputs[questionNumber].question,
      choices: choicesList,
    },
  ];

  const answer = await inquirer.prompt(question);
  return answer[inputs[questionNumber].key];
}

async function getAwsClient(context, action) {
  const providerPlugins = context.amplify.getProviderPlugins(context);
  const provider = require(providerPlugins[providerName]);
  return await provider.getConfiguredAWSClient(context, 'aurora-serverless', action);
}

module.exports = {
  serviceWalkthrough,
};
