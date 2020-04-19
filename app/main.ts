import { UserRepository } from './repositories/user.repository';
import { DateTime, Duration } from 'luxon';
import './setup';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = Infinity;

import { captureException, withScope, captureEvent, Severity } from '@sentry/node';
import * as assert from 'assert';
import bluebird from 'bluebird';
import fastify from 'fastify';
import { createReadStream, stat } from 'fs';
import * as fse from 'fs-extra';
import * as _ from 'lodash';
import * as path from 'path';
import { In, getRepository, getCustomRepository } from 'typeorm';
import * as util from 'util';
import { authenticator } from 'otplib';
import uuid from 'uuid';
import YouTubeWebData from 'youtube-web-data';

import { client, initConnection, redis, slack } from './common';
import Config from './config';
import { PlaylistItem, PlaylistItemState } from './entities/playlist-item.entity';
import { User } from './entities/user.entity';
import * as routes from './routes';
import { getChannelByChannelId } from './utils';
import { search } from './utils/search';
import { Item } from '@entities/item.entity';
import { PlaylistItemRepository } from '@repositories/playlist-item.repository';
import { Like } from '@entities/like.entity';

enum NotificationType {
  AddToPlaylist = 'addToPlaylist',
  AgreeTOS = 'agreeTOS',
}

const app = fastify({
  logger: {
    prettyPrint: true,
  },
  trustProxy: ['127.0.0.0/16'],
});

app.register(require('fastify-sentry'), {
  dsn: Config.Sentry.Dsn,
  attachStacktrace: true,

});
app.register(require('fastify-cors'), { exposedHeaders: ['content-disposition', 'content-range'] });
app.register(require('fastify-formbody'));
app.register(require('fastify-websocket'));
routes.applyApi(app);
app.get('/', async (req, rep) => {
  return 'Hi there!';
});

app.head('/items/:id', async (request, reply) => {
  const referrer = request.headers.referer || request.headers.referrer;
  if (typeof referrer !== 'string') {
    reply.status(403);
    return 'Forbidden';
  }

  const host = referrer.split('://', 2).reverse()[0].split('/', 1)[0];
  if (!host) {
    console.error('host?', referrer, host);
    reply.status(500);
    return 'Internal Server Error';
  }

  if (!Config.Frontend.AllowedHosts.includes(host)) {
    reply.status(403);
    return 'Forbidden';
  }

  const id = request.params.id;
  const item = await getRepository(Item).findOneOrFail(id, {
    select: ['id', 'filename', 'state', 'hasNormalized'],
  });

  if (!item.filename) {
    withScope(scope => {
      scope.setFingerprint(['ITEM_REQUEST', 'FILENAME_DOES_NOT_EXIST']);
      scope.setExtra('itemId', item.id);
      scope.setExtra('filename', item.filename);

      captureEvent({
        message: '파일이 존재하지 않음',
        level: Severity.Warning,
      });
    });

    reply.status(404);
    return 'Not Found';
  }

  const baseFilename = path.basename(item.filename);
  const normalizedFilename = baseFilename.replace(path.extname(baseFilename), '') + '.ogg';
  const normalizedFilepath = path.join(Config.DownloadPath, 'normalized', normalizedFilename);

  const filepath = path.join(Config.DownloadPath, item.filename);
  const ext = item.hasNormalized ? '.ogg' : path.extname(item.filename).toLowerCase();
  const stat = await fse.stat(item.hasNormalized ? normalizedFilepath : filepath);

  switch (ext) {
    case '.mp3':
      reply.header('x-content-type', 'audio/mpeg3');
      break;

    case '.ogg':
    case '.oga':
      reply.header('x-content-type', 'audio/ogg');
      break;

    case '.webm':
      reply.header('x-content-type', 'audio/webm');
      break;
  }

  reply.header('accept-ranges', 'bytes');
  reply.header('x-content-length', String(stat.size));
  reply.header('x-filename', encodeURIComponent(baseFilename));
  reply.header('x-is-normalized', item.hasNormalized ? '1' : '0');
  reply.status(204);

  item.ensureNormalized();
});

app.get('/items/:id', async (request, reply) => {
  const referrer = request.headers.referer || request.headers.referrer;
  if (typeof referrer !== 'string') {
    reply.status(403);
    return 'Forbidden';
  }

  const host = referrer.split('://', 2).reverse()[0].split('/', 1)[0];
  if (!host) {
    console.error('host?', referrer, host);
    reply.status(500);
    return 'Internal Server Error';
  }

  if (!Config.Frontend.AllowedHosts.includes(host)) {
    reply.status(403);
    return 'Forbidden';
  }

  const id = request.params.id;
  const item = await getRepository(Item).findOneOrFail(id, {
    select: ['id', 'filename', 'state', 'hasNormalized'],
  });

  if (!item.filename) {
    withScope(scope => {
      scope.setFingerprint(['ITEM_REQUEST', 'FILENAME_DOES_NOT_EXIST']);
      scope.setExtra('itemId', item.id);
      scope.setExtra('filename', item.filename);

      captureEvent({
        message: '파일이 존재하지 않음',
        level: Severity.Warning,
      });
    });

    reply.status(404);
    return 'Not Found';
  }

  const baseFilename = path.basename(item.filename);
  const normalizedFilename = baseFilename.replace(path.extname(baseFilename), '') + '.ogg';
  const normalizedFilepath = path.join(Config.DownloadPath, 'normalized', normalizedFilename);

  if (item.hasNormalized && !(await fse.pathExists(normalizedFilepath))) {
    item.hasNormalized = false;
    await getRepository(Item).update({ id: item.id }, { hasNormalized: false });
    console.info('normalized file does not exist', normalizedFilepath);
  }

  const filepath = path.join(Config.DownloadPath, item.filename);
  const ext = item.hasNormalized ? '.ogg' : path.extname(item.filename).toLowerCase();
  const stat = await fse.stat(item.hasNormalized ? normalizedFilepath : filepath);

  const stream = createReadStream(item.hasNormalized ? normalizedFilepath : filepath);

  switch (ext) {
    case '.mp3':
      reply.type('audio/mpeg3');
      break;

    case '.ogg':
    case '.oga':
      reply.type('audio/ogg');
      break;

    case '.webm':
      reply.type('audio/webm');
      break;
  }

  reply.header('accept-ranges', 'bytes');
  reply.header('content-length', String(stat.size));
  reply.header('content-transfer-encoding', 'chunked');
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.hasNormalized ? normalizedFilename : baseFilename)}`);
  reply.header('x-is-normalized', item.hasNormalized ? '1' : '0');
  reply.send(stream);

  item.ensureNormalized();
});

app.post('/slack/events', async (request, reply) => {
  const { challenge } = request.body;
  if (challenge) {
    return { challenge };
  }

  const {
    event: {
      type: eventType,
      user: userId,
      item,
      reaction,
      item_user: itemUser,
    },
    authed_users: mentionedUsers,
  } = request.body;

  if (!item) {
    return;
  }

  const {
    type: itemType,
    channel: channelId,
    ts,
  } = item;

  if (userId === Config.Slack.BotUserId) {
    return {};
  }

  const channel = getChannelByChannelId(channelId);
  if (!channel) {
    return {};
  }

  if (eventType !== 'reaction_added') {
    return {};
  }

  if (reaction === 'x') {
    const playlistItem = await getCustomRepository(PlaylistItemRepository).getPlaylistItemBySlackNotificationId('queued', ts);
    if (!playlistItem) {
      return {};
    }

    if (!playlistItem.addedAutomatically && playlistItem.userId !== userId) {
      return {};
    }

    if (playlistItem.isDeleted) {
      return {};
    }

    if (playlistItem.state !== PlaylistItemState.NotPlayedYet) {
      return {};
    }

    const item = await getRepository(Item).findOne(playlistItem.itemId);
    if (!item) {
      // ?
      return {};
    }

    playlistItem.isDeleted = true;
    await getRepository(PlaylistItem).save(playlistItem);

    slack.reactions.remove({
      token: Config.Slack.BotUserAccessToken,
      channel: channelId,
      name: 'oki',
      timestamp: ts,
    }).catch(() => { });
    slack.reactions.add({
      token: Config.Slack.BotUserAccessToken,
      channel: channelId,
      name: 'x',
      timestamp: ts,
    }).catch(() => { });

    slack.chat.update({
      token: Config.Slack.BotUserAccessToken,
      channel: channelId,
      ts,
      text: `:rip: *[플레이리스트]* <@${userId}>님이 ${playlistItem.addedAutomatically ? '자동으로 등록된 ' : ''}신청곡(<${item.link}|${item.title}>)을 취소했어요.`,
      unfurl_links: false,
      unfurl_media: false,
    });

    redis.publish(`bgm:channels:${channel.key}:events`, JSON.stringify({
      channel: playlistItem.channel,
      event: 'playlistUpdated',
      updatedBy: '',
    }));
  } else if (reaction?.startsWith('heart')) {
    let playlistItem = await getCustomRepository(PlaylistItemRepository).getPlaylistItemBySlackNotificationId('queued', ts);
    if (!playlistItem) {
      playlistItem = await getCustomRepository(PlaylistItemRepository).getPlaylistItemBySlackNotificationId('nowPlaying', ts);
    }

    if (!playlistItem) {
      return {};
    }

    if ((await getRepository(Like).count({ userId, playlistItemId: playlistItem.id })) > 0) {
      return {};
    }

    const item = await getRepository(Item).findOneOrFail({ id: playlistItem.itemId });
    const like = getRepository(Like).create({
      userId,
      playlistItemId: playlistItem.id,
      itemId: playlistItem.itemId,
    });
    await getRepository(Like).save(like);

    withScope(scope => {
      scope.setFingerprint(['LIKE']);
      scope.setExtras({
        itemId: item.id,
        playlistItemId: playlistItem?.id,
        by: userId,
      });

      captureEvent({
        message: `좋아요 (${item.title} by ${userId})`,
        level: Severity.Log,
      });
    });
  }

  return {};
});

app.post('/slack/interactives', async (request, reply) => {
  const { payload } = request.body;
  const body = JSON.parse(payload);

  const {
    type,
    response_url,
    user: {
      id: userId,
      username,
      name,
    },
    channel: {
      id: channelId,
    },
  } = body;

  const user = await getCustomRepository(UserRepository).getOrCreate(userId, {
    username,
    name,
  });

  const channel = getChannelByChannelId(channelId);
  if (!channel) {
    reply.code(400);
    return {};
  }

  // TODO: refactor
  if (type === 'interactive_message') {
    const {
      callback_id: callbackId,
      actions,
    } = body;

    console.info('callbackId', callbackId);
    switch (callbackId) {
      case 'setVolume': {
        const [{
          name,
          type,
          value,
        }] = actions;
        assert.equal(name, 'volume');
        const req = JSON.parse(value) as {
          volume: number;
          channel: string;
          user: string;
        };
        assert.equal(req.channel, channel.key);
        assert.equal(req.user, userId);

        redis.publish(`bgm:channels:${channel.key}:events`, JSON.stringify({
          channel: channel.key,
          event: 'volumeSetRequested',
          volume: req.volume,
        }));

        // 선택 메시지 지우기
        client.post(response_url, {
          response_type: 'ephemeral',
          text: '',
          replace_original: true,
          delete_original: true,
        }).catch(() => { });

        await bluebird.delay(800);

        const token = uuid.v4();
        redis.publish(`bgm:channels:${channel.key}:events`, JSON.stringify({
          channel: channel.key,
          event: 'getCurrentVolume',
          token,
        }));

        for (let i = 0; i < 10; i++) {
          const info = await redis.brpop([`bgm:channels:${channel.key}:volumes:${token}`], 1);
          if (info === null) {
            continue;
          }

          const [, volumeString] = info;
          const volume = Number(volumeString);

          if (!isNaN(volume)) {
            slack.chat.postMessage({
              token: Config.Slack.BotUserAccessToken,
              channel: channel.info.id,
              text: `*[볼륨 조정]* <@${userId}>님이 볼륨을 ${volume * 100}%로 설정했어요.`,
            });
          }
          break;
        }
      } break;

      default:
        break;
    }

    return ':spinner: 잠시만 기다려주세요!';
  }

  if (type !== 'block_actions') {
    reply.code(400);
    return {};
  }

  const [action] = body.actions ?? [];
  if (action === undefined) {
    reply.code(400);
    return {};
  }

  const { value } = action;
  const parsedValue = JSON.parse(value);

  switch (parsedValue.type) {
    case NotificationType.AddToPlaylist: {
      const { videoId, link } = JSON.parse(value);

      try {
        await getCustomRepository(PlaylistItemRepository).addPlaylistItemFromLink(link, channel.key, userId);

        // 선택 메시지 지우기
        client.post(response_url, {
          response_type: 'ephemeral',
          text: '',
          replace_original: true,
          delete_original: true,
        }).catch(() => { });
      } catch (e) {
        client.post(response_url, {
          response_type: 'ephemeral',
          text: `오류가 발생했어요. 수훈님에게 문의해주세요: ${e?.name} ${e?.message}\n` + '```' + e?.stack + '```',
          replace_original: true,
          delete_original: true,
        }).catch(() => { });

        console.error(e);
        captureException(e);
      }
    } break;

    case NotificationType.AgreeTOS: {
      const today = DateTime.local();
      await getRepository(User).update({ id: user.id }, { TOSAgreedAt: today.toJSDate() });

      // 선택 메시지 지우기
      client.post(response_url, {
        text: `:heavy_check_mark: ${today.toFormat('yyyy-MM-dd HH:mm:ss')}자로 이용약관에 동의하셨습니다.`,
        replace_original: true,
        delete_original: true,
      }).catch(() => { });
    } break;
  }

  reply.code(200);
  return '';
});

app.post('/slack/slash-commands/next', async (request, reply) => {
  const {
    response_url,
    user_id,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user) {
    return '허용되지 않은 사용자인 것 같아요.';
  }

  if (channel.info.superuser !== user_id && !user.allowedChannels.includes(channel.key)) {
    return '권한 부여가 필요합니다. 채널장에게 요청해주세요.';
  }

  const playlist = await getCustomRepository(PlaylistItemRepository).getPlaylist(channel.key, { previousCount: 0, nextCount: 5 });
  if (!playlist.nowPlaying) {
    return '지금 재생 중인 곡이 없어요.';
  }
  if (playlist.nextPlaylistItems.filter(x => !x.isDeleted).length === 0) {
    return '다음에 재생할 곡이 없어요. 플레이리스트에 곡을 먼저 추가해주세요.';
  }

  redis.publish(`bgm:channels:${channel.key}:events`, JSON.stringify({
    channel: channel.key,
    event: 'skipCurrentPlaylistItemRequested',
  }));

  client.post(response_url, {
    response_type: 'in_channel',
    text: `:superspinthink: *[건너뛰기]* <@${user_id}>님이 지금 재생 중인 곡을 넘겼어요.`,
  });

  return '건너뛰기 요청이 전송됐어요.';
});

app.post('/slack/slash-commands/playlist', async (request, reply) => {
  const {
    response_url,
    user_id,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const playlist = await getCustomRepository(PlaylistItemRepository).getPlaylist(channel.key, { previousCount: 0, nextCount: 25 });
  const items = await getRepository(Item).find({
    select: ['id', 'duration', 'link', 'title', 'info'],
    where: {
      id: In([
        ...playlist.previousPlaylistItems.map(x => x?.itemId ?? undefined),
        playlist.nowPlaying ? playlist.nowPlaying.itemId : undefined,
        ...playlist.nextPlaylistItems.map(x => x?.itemId ?? undefined),
      ].filter(x => x !== undefined)),
    },
  });
  const getItem = (id: string) => items.find(x => x.id === id)!;

  const payload = {
    replace_original: true,
    text: [
      `:tada: *[플레이리스트]*`,
      (playlist.nowPlaying ? `지금 재생 중: <${getItem(playlist.nowPlaying.itemId).link}|${getItem(playlist.nowPlaying.itemId).title}> (${getItem(playlist.nowPlaying.itemId).durationString})` : ''),
      ...playlist.nextPlaylistItems.filter(x => !x?.isDeleted).map((playlistItem, index) => {
        const item = getItem(playlistItem!.itemId);

        return `${index + 1}. <${item.link}|${item.title}> (${item.durationString})`;
      }),
    ].join('\n'),
  };
  await client.post(response_url, payload);

  return '';
});

app.post('/slack/slash-commands/maindj', async (request, reply) => {
  const {
    user_id,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user) {
    return '허용되지 않은 사용자인 것 같아요.';
  }

  if (channel.info.superuser !== user_id && !user.allowedChannels.includes(channel.key)) {
    return '권한 부여가 필요합니다. 채널장에게 요청해주세요.';
  }

  const isChannelOwner = user.ownedChannels.includes(channel.key);

  const token = await user.generateAuthToken({
    channelKey: channel.key,
  });
  return {
    text: `<${Config.Frontend.URL}/#token=${token}|:rocket: ${isChannelOwner ? '디제잉' : '플레이리스트'} 바로가기 :rocket:>`,
    mrkdwn_in: ['text'],
  };
});

app.post('/slack/slash-commands/otp', async (request, reply) => {
  const {
    user_id,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user) {
    return '허용되지 않은 사용자인 것 같아요.';
  }

  if (channel.info.superuser !== user_id && !user.allowedChannels.includes(channel.key)) {
    return '권한 부여가 필요합니다. 채널장에게 요청해주세요.';
  }

  const token = await user.generateAuthToken({
    channelKey: channel.key,
  }, '30d');

  const otp = {
    id: String(Math.random() * 10000),
    password: authenticator.generate(token),
  };

  await redis.setex(`bgm:otp:${otp.id}:${otp.password}`, 30, token);
  return {
    text: `[OTP] ID: ${otp.id} / 비밀번호: ${otp.password}`,
    mrkdwn_in: ['text'],
  };
});

app.post('/slack/slash-commands/permit', async (request, reply) => {
  const {
    user_id,
    channel_id,
    text,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user) {
    return '허용되지 않은 사용자인 것 같아요.';
  }

  if (channel.info.superuser !== user_id && !user.ownedChannels.includes(user_id)) {
    return `채널장 또는 메인DJ만 이용할 수 있습니다. (채널장: <@${channel.info.superuser}>)`;
  }

  const usernames = [] as string[];

  let matches: RegExpExecArray;
  const regex = /(@[a-zA-Z0-9]+)/g;
  while ((matches = regex.exec(text)!) !== null) {
    usernames.push(matches[0].replace('@', ''));
  }

  if (usernames.length === 0) {
    return '추가할 사용자를 멘션해주세요.';
  }

  const resp = await slack.users.list({
    token: Config.Slack.BotUserAccessToken,
  });
  const members = resp.members as any[];
  const addedMembers = [] as string[];

  for (const username of usernames) {
    const slackUser = members.find(member => member.name === username || member.id === username);
    if (!slackUser) {
      continue;
    }

    const user = await getCustomRepository(UserRepository).getOrCreate(slackUser.id, {
      name: slackUser.real_name,
      username: slackUser.name,
    });

    if (!user.allowedChannels.includes(channel.key)) {
      user.allowedChannels.push(channel.key);
      await getRepository(User).save(user);

      user.sendDM({
        text: `*[브금 채널 권한 부여]* <#${channel.info.name}> 채널에서 곡을 선곡할 수 있는 권한이 부여되었습니다! (부여자: <@${channel.info.superuser}>)`,
        mrkdwn_in: ['text'],
      }).catch();
      slack.chat.postMessage({
        token: Config.Slack.BotUserAccessToken,
        channel: channel.info.id,
        text: `*[신규 DJ]* <@${user.id}>님도 곡을 선곡할 수 있게 되었어요! :partygopher:`,
      }).catch();

      addedMembers.push(user.username);
    }
  }

  if (addedMembers.length > 0) {
    return addedMembers.map(addedMember => `권한 부여 완료: <@${addedMember}>`).join('\n');
  }

  return ':(';
});

app.post('/slack/slash-commands/trending', async (request, reply) => {
  const {
    response_url,
    trigger_id,
    user_id,
    text,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user || !user.allowedChannels.includes(channel.key)) {
    return '권한 부여가 필요합니다. 채널장에게 요청해주세요!';
  }

  if (user.TOSAgreedAt === null) {
    client.post(response_url, {
      replace_original: false,
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*Google의 서비스 개발 정책에 따라 다음 내용에 동의한 후 서비스를 사용하실 수 있습니다:*\n- <https://www.youtube.com/t/terms|YouTube 이용약관 (YouTube TOS)>\n- <http://www.google.com/policies/privacy|Google 개인정보 보호 정책 (Google Privacy Policy)>",
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*이 서비스는 Google의 <https://developers.google.com/youtube|YouTube API Services>를 사용하고 있습니다. Google에서 제공받는 정보는 다음과 같습니다:*\n- YouTube 동영상 검색 결과: 동영상의 제목(title), 내용(description), 채널(channel), 길이(duration), 미리보기 이미지(thumbnail)\n\n*서비스를 제공하기 위해 Google로부터 제공받은 정보를 다음과 같은 방식으로 사용하고 있습니다:*\n- 영상 없이 오디오만으로 재생 가능한 콘텐츠를 찾기 위해 동영상 길이 정보를 사용하여 필터\n- 검색 결과 표시 (슬랙 메시지)",
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "위 내용에 동의하는 경우 오른쪽에 있는 버튼을 눌러주세요.",
          },
          "accessory": {
            "type": "button",
            "style": "primary",
            "text": {
              "type": "plain_text",
              "text": "동의",
              "emoji": true
            },
            "value": JSON.stringify({
              type: NotificationType.AgreeTOS,
            }),
          },
        },
      ],
    });

    return `:eyes-cute: 이용약관 동의가 필요합니다. 잠시만 기다려주세요!`;
  }

  (async () => {
    const webData = new YouTubeWebData();
    const trendingItems = await webData.getTrendingItems(/음악|music/g);

    if (trendingItems) {
      await client.post(response_url, {
        replace_original: true,
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "emoji": true,
              "text": "원하는 곡을 선택해주세요:"
            }
          },
          ...trendingItems.flatMap((item) => {
            const link = `https://www.youtube.com/watch/${item.videoId}`;
            const durationString = Duration.fromMillis(item.durationSeconds * 1000).toFormat('mm:ss');

            return [
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": `<${link}|*${item.title}*>`
                },
                "accessory": {
                  "type": "image",
                  "image_url": `https://img.youtube.com/vi/${item.videoId}/default.jpg`,
                  "alt_text": item.title,
                }
              },
              {
                "type": "section",
                "text": {
                  "type": "mrkdwn",
                  "text": `${item.publisher} | ${durationString}`,
                },
                "accessory": {
                  "type": "button",
                  "text": {
                    "type": "plain_text",
                    "text": "추가하기",
                    "emoji": true
                  },
                  "value": JSON.stringify({
                    type: NotificationType.AddToPlaylist,
                    videoId: item.videoId,
                    link: link,
                  }),
                },
              },
            ];
          }),
          {
            "type": "context",
            "elements": [
              {
                "type": "mrkdwn",
                "text": "Search results are provided by <https://developers.google.com/youtube/terms/developer-policies#definition-youtube-api-services|YouTube API Services>. By using this service, you agree to the <http://www.google.com/policies/privacy|Google Privacy Policy>."
              }
            ]
          },
        ],
      });
    }
  })();

  return `:eyes-cute: 인기 차트를 가져오고 있어요. 잠시만 기다려주세요!`;
});

app.post('/slack/slash-commands/search', async (request, reply) => {
  const {
    response_url,
    trigger_id,
    user_id,
    text,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user || !user.allowedChannels.includes(channel.key)) {
    return '권한 부여가 필요합니다. 채널장에게 요청해주세요!';
  }

  if (user.TOSAgreedAt === null) {
    client.post(response_url, {
      replace_original: false,
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*Google의 서비스 개발 정책에 따라 다음 내용에 동의한 후 서비스를 사용하실 수 있습니다:*\n- <https://www.youtube.com/t/terms|YouTube 이용약관 (YouTube TOS)>\n- <http://www.google.com/policies/privacy|Google 개인정보 보호 정책 (Google Privacy Policy)>",
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "*이 서비스는 Google의 <https://developers.google.com/youtube|YouTube API Services>를 사용하고 있습니다. Google에서 제공받는 정보는 다음과 같습니다:*\n- YouTube 동영상 검색 결과: 동영상의 제목(title), 내용(description), 채널(channel), 길이(duration), 미리보기 이미지(thumbnail)\n\n*서비스를 제공하기 위해 Google로부터 제공받은 정보를 다음과 같은 방식으로 사용하고 있습니다:*\n- 영상 없이 오디오만으로 재생 가능한 콘텐츠를 찾기 위해 동영상 길이 정보를 사용하여 필터\n- 검색 결과 표시 (슬랙 메시지)",
          }
        },
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": "위 내용에 동의하는 경우 오른쪽에 있는 버튼을 눌러주세요.",
          },
          "accessory": {
            "type": "button",
            "style": "primary",
            "text": {
              "type": "plain_text",
              "text": "동의",
              "emoji": true
            },
            "value": JSON.stringify({
              type: NotificationType.AgreeTOS,
            }),
          },
        },
      ],
    });

    return `:eyes-cute: 이용약관 동의가 필요합니다. 잠시만 기다려주세요!`;
  }

  (async () => {
    const results = await search(text, {
      sources: ['item', 'youtube'],
      maxResults: 5,
      maxDuration: 400,
    });

    if (results) {
      await client.post(response_url, {
        replace_original: true,
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "plain_text",
              "emoji": true,
              "text": "원하는 곡을 선택해주세요:"
            }
          },
          ...results.flatMap((item) => [
            {
          "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `<${item.link}|*${item.title}*>\n${item.description}`
              },
              "accessory": {
                "type": "image",
                "image_url": item.thumbnailUrl,
                "alt_text": item.title,
              }
            },
            {
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": `${item.channelTitle} | ${item.durationString}`,
              },
              "accessory": {
                "type": "button",
                "text": {
                  "type": "plain_text",
                  "text": "추가하기",
                  "emoji": true
                },
                "value": JSON.stringify({
                  type: NotificationType.AddToPlaylist,
                  videoId: item.videoId,
                  link: item.link,
                }),
              },
            },
          ]),
          {
            "type": "context",
            "elements": [
              {
                "type": "mrkdwn",
                "text": "Search results are provided by <https://developers.google.com/youtube/terms/developer-policies#definition-youtube-api-services|YouTube API Services>. By using this service, you agree to the <http://www.google.com/policies/privacy|Google Privacy Policy>."
              }
            ]
          },
        ],
      });
    }
  })();

  return `:eyes-cute: "${text}"(으)로 찾아보고 있어요. 잠시만 기다려주세요!`;
});

app.post('/slack/slash-commands/volume', async (request, reply) => {
  const {
    response_url,
    trigger_id,
    user_id,
    text,
    channel_id,
  } = request.body;

  const channel = getChannelByChannelId(channel_id);
  if (!channel) {
    return '지원하지 않는 채널입니다.';
  }

  const user = await getRepository(User).findOne(user_id);
  if (!user || !user.allowedChannels.includes(channel.key)) {
    return '권한 부여가 필요합니다. 채널장에게 요청해주세요!';
  }

  const token = uuid.v4();
  redis.publish(`bgm:channels:${channel.key}:events`, JSON.stringify({
    channel: channel.key,
    event: 'getCurrentVolume',
    token,
  }));

  (async () => {
    for (let i = 0; i < 10; i++) {
      const info = await redis.brpop([`bgm:channels:${channel.key}:volumes:${token}`], 1);
      if (info === null) {
        continue;
      }

      const [, volumeString] = info;
      const volume = Number(volumeString);

      if (!isNaN(volume)) {
        const vol = Math.round(volume * 10);
        // 가장 가까운 숫자 5개
        const candidates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(n => n !== vol).sort((a, b) => Math.abs(vol - a) - Math.abs(vol - b)).filter((_, index) => index < 5).sort((a, b) => a - b);

        client.post(response_url, {
          response_type: 'ephemeral',
          text: `현재 볼륨은 ${volume * 100}% 입니다. 얼마 정도로 조정할까요?`,
          attachments: [
            {
              text: '',
              callback_id: 'setVolume',
              actions: [
                ...candidates.map((i) => ({
                  name: 'volume',
                  text: `${i * 10}%`,
                  type: 'button',
                  value: JSON.stringify({
                    volume: i / 10,
                    channel: channel.key,
                    user: user.id,
                  }),
                })),
              ],
            },
          ],
        });

        return;
      }
    }

    client.post(response_url, {
      response_type: 'ephemeral',
      text: ':crying: 볼륨 정보를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.',
      replace_original: true,
    }).catch(() => { });
  })();

  return ':spinner: 현재 볼륨을 가져오고 있습니다. 잠시만 기다려주세요!';
});

async function main() {
  await initConnection();

  await redis.ping();

  app.listen(3200, (err, address) => {
    if (err) {
      throw err;
    }

    app.log.info(`server listening on ${address}`);
  });
}

main();
