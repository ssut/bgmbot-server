import './setup';
import './sentry';
import { DownloadTaskQueue, WordcloudTaskQueue, IWordcloudTaskPayload, NormalizeTaskQueue } from './queue';
import { initRepository, redis } from './common';
import { createConnection } from 'typeorm';

import { download, wordcloud, normalize } from './tasks';
import Config from './config';

const CronJob = require('cron-cluster')(redis.redis).CronJob;

async function main() {
  await createConnection();
  initRepository();

  DownloadTaskQueue.process(download);
  WordcloudTaskQueue.process(wordcloud);
  if (Config.Encoder.useNormalize) {
    NormalizeTaskQueue.process(normalize);
  }

  const job = new CronJob({
    cronTime: '30 18 * * 1-5',
    onTick() {
      for (const channel of ['bgm', 'bgm_dnd']) {
        WordcloudTaskQueue.createJob<IWordcloudTaskPayload>({
          channel,
        }).save();
      }
    },
  });
  job.start();
}

main();
