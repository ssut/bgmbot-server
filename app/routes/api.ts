import { sha512 } from './../utils/hash';
import { YouTube } from './../utils/youtube';
import { captureException, withScope, Scope, captureEvent, Severity } from '@sentry/node';
import { Item } from './../entities/item.entity';
import { Duration } from 'luxon';
import { PlaylistItemState } from './../entities/playlist-item.entity';
import { In, getConnection, Raw } from 'typeorm';
import { createHandyClient } from 'handy-redis';
import { serialize } from 'class-transformer';
import 'fastify-websocket';

import { FastifyInstance, FastifyRequest } from 'fastify';
import websocketPlugin = require('fastify-websocket');
import jwt from 'jsonwebtoken';

import Config from '../config';
import { User } from '../entities/user.entity';
import { getChannel } from '../utils';
import { Repository, slack, redis } from './../common';
import { IReply, IRequest, RequestType, EventType, PlayerProgress } from './api.interface';
import { PlaylistItem } from '../entities/playlist-item.entity';
import { Job } from 'bee-queue';
import { DownloadTaskQueue, IDownloadTaskPayload } from '../queue';
import { search } from './../utils/search';
import * as ytdl from 'ytdl-core-new';

const subscribeClient = redis.redis.duplicate();

Object.keys(Config.Channels).map(channel => {
  subscribeClient.subscribe(`bgm:channels:${channel}:events`);
});

class SessionManager {
  private static client = createHandyClient();

  public static getChannelSessionId(channel: string) {
    return this.client.get(`bgm:channels:${channel}:sessionId`);
  }

  public static async setChannelSessionId(channel: string, sessionId: string) {
    const key = `bgm:channels:${channel}:sessionId`;
    const multi = this.client.multi()
      .set(key, sessionId)
      .expire(key, 10);

    await this.client.execMulti(multi);
  }

  public static async extendChannelSessionId(channel: string) {
    return this.client.expire(`bgm:channels:${channel}:sessionId`, 10);
  }
}

class ConnectionHandler {
  private user!: User;
  private channel!: ReturnType<typeof getChannel>;
  private channelKey!: string;
  private sessionId!: string;

  private onRedisMessageCallback: any;

  private youtube: YouTube;

  public constructor(
    private connection: websocketPlugin.SocketStream,
    private request: FastifyRequest,
  ) {
    this.connection.setDefaultEncoding('utf8');
    this.connection.setEncoding('utf8');
    this.connection.on('data', this.onMessage.bind(this));
    this.connection.on('close', this.dispose.bind(this));
    this.connection.on('end', this.dispose.bind(this));

    this.onRedisMessageCallback = this.onRedisMessage.bind(this);
    subscribeClient.on('message', this.onRedisMessageCallback);
    console.info('connection handle attached', 'remaining listener count', subscribeClient.listenerCount('message'));

    if (request.ip === undefined) {
      request.ip = connection.socket?.remoteAddress || request.headers['x-real-ip'] || request.headers['x-forwarded-for'];
    }

    this.youtube = new YouTube();

    this.connection.write(Buffer.from(JSON.stringify({ ready: true })));
    console.info('Client Hello ({ ready: true })');
  }

  public withConfiguredSentryScope(fn: (scope: Scope) => void) {
    withScope(scope => {
      scope.setUser({
        id: this.user?.id,
        username: this.user?.username,
        ip_address: this.request.ip,
      });
      scope.setExtra('ip_addresses', this.request.ips);
      scope.setExtra('headers', this.request.headers);
      scope.setTags({
        channel: this.channelKey,
        sessonId: this.sessionId,
      });

      fn(scope);
    });
  }

  public async checkIfPlayer(): Promise<boolean> {
    if (!this.isChannelOwner) {
      return false;
    }

    const channelSessionId = await SessionManager.getChannelSessionId(this.channelKey);
    return (typeof channelSessionId === 'string' && channelSessionId === this.sessionId);
  }

  public get isChannelOwner() {
    if (!this.channelKey) {
      return false;
    }

    return this.user.ownedChannels.includes(this.channelKey);
  }

  public dispose() {
    subscribeClient.removeListener('message', this.onRedisMessageCallback);
    console.info('connection handler disposes', 'remaining listener count', subscribeClient.listenerCount('message'));
  }

  public async onRedisMessage(channel: string, message: string) {
    if (channel !== `bgm:channels:${this.channelKey}:events`) {
      return;
    }

    const data = JSON.parse(message);
    if (!data.event) {
      return;
    }

    switch (data.event) {
      case 'created':
        this.onPlaylistItemCreated({ id: data.id });
        break;

      case 'downloaded':
        this.onItemDownloaded({ id: data.id });
        break;

      case 'getCurrentVolume':
        if (await this.checkIfPlayer()) {
          this.send({
            ts: -1,
            ok: true,
            content: {
              event: EventType.VolumeRequested,
              token: data.token,
            },
          });
        }
        break;

      case 'playlistUpdated':
        if (this.sessionId !== data.updatedBy) {
          this.send({
            ts: -1,
            ok: true,
            content: {
              event: EventType.PlaylistUpdated,
            },
          });
        }
        break;

      case 'playerProgressUpdated':
        if (!(await this.checkIfPlayer())) {
          this.send({
            ts: -1,
            ok: true,
            content: {
              event: EventType.PlayerProgressUpdated,
              progress: data.progress,
            },
          });
        }
        break;

      case 'volumeSetRequested':
        if (await this.checkIfPlayer()) {
          this.send({
            ts: -1,
            ok: true,
            content: {
              event: EventType.VolumeSetRequested,
              volume: data.volume,
            },
          });
        }
        break;
    }
  }

  public onPlaylistItemCreated({ id }: { id: number }) {
    try {
      this.send({
        ts: -1,
        ok: true,
        content: {
          event: EventType.PlaylistItemCreated,
          id,
        },
      });
    } catch { }
  }

  public onItemDownloaded({ id }: { id: number }) {
    try {
      this.send({
        ts: -1,
        ok: true,
        content: {
          event: EventType.ItemDownloaded,
          id,
        },
      });
    } catch { }
  }

  public onPlayerProgressUpdated({ progress }: { progress: PlayerProgress }) {

  }

  public send(reply: IReply) {
    this.connection.write(serialize(reply));
  }

  public get isAuthenticated() {
    return this.user && this.channel;
  }

  public ensureChannelOwner() {
    if (!this.isChannelOwner) {
      throw new Error('채널장만 이용할 수 있습니다.');
    }
  }

  public async ensurePlayer() {
    if (!(await this.checkIfPlayer())) {
      throw new Error('플레이어만 이용할 수 있습니다.');
    }
  }

  public async onMessage(raw: any) {
    const message = JSON.parse(raw) as IRequest;
    if (!message.ts || !message.type || message.data === undefined) {
      return;
    }

    const timeDifference = Date.now() - message.ts;

    if (this.sessionId !== message.sessionId) {
      this.sessionId = message.sessionId;
    }

    const isPlayer = await this.checkIfPlayer();
    if (this.isChannelOwner && !isPlayer) {
    } else if (message.type !== RequestType.Authenticate && this.channelKey && isPlayer) {
      await SessionManager.extendChannelSessionId(this.channelKey);
    }

    ![
      RequestType.Ping,
      RequestType.BroadcastProgress,
      RequestType.GetAutoCompletionKeywords,
    ].includes(message.type) && console.info(this.sessionId, `isPlayer: ${isPlayer}, isChannelOwner: ${this.isChannelOwner}`, message, {
      timeDifference,
    });

    let response: any = null;
    const startedAt = Date.now();
    let endedAt: number;
    try {
      switch (message.type) {
        case RequestType.Ping:
          response = {};
          break;

        case RequestType.Authenticate:
          response = await this.authenticate(message.token);
          break;

        case RequestType.GetPlaylist:
          response = await this.getPlaylist();
          break;

        case RequestType.GetPlaylistItemsById:
          response = await this.getPlaylistItemsById(message.data);
          break;

        case RequestType.MovePlaylistItem:
          this.ensureChannelOwner();
          response = await this.movePlaylistItem(message.data);
          break;

        case RequestType.SetIsPlaying:
          await this.ensurePlayer();
          response = await this.setIsPlaying(message.data);
          break;

        case RequestType.AddRelatedVideos:
          response = await this.addRelatedVideos(message.data.itemId, message.data.count, message.data.excludingVideoIdCandidates ?? []);
          break;

        case RequestType.DeletePlaylistItem:
          this.ensureChannelOwner();
          response = await this.deletePlaylistItem(message.data.playlistItemId);
          break;

        case RequestType.SearchRelatedVideos:
          response = await this.searchRelatedVideos(message.data.itemId);
          break;

        case RequestType.AddPlaylistItem:
          response = await this.addPlaylistItemFromLink(message.data.link);
          break;

        case RequestType.BroadcastProgress:
          await this.ensurePlayer();
          response = await this.broadcastProgress(message.data.progress);
          break;

        case RequestType.ReturnVolume:
          await this.ensurePlayer();
          response = await this.returnVolume(message.data);
          break;

        case RequestType.Search:
          response = await this.search(message.data.keyword);
          break;

        case RequestType.GetAutoCompletionKeywords:
          response = await this.getAutoCompletionKeywords(message.data.keyword, 5);
          break;
      }

      endedAt = Date.now();
    } catch (e) {
      endedAt = Date.now();
      console.error(e);
      this.withConfiguredSentryScope(scope => {
        scope.setExtra('took', endedAt - startedAt);
        scope.setExtras({
          message,
        });

        captureException(e);
      });

      this.send({
        ok: false,
        ts: message.ts,
        content: e.message,
      });
    }

    if (response) {
      this.send({
        ok: true,
        ts: message.ts,
        content: response,
      });
    }
  }

  public async authenticate(token: string) {
    const { userId, channelKey } = (await jwt.verify(token, Config.Jwt.Secret)) as any;

    const user = await Repository.User.findOneOrFail(userId);
    const channel = getChannel(channelKey);
    if (!channel) {
      throw new Error(`${channel} channel does not exist.`);
    }

    this.channelKey = channelKey;
    this.user = user;
    this.channel = channel;

    if ((await SessionManager.getChannelSessionId(this.channelKey)) === null) {
      console.info('grant player', this.channelKey, this.sessionId);
      await SessionManager.setChannelSessionId(this.channelKey, this.sessionId);
    }

    const isPlayer = await this.checkIfPlayer();

    this.withConfiguredSentryScope(scope => {
      scope.setFingerprint(['API', 'authenticate']);

      scope.setTag('isPlayer', String(isPlayer));
      scope.setTag('isChannelOwner', String(this.isChannelOwner));

      captureEvent({
        message: 'API 인증',
        level: Severity.Log,
      });
    });

    console.info(`Authenticated ${user.username} (for channel ${channelKey}, isChannelOwner: ${this.isChannelOwner}, isPlayer: ${isPlayer})`);
    return { user, channel, isChannelOwner: this.isChannelOwner, isPlayer };
  }

  public async getPlaylistItemsById(ids: number[]) {
    if (ids.length === 0) {
      return [];
    }

    const playlistItems = await Repository.PlaylistItem.find({
      where: {
        id: In(ids),
      },
      order: {
        id: 'ASC',
      },
      relations: ['item'],
    });

    return playlistItems;
  }

  public async getPlaylist() {
    const playlist = await PlaylistItem.getPlaylist(this.channelKey, {
      previousCount: 25,
      nextCount: 200,
    });
    if (playlist.nextPlaylistItems.length === 0 && playlist.previousPlaylistItems.length === 0 && !playlist.nowPlaying) {
      return playlist;
    }

    const items = await Repository.Item.find({
      where: {
        id: In([
          ...playlist.previousPlaylistItems.map(x => x?.itemId ?? undefined),
          playlist.nowPlaying ? playlist.nowPlaying.itemId : undefined,
          ...playlist.nextPlaylistItems.map(x => x?.itemId ?? undefined),
        ].filter(x => x !== undefined)),
      },
    });
    const getItem = (id: string) => items.find(x => x.id === id)!;

    [
      ...playlist.previousPlaylistItems,
      playlist.nowPlaying,
      ...playlist.nextPlaylistItems,
    ].forEach(playlistItem => {
      if (playlistItem) {
        playlistItem.item = getItem(playlistItem.itemId);
      }
    });

    return playlist;
  }

  public async deletePlaylistItem(playlistItemId: number) {
    const playlistItem = await Repository.PlaylistItem.findOneOrFail(playlistItemId, {
      select: ['isDeleted'],
    });

    if (playlistItem.isDeleted) {
      throw new Error('이미 삭제된 곡입니다.');
    }

    await Repository.PlaylistItem.update(playlistItemId, { isDeleted: true });
    redis.publish(`bgm:channels:${this.channelKey}:events`, JSON.stringify({
      channel: this.channelKey,
      event: 'playlistUpdated',
      updatedBy: this.sessionId,
    }));

    return true;
  }

  public async movePlaylistItem(payload: any) {
    const { id, moveBefore } = payload;

    const playlist = await Repository.PlaylistItem.findOneOrFail(id);

    try {
      return await playlist.moveBefore(moveBefore);
    } finally {
      redis.publish(`bgm:channels:${this.channelKey}:events`, JSON.stringify({
        channel: this.channelKey,
        event: 'playlistUpdated',
        updatedBy: this.sessionId,
      }));
    }
  }

  public async setIsPlaying(payload: any) {
    const { id } = payload;

    const playlistItem = await Repository.PlaylistItem.findOneOrFail({
      select: ['id', 'itemId', 'channel', 'state', 'userId', 'addedAutomatically'],
      relations: ['item', 'user'],
      where: {
        id,
      },
    });

    await getConnection().transaction(async (entityManager) => {
      await entityManager.update(PlaylistItem, {
        state: PlaylistItemState.NowPlaying,
        channel: this.channelKey,
      }, {
        state: PlaylistItemState.Played,
      });
      await entityManager.update(PlaylistItem, { id }, { state: PlaylistItemState.NowPlaying });
    });

    const duration = Duration.fromMillis(Number(playlistItem.item.duration || playlistItem.item.durationFromInfo) * 1000).toFormat('mm:ss');

    if (playlistItem.state !== PlaylistItemState.NowPlaying) {
      try {
        const resp = await slack.chat.postMessage({
          token: Config.Slack.BotUserAccessToken,
          channel: this.channel.id,
          text: `:rocket: *[지금 재생 중]* <${playlistItem.item.link}|${playlistItem.item.title}> (${duration}${playlistItem.user && !playlistItem.addedAutomatically ? `, ${playlistItem.user?.readableName}님의 선곡` : ', 자동으로 추가됨'})`,
          unfurl_links: false,
          unfurl_media: false,
        });
        const qb = Repository.PlaylistItem.createQueryBuilder();
        await qb
          .update()
          .set({
            slackNotificationIds: () => `jsonb_set("slackNotificationIds", '{nowPlaying}', '${qb.escape(resp.ts)}')`,
          })
          .where('id = :id', { id })
          .execute();
      } catch (e) {
        console.error(e);
        captureException(e);
      }
    }

    redis.publish(`bgm:channels:${playlistItem.channel}:events`, JSON.stringify({
      channel: playlistItem.channel,
      event: 'playlistUpdated',
      updatedBy: this.sessionId,
    })).then((count) => console.info('playlistUpdated received ', count));

    return true;
  }

  public async addRelatedVideos(itemId: number, count = 1, excludingVideoIdCandidates: string[] = []) {
    const rootItem = await Repository.Item.findOneOrFail(itemId);
    const relateds = rootItem.getRelatedVideosAsItem(count, 'serial', excludingVideoIdCandidates);
    if (relateds.length === 0) {
      return [];
    }

    const added = [] as PlaylistItem[];
    for (const related of relateds) {
      const { link } = related;
      const item = await getConnection().createQueryBuilder()
        .insert()
        .into(Item)
        .values(related)
        .onConflict('("videoId") DO UPDATE SET "videoId" = EXCLUDED."videoId"')
        .returning('*')
        .execute()
        .then(executeResult => Repository.Item.create(executeResult.generatedMaps[0]));
      const isItemCreated = Number(item.createdAt) === Number(item.updatedAt);

      const playlistItem = await getConnection().transaction(async (entityManager) => {
        const updateResult = await entityManager.createQueryBuilder()
          .useTransaction(true)
          .update(PlaylistItem, {})
          .where(`
            "id" = (
              SELECT "id"
              FROM "playlist_item"
              WHERE "channel" = :channel
                AND "nextPlaylistItemId" is NULL
              ORDER BY "id" DESC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
          `, { channel: this.channelKey })
          .returning('*')
          .execute();

        let lastPlaylistItemId: number | null = null;
        if (updateResult && (updateResult.affected || 0) > 0 && updateResult.raw.length > 0) {
          lastPlaylistItemId = updateResult.raw[0].id;
        }

        const playlistItem = Repository.PlaylistItem.create({
          channel: this.channelKey,
          itemId: item.id,
          userId: this.user.id,
          isFirstItem: false,
          addedAutomatically: true,
        });
        const result = await entityManager.insert(PlaylistItem, playlistItem);

        if (lastPlaylistItemId) {
          await entityManager.update(PlaylistItem, { id: lastPlaylistItemId }, {
            nextPlaylistItemId: playlistItem.id,
          });
          console.info('updated');
        }

        redis.publish(`bgm:channels:${playlistItem.channel}:events`, JSON.stringify({
          channel: playlistItem.channel,
          event: 'created',
          id: playlistItem.id,
        }));

        return playlistItem;
      });

      let downloadTaskJob: Job | undefined;
      if (isItemCreated || !item.filename) {
        downloadTaskJob = DownloadTaskQueue.createJob<IDownloadTaskPayload>({
          itemId: item.id,
          playlistItemId: playlistItem.id,
        });
      } else {
        playlistItem.isReady = true;
        await Repository.PlaylistItem.save(playlistItem);
      }

      const info = await ytdl.getInfo(link);
      const resp = await slack.chat.postMessage({
        token: Config.Slack.BotUserAccessToken,
        channel: this.channel.id,
        text: `:robot_face: *[플레이리스트]* 「<${rootItem.link}|${rootItem.title}>」의 연관곡 「<${link}|${info.title}>」이 자동으로 추가되었어요!`,
        mrkdwn_in: ['text'],
        unfurl_links: false,
        unfurl_media: false,
      });

      await Repository.Item.update(item.id, {
        info: { ...info } as any,
        title: info.title,
      });

      playlistItem.slackNotificationIds.queued = resp.ts;
      await Repository.PlaylistItem.save(playlistItem);
      if (downloadTaskJob) {
        await downloadTaskJob.save();
      } else {
        slack.reactions.add({
          token: Config.Slack.BotUserAccessToken,
          channel: this.channel.id,
          timestamp: resp.ts,
          name: 'oki',
        }).catch(() => { });
      }

      added.push(playlistItem);
    }

    return added;
  }

  public async searchRelatedVideos(itemId: number) {
    const item = await Repository.Item.findOneOrFail(itemId);
    const relateds = item.getRelatedVideosAsItem(8);

    return relateds;
  }

  public async addPlaylistItemFromLink(link: string) {
    return PlaylistItem.addPlaylistItemFromLink(link, this.channelKey, this.user.id);
  }

  public async broadcastProgress(progress: PlayerProgress) {
    await redis.publish(`bgm:channels:${this.channelKey}:events`, JSON.stringify({
      channel: this.channelKey,
      event: 'playerProgressUpdated',
      progress,
    }));

    return true;
  }

  public async returnVolume({ volume, token }: { volume: number; token: string }) {
    await redis.rpush(`bgm:channels:${this.channelKey}:volumes:${token}`, String(volume));
    return true;
  }

  public async search(keyword: string) {
    const result = await search(keyword, {
      sources: ['item', 'youtube'],
      maxResults: 5,
      maxDuration: 500,
    });
    return result;
  }

  public async getAutoCompletionKeywords(keyword: string, limit = 5) {
    const keywordHash = sha512(keyword);
    const cacheKey = `bgm:suggestions:${keywordHash}`;

    if (await redis.exists(cacheKey)) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const results = await this.youtube.getSuggestionsByKeyword(keyword).then((results) => results.map(x => x.suggestion)).catch((e) => {
      console.error(e);
      this.withConfiguredSentryScope(scope => {
        captureException(e);
      });

      return [];
    });

    if (results.length > 0) {
      await redis.set(cacheKey, JSON.stringify(results));
      await redis.expire(cacheKey, 172800);
    }

    return results.splice(0, limit);
  }
}

export default async function (app: FastifyInstance) {
  app.get('/api', { websocket: true }, (connection, req) => {
    const connectionHandler = new ConnectionHandler(connection, req);
  });
};
