import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { DateTime } from 'luxon';
import { PythonShell } from 'python-shell';
import { getChannel } from '../utils';
import Config from '../config';
import { IWordcloudTaskPayload } from '../queue';
import { slack } from '../common';
import { Job } from 'bee-queue';

const existsAsync = util.promisify(fs.exists);

const WC = Object.freeze({
  pythonPath: process.env.PYTHON_EXEC!,
  scriptPath: process.env.WORDCLOUD_EXEC!,
});

export default async function wordcloud (job: Job) {
  const payload = job.data as IWordcloudTaskPayload;
  const { channel } = payload;

  const channelInfo = getChannel(channel);
  if (!channelInfo) {
    return;
  }

  console.info('trying to draw word cloud');
  const scriptPath = path.dirname(WC.scriptPath);
  const scriptName = path.basename(WC.scriptPath);
  await new Promise((resolve, reject) => PythonShell.run(scriptName, {
    pythonPath: WC.pythonPath,
    scriptPath,
    args: [channel],
  }, (err, res) => {
    if (err) {
      return reject(err);
    }

    return resolve(res);
  }));
  console.info('no errors');

  const expectedPath = path.join(scriptPath, `${channel}.png`);
  if (!(await existsAsync(expectedPath))) {
    console.info('file does not exist');
    return;
  }

  const file = fs.createReadStream(expectedPath);
  await slack.files.upload({
    token: Config.Slack.BotUserAccessToken,
    file,
    channels: channelInfo.id,
    title: `오늘(${DateTime.local().toFormat('yyyy-MM-dd')}) 재생한 곡 제목 중에서 가장 많이 나온 단어`,
  });
}

