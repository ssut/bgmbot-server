import { PlaylistItem } from '@entities/playlist-item.entity';
import { captureException, withScope } from '@sentry/node';
import axios from 'axios';
import { Job } from 'bee-queue';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import { DateTime } from 'luxon';
import * as path from 'path';
import * as io from 'stream';
import { getRepository } from 'typeorm';
import * as uuid from 'uuid';
import * as ytdl from 'ytdl-core-new';
import { VideoInfo } from 'ytdl-core-new/dist/models';

import Config from '../config';
import { Item, ItemState } from '../entities/item.entity';
import { IDownloadTaskPayload } from '../queue';
import { toFilename } from '../utils';
import { redis, slack } from './../common';
import { INormalizeTaskPayload, NormalizeTaskQueue } from './../queue';
import { getChannel } from './../utils';

const now = () => DateTime.local().toFormat('yyyy-MM-dd HH:mm:ss');
const downloadClient = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.106 Safari/537.36',
  },
});

export default async function (job: Job) {
  const payload = job.data as IDownloadTaskPayload;
  console.info(now(), payload);

  const item = await getRepository(Item).findOneOrFail(payload.itemId);
  item.state = ItemState.Downloading;
  item.downloadStartedAt = new Date();
  await getRepository(Item).save(item);

  const playlistItem = await getRepository(PlaylistItem).findOneOrFail(payload.playlistItemId);
  const channelInfo = getChannel(playlistItem.channel);

  try {
    await slack.reactions.add({
      token: Config.Slack.BotUserAccessToken,
      channel: channelInfo.id,
      timestamp: playlistItem.slackNotificationIds.queued,
      name: 'dadada',
    });
  } catch (e) { }

  const videoInfo = (item.info ? item.info : (await ytdl.getInfo(item.link))) as VideoInfo;
  console.info(now(), 'videoInfo ready', videoInfo.title);

  const availableAudioFormats = videoInfo.formats
    .filter(({ mimeType }) => mimeType?.includes('audio/'))
    .map((format) => {
      return {
        score: (format as any).audioBitrate as number,
        format,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ format }) => format);
  const [bestAudioFormat] = availableAudioFormats;
  // console.info(bestAudioFormat);

  const availableAudiosForStreamingData = videoInfo.player_response?.streamingData?.adaptiveFormats
    .filter(({ mimeType, url }: any) => mimeType?.includes('audio/') && typeof url === 'string' && url.length > 0)
    .map((format: any) => {
      const score = format.averageBitrate || -1;

      return {
        score,
        format,
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ format }) => format) ?? [];

  const [firstAudioStreamingData] = availableAudiosForStreamingData;

  const title = toFilename(item.title);
  const filename = `${title}_${uuid.v4()}.ogg`;
  const filepath = path.join(Config.DownloadPath, filename);

  console.info(now(), 'download started:', filename);
  const fileStream = fs.createWriteStream(filepath);

  try {
    await new Promise(async (resolve, reject) => {
      let reader: io.Readable | null;

      if (firstAudioStreamingData) {
        try {
          const resp = await downloadClient.get(firstAudioStreamingData.url, {
            responseType: 'stream',
            headers: {

            },
          });
          console.info(now(), 'downloading from', firstAudioStreamingData.url, 'using axios');

          let downloaded = 0;
          let total = Number(resp.headers['content-length']);
          console.info(now(), 'content-length =', (total / 1000 / 1000).toFixed(2), 'MiB');
          // resp.data.on('data', (chunk: Buffer) => {
          //   downloaded += chunk.length;

          //   const percent = downloaded / total;
          //   if (Math.trunc(percent * 100) % 5 === 0) {
          //     console.info(now(), '[ytdl]', (percent * 100).toFixed(2), '% downloaded (', (downloaded / 1024 / 1024).toFixed(2), 'MB of', (total / 1024 / 1024).toFixed(2), 'MB)');
          //   }
          // });

          reader = resp.data;
        } catch (e) {
          console.error(now(), 'axios response failed');
        }
      }

      if (reader! === null) {
        reader = ytdl.downloadFromInfo(videoInfo, {
          format: bestAudioFormat,
        });
        reader.on('progress', ({ chunkLength, downloaded, total }) => {
          const percent = downloaded / total;
          if (Math.trunc(percent * 100) % 5 === 0) {
            console.info(now(), '[ytdl]', (percent * 100).toFixed(2), '% downloaded (', (downloaded / 1024 / 1024).toFixed(2), 'MB of', (total / 1024 / 1024).toFixed(2), 'MB)');
          }
        });
      }

      const writer = ffmpeg(reader!).noVideo().format('ogg').audioQuality(5).addOption('-v 48').addOption('-filter:a volumedetect');
      console.info(now(), 'arguments =', writer._getArguments());
      writer.on('progress', ({ timemark, targetSize }: any) => {
        console.info(now(), `[ffmpeg] ${timemark} (${targetSize}KB)`);
      });
      writer.on('end', resolve);

      writer.output(fileStream).run();
    });
  } catch (e) {
    withScope(scope => {
      scope.setExtra('bestAudioFormat', bestAudioFormat);
      scope.setExtra('firstAudioStreamingData', firstAudioStreamingData);
      scope.setExtra('title', title);
      scope.setExtra('itemId', item.id);
      scope.setExtra('playlistItemId', playlistItem.id);
      scope.setExtra('filename', filename);

      captureException(e);
    });

    slack.reactions.add({
      token: Config.Slack.BotUserAccessToken,
      channel: channelInfo.id,
      timestamp: playlistItem.slackNotificationIds.queued,
      name: 'exclamation',
    }).catch(() => { });

    throw e;
  }

  slack.reactions.remove({
    token: Config.Slack.BotUserAccessToken,
    channel: channelInfo.id,
    timestamp: playlistItem.slackNotificationIds.queued,
    name: 'exclamation',
  }).catch(() => { });
  slack.reactions.remove({
    token: Config.Slack.BotUserAccessToken,
    channel: channelInfo.id,
    timestamp: playlistItem.slackNotificationIds.queued,
    name: 'dadada',
  }).catch(() => { });
  slack.reactions.add({
    token: Config.Slack.BotUserAccessToken,
    channel: channelInfo.id,
    timestamp: playlistItem.slackNotificationIds.queued,
    name: 'oki',
  }).catch(() => { });

  console.info(now(), 'download finished:', filename);

  item.downloadEndedAt = new Date();
  item.filename = filename;
  item.state = ItemState.Prepared;
  await getRepository(Item).save(item);

  await getRepository(PlaylistItem).update({ id: playlistItem.id }, { isReady: true });

  await redis.publish(`bgm:channels:${playlistItem.channel}:events`, JSON.stringify({
    channel: playlistItem.channel,
    event: 'downloaded',
    id: item.id,
  }));

  console.info(now(), 'event submitted');

  if (Config.Encoder.useNormalize) {
    const normalizeJob = NormalizeTaskQueue.createJob<INormalizeTaskPayload>({
      itemId: item.id,
    });
    await normalizeJob.save();

    console.info(now(), 'normalize requested');
  }
}
