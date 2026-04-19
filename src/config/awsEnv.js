/**
 * Video checker / S3 — reads foureel-backend/.env in this order:
 *   AWS_REGION
 *   AWS_S3_BUCKET
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 */
function readAwsCheckerEnv() {
  return {
    region: process.env.AWS_REGION?.trim() || "",
    bucket: process.env.AWS_S3_BUCKET?.trim() || "",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim() || "",
  };
}

function hasBucketAndRegion(env = readAwsCheckerEnv()) {
  return Boolean(env.bucket && env.region);
}

function hasSigningCredentials(env = readAwsCheckerEnv()) {
  return Boolean(env.accessKeyId && env.secretAccessKey);
}

module.exports = {
  readAwsCheckerEnv,
  hasBucketAndRegion,
  hasSigningCredentials,
};
