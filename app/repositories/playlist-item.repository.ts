import { Job } from 'bee-queue';
import { Duration } from 'luxon';
import { EntityRepository, Not, Repository } from 'typeorm';
import * as ytdl from 'ytdl-core-new';

import Config from '@app/config';
import { Item } from '@entities/item.entity';
import { redis, slack } from '@app/common';
import { IPlaylistItemSlackNotificationIds, PlaylistItem, PlaylistItemState } from '@entities/playlist-item.entity';
import { DownloadTaskQueue, IDownloadTaskPayload } from '@app/queue';
import { getChannel } from '@app/utils';
import { ItemRepository } from './item.repository';

@EntityRepository(PlaylistItem)
export class PlaylistItemRepository extends Repository<PlaylistItem> {
  private get connection() {
    return this.manager.connection;
  }

  private get itemRepository() {
    return this.connection.getCustomRepository(ItemRepository);
  }

  public async getPlaylistItemBySlackNotificationId(key: keyof IPlaylistItemSlackNotificationIds, notificationId: string) {
    return this.createQueryBuilder()
      .select()
      .where('"slackNotificationIds"->>:key = :notificationId', { key, notificationId })
      .getOne();
  }

  public async checkIfFresh(channel: string) {
    const [result] = await this.createQueryBuilder()
      .select(`COUNT(CASE WHEN (b.state != 'NOT_PLAYED_YET') THEN 1 ELSE null END) as "count"`)
      .from((subQuery) =>
        subQuery
          .select('COUNT(distinct p.state), p.state')
          .from(PlaylistItem, 'p')
          .groupBy('p.state')
          .addGroupBy('p.channel')
          .having('p.channel = :channel', { channel })
        , 'b')
      .execute();

    return Number(result?.count) === 0;
  }


  public async getPlaylist(channel: string, options: Partial<{ previousCount: number; nextCount: number }> = { previousCount: 20, nextCount: 20 }) {
    const isFresh = await this.checkIfFresh(channel);
    if (isFresh) {
      // nextPlaylistId가 없는 것이 첫번째 곡
      const firstPlaylistItem = await this.findOne({
        where: {
          channel,
          isFirstItem: true,
        },
      });
      if (!firstPlaylistItem) {
        return {
          previousPlaylistItems: [],
          nextPlaylistItems: [],
          nowPlaying: null,
        };
      }

      return {
        previousPlaylistItems: [],
        nextPlaylistItems: [
          ...(
            firstPlaylistItem?.state === PlaylistItemState.NotPlayedYet
              ? [firstPlaylistItem]
              : []
          ),
          ...await firstPlaylistItem.getAdjacentPlaylistItems('next', { limit: options.nextCount }),
        ],
        nowPlaying: firstPlaylistItem.state === PlaylistItemState.NowPlaying ? firstPlaylistItem : null,
      };
    }

    let target: PlaylistItem | null = null;
    const nowPlaying = await this.findOne({ channel, state: PlaylistItemState.NowPlaying });
    if (nowPlaying) {
      target = nowPlaying;
    } else {
      const candidate = await this.findOne({ channel, state: Not(PlaylistItemState.NowPlaying) });
      if (!candidate) {
        return {
          previousPlaylistItems: [],
          nextPlaylistItems: [],
          nowPlaying: null,
        };
      }

      target = candidate;
    }

    return {
      previousPlaylistItems: [
        ...await target.getAdjacentPlaylistItems('previous', { limit: options.previousCount }),
      ],
      nextPlaylistItems: [
        ...(
          target.state === PlaylistItemState.NotPlayedYet
            ? [target]
            : []
        ),
        ...await target.getAdjacentPlaylistItems('next', { limit: options.nextCount }),
      ],
      nowPlaying: nowPlaying || null,
    };
  }

  public async addPlaylistItemFromLink(link: string, channelKey: string, userId?: string) {
    const channel = getChannel(channelKey);

    const info = await ytdl.getInfo(link);
    if (!link) {
      throw new Error('올바르지 않은 링크입니다.');
    }
    const { length_seconds } = info;
    const seconds = Number(length_seconds);
    if (!seconds) {
      throw new Error('재생 길이 정보가 올바르지 않습니다.');
    }

    const baseItem = this.itemRepository.create({
      videoId: info.video_id,
      link,
      info: { ...info } as any,
      title: info.title,
      duration: seconds,
      thumbnailUrl: info.thumbnail_url || `https://img.youtube.com/vi/${info.video_id}/default.jpg`,
    });

    const item = await this.connection.createQueryBuilder()
      .insert()
      .into(Item)
      .values(baseItem)
      .onConflict('("videoId") DO UPDATE SET "videoId" = EXCLUDED."videoId"')
      .returning('*')
      .execute()
      .then(executeResult => this.itemRepository.create(executeResult.generatedMaps[0]));
    const isItemCreated = Number(item.createdAt) === Number(item.updatedAt);

    const playlistItem = await this.connection.transaction(async (entityManager) => {
      const playlistItem = this.create({
        channel: channelKey,
        itemId: item.id,
        userId,
        isFirstItem: false,
      });
      await entityManager.insert(PlaylistItem, playlistItem);

      const lastPlaylistItem = await entityManager
        .getOneInTransaction(PlaylistItem, 'id', (qb) => qb.where('id <> :id AND channel = :channel AND "nextPlaylistItemId" is NULL', { id: playlistItem.id, channel: channelKey }).orderBy('id', 'DESC'), ['id']);
      const lastPlaylistItemId = lastPlaylistItem?.id;

      if (lastPlaylistItem) {
        await entityManager.update(PlaylistItem, { id: lastPlaylistItemId }, {
          nextPlaylistItemId: playlistItem.id,
        });
      } else {
        playlistItem.isFirstItem = true;
        await entityManager.save(playlistItem);
      }

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
      await this.save(playlistItem);
    }

    const [rank, estimateSeconds] = await Promise.all([
      playlistItem.getRank(),
      playlistItem.getWaitingEstimateSeconds(),
    ]);

    const notificationText = userId
      ? `:tada: *[플레이리스트]* <@${userId}>님이 「<${link}|${info.title}>」 곡을 추가했어요. (대기 ${rank + 1}번, ${Duration.fromMillis(estimateSeconds * 1000).toFormat('mm분 ss초')} 남음)`
      : `:tada: *[플레이리스트]* 「<${link}|${info.title}>」 곡이 추가되었어요. (대기 ${rank + 1}번, ${Duration.fromMillis(estimateSeconds * 1000).toFormat('mm분 ss초')} 남음)`;
    const resp = await slack.chat.postMessage({
      token: Config.Slack.BotUserAccessToken,
      channel: channel.id,
      text: notificationText,
      mrkdwn_in: ['text'],
      unfurl_links: false,
      unfurl_media: false,
    });

    playlistItem.slackNotificationIds.queued = resp.ts;
    await this.save(playlistItem);
    if (downloadTaskJob) {
      await downloadTaskJob.save();
    } else {
      slack.reactions.add({
        token: Config.Slack.BotUserAccessToken,
        channel: channel.id,
        timestamp: resp.ts,
        name: 'oki',
      }).catch(() => { });
    }

    redis.publish(`bgm:channels:${playlistItem.channel}:events`, JSON.stringify({
      channel: playlistItem.channel,
      event: 'created',
      id: playlistItem.id,
    }));

    return {
      item,
      playlistItem,
    };
  }


}
