import { Repository } from './../common';
import { withScope, captureException, captureEvent, Severity } from '@sentry/node';
import { DateTime } from 'luxon';
import { Job } from 'bee-queue';
import * as fse from 'fs-extra';
import * as path from 'path';
import childProcess from 'child_process';
import * as util from 'util';
import { INormalizeTaskPayload } from '../queue';
import Config from '../config';

const now = () => DateTime.local().toFormat('yyyy-MM-dd HH:mm:ss');

export default async function (job: Job) {
  const payload = job.data as INormalizeTaskPayload;
  console.info(now(), 'normalize', payload);

  const item = await Repository.Item.findOne(payload.itemId);
  if (!item) {
    console.error('item does not exist');
    return;
  }

  const source = path.join(Config.DownloadPath, item.filename);

  if (!(await fse.pathExists(source))) {
    console.info(now(), 'file does not exist:', item.filename);
    return;
  }

  const expectedPath = path.join(path.dirname(source), 'normalized', path.basename(source).replace(new RegExp(path.extname(source) + '$'), '') + '.ogg');
  const args = [
    source,
    '-t',
    '-13',
    '-c:a',
    'libvorbis',
    '-ext',
    'ogg',
    '-o',
    expectedPath,
    '-v',
    '-f',
  ];
  console.info(now(), 'using arguments =', args);

  const messages = [] as string[];
  try {
    await new Promise((resolve, reject) => {
      const process = childProcess.spawn(Config.Encoder.ffmpegNormalize, args);
      console.info(now(), 'pid of ffmpeg-normalize', process.pid);

      process.stderr.on('data', (chunk) => {
        console.info(now(), '[stderr]', chunk.toString());
      });
      process.stdout.on('data', (chunk) => {
        console.info(now(), '[stdout]', chunk.toString());
      });

      process.on('message', (message) => {
        messages.push(message.toString());
        console.info(now(), message.toString());
      });

      process.once('exit', (code) => {
        console.info(now(), 'process exit', code);
        if (code === 0) {
          return resolve();
        }
      });

      process.on('error', (err) => {
        return reject(err);
      });
    });

    if (!(await fse.pathExists(expectedPath)) || (await fse.stat(expectedPath)).size <= 0) {
      await fse.unlink(expectedPath).catch(() => { });
      throw new Error(`Normalized file does not exist: ${expectedPath}`);
    } else {
      withScope(scope => {
        scope.setFingerprint(['TASK', 'NORMALIZE', 'OK']);
        scope.setExtra('payload', payload);
        scope.setExtra('expectedPath', expectedPath);
        scope.setExtra('messages', messages);

        captureEvent({
          message: 'Normalization OK',
          level: Severity.Log,
        });
      });

      await Repository.Item.update({ id: item.id }, { hasNormalized: true });
      console.info(item.id, 'hasNormalized: true');
    }
  } catch (e) {
    withScope(scope => {
      scope.setFingerprint(['TASK', 'NORMALIZE', 'ERROR']);
      scope.setExtra('payload', payload);
      scope.setExtra('expectedPath', expectedPath);
      scope.setExtra('messages', messages);

      captureException(e);
    });

    console.error(e);
  }
}
