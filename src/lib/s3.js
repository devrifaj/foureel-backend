const { S3Client } = require("@aws-sdk/client-s3");
const { readAwsCheckerEnv } = require("../config/awsEnv");

function buildS3ClientConfig() {
  const { region, accessKeyId, secretAccessKey } = readAwsCheckerEnv();
  const config = { region: region || undefined };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  return config;
}

const s3 = new S3Client(buildS3ClientConfig());

module.exports = s3;
