#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');

const Octokit = require('@octokit/rest')
  .plugin(require('@octokit/plugin-retry'));
const App = require('@octokit/app');
const request = require('@octokit/request');
const stripAnsi = require('strip-ansi');

const getInputs = require('./getInputs');

// removing 8 chars for markdown triple backtick wrap
const MAX_DETAIL_BYTES = 65535 - 8;

async function getClientWithAuth(appId, appKey, owner, repo) {
  const app = new App({
    id: appId,
    privateKey: appKey
  });

  const jwt = app.getSignedJsonWebToken();
  const {
    data: { id: installationId }
  } = await request('GET /repos/:owner/:repo/installation', {
    owner,
    repo,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github.machine-man-preview+json'
    }
  });

  const installationAccessToken = await app.getInstallationAccessToken({ installationId });

  return new Octokit({ auth: `token ${installationAccessToken}` });
}

const prettyLogs = txt => {
  const truncatedTxt = `[truncated]\n`;
  const noAnsi = stripAnsi(txt.toString()).trim();

  if (noAnsi.length === 0) {
    return '[no output]';
  }

  // Must use buffer to trim by number of bytes due to multibyte encoding
  let bufferToFit = Buffer.from(noAnsi).slice(MAX_DETAIL_BYTES * -1);

  const prependTxt = bufferToFit.length === MAX_DETAIL_BYTES ? truncatedTxt : '';

  // Triming again to fit truncation notice
  bufferToFit = bufferToFit.slice(MAX_DETAIL_BYTES * -1 + prependTxt.length);

  return `${prependTxt}${bufferToFit.toString()}`;
};

const logRateLimit = ({
  headers: { 'x-ratelimit-limit': limit, 'x-ratelimit-remaining': remaining }
  // eslint-disable-next-line no-console
}) => console.log(`GitHub checks API - ${remaining} remaining out of ${limit}/hour`);

function spawnAndSplit(cmd, cmdArgs) {
  const cmdSpawnConfig = {
    stdio: ['inherit', 'pipe', 'pipe']
  };
  const child = spawn(cmd, cmdArgs, cmdSpawnConfig);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return child;
}

async function start() {
  const { appKey, appId, repoSlug, commitSha, buildUrl, name, cmd, cmdArgs } = getInputs();
  const [owner, repo] = repoSlug.split('/');
  const clientWithAuth = await getClientWithAuth(appId, appKey, owner, repo);

  const title = `${cmd} ${cmdArgs.join(' ')}`;
  const commonArgs = {
    owner,
    repo,
    name,
    head_sha: commitSha,
    details_url: buildUrl,
    actions: []
  };

  const checkCreateResponse = await clientWithAuth.checks.create({
    ...commonArgs,
    started_at: new Date().toISOString(),
    status: 'in_progress',
    output: {
      title,
      summary: `in progress`
    }
  });
  commonArgs.check_run_id = checkCreateResponse.data.id;
  logRateLimit(checkCreateResponse);

  const childProcess = spawnAndSplit(cmd, cmdArgs);

  let childProcLogs = '';

  childProcess.stdout.on('data', data => {
    childProcLogs += data;
  });

  childProcess.stderr.on('data', data => {
    childProcLogs += data;
  });

  // eslint-disable-next-line new-cap
  const code = await new Promise((resolve, reject) => {
    childProcess.once('close', resolve);
    childProcess.once('error', reject);
  });

  const logs = prettyLogs(childProcLogs);
  const errorFilePath = `${__dirname}../../target/errors.json`;
  const images = [];

  const annotations = fs.existsSync(errorFilePath)
    ? JSON.parse(fs.readFileSync(errorFilePath))
    : [];
  annotations.forEach(
    annotation =>
      annotation.screenshot &&
      images.push({
        alt: `Failure: ${annotation.title}`,
        caption: `Failure: ${annotation.title}`,
        image_url: annotation.screenshot
      })
  );

  /*
    if(fs.existsSync(errorFilePath)) {
      console.log('FILE EXISTS');
      annotations = JSON.parse(fs.readFileSync(errorFilePath));
      annotations.forEach(annotation => annotation.screenshot &&
        images.push({
          alt: `Failure: ${annotation.title}`,
          caption: `Failure: ${annotation.title}`,
          image_url: annotation.screenshot,
        }));
    }else{
      console.log('DIDNT FIND FILE');
    }
    */

  const checkUpdateResponse = await clientWithAuth.checks.update({
    ...commonArgs,
    conclusion: code === 0 ? 'success' : 'failure',
    completed_at: new Date().toISOString(),
    output: {
      title,
      summary: ` `,
      text: `\`\`\`\n${logs}\n\`\`\``,
      annotations,
      images
    }
  });
  logRateLimit(checkUpdateResponse);
  process.exit(code);
}

start().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
