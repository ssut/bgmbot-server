import { Duration } from 'luxon';
import * as ytdl from 'ytdl-core-new';
import { getChannel } from './../utils';
import { Repository, slack, redis } from './../common';
import { PrimaryGeneratedColumn, ManyToOne, Column, Index, Entity, CreateDateColumn, UpdateDateColumn, LessThan, Not, OneToOne, Unique, getConnection, getMetadataArgsStorage, getRepository, getConnectionManager, In, Raw, IsNull } from 'typeorm';
import { Item } from './item.entity';
import { User } from './user.entity';
import Config from '../config';
import { Job } from 'bee-queue';
import { DownloadTaskQueue, IDownloadTaskPayload } from '../queue';

export enum PlaylistItemState {
  NotPlayedYet = 'NOT_PLAYED_YET',
  NowPlaying = 'NOW_PLAYING',
  Played = 'PLAYED',
}

export interface IPlaylistItemSlackNotificationIds {
  queued: string;
  nowPlaying: string;
}

@Entity({})
export class PlaylistItem {
  @PrimaryGeneratedColumn()
  public id!: number;

  @Index({ unique: true })
  @Column({ nullable: true })
  public nextPlaylistItemId!: number;

  @OneToOne((type) => PlaylistItem, playlistItem => playlistItem.id)
  public nextPlaylistItem!: PlaylistItem;

  @Index()
  @Column({ nullable: false })
  public channel!: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  public slackNotificationIds!: IPlaylistItemSlackNotificationIds;

  @Index()
  @Column({ enum: PlaylistItemState, default: PlaylistItemState.NotPlayedYet })
  public state!: PlaylistItemState;

  @Index()
  @Column({ default: false })
  public isFirstItem!: boolean;

  @Index()
  @Column({ default: false })
  public isDeleted!: boolean;

  @Index()
  @Column({ default: false })
  public isReady!: boolean;

  @Column({ nullable: true })
  public itemId!: string;

  @ManyToOne(type => Item, item => item.playlistItems, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  public item!: Item;

  @Column({ nullable: false })
  public userId!: string;

  @ManyToOne(type => User, user => user.playlistItems, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  public user!: User;

  @Column({ default: false })
  public addedAutomatically!: boolean;

  @CreateDateColumn()
  public createdAt!: Date;

  @UpdateDateColumn()
  public updatedAt!: Date;

  public async getRank() {
    const [rankQueryResult] = await getConnection().query(`
      WITH RECURSIVE plist(id) AS (
        SELECT
          "playlist_item"."id",
          "playlist_item"."channel",
          "playlist_item"."state",
          "playlist_item"."isDeleted",
          "playlist_item"."nextPlaylistItemId"
        FROM bgmbot.playlist_item
        WHERE "playlist_item"."channel" = $1 AND "playlist_item"."isDeleted" = false AND "playlist_item"."id" = $2
        UNION
        SELECT
        "p"."id",
        "p"."channel",
        "p"."state",
        "p"."isDeleted",
        "p"."nextPlaylistItemId"
        FROM bgmbot.playlist_item p
        JOIN plist ON ("p"."nextPlaylistItemId" = "plist"."id")
        WHERE "p"."channel" = $1 AND "p"."state" != 'NOW_PLAYING'
      )
      SELECT count(*) - 1 AS "rank" FROM (SELECT * FROM "plist" WHERE "isDeleted" = false) "list";
    `.trim(), [this.channel, this.id]);

    return Number(rankQueryResult?.rank);
  }

  public async getWaitingEstimateSeconds() {
    const [queryResult] = await getConnection().query(`
      WITH RECURSIVE plist(id) AS (
        SELECT
          "playlist_item"."id",
          "playlist_item"."channel",
          "playlist_item"."state",
          "playlist_item"."isDeleted",
          "playlist_item"."itemId",
          "playlist_item"."nextPlaylistItemId"
        FROM bgmbot.playlist_item
        WHERE "playlist_item"."channel" = $1 AND "playlist_item"."isDeleted" = false AND "playlist_item"."id" = $2
        UNION
        SELECT
        "p"."id",
        "p"."channel",
        "p"."state",
        "p"."isDeleted",
        "p"."itemId",
        "p"."nextPlaylistItemId"
        FROM bgmbot.playlist_item p
        JOIN plist ON ("p"."nextPlaylistItemId" = "plist"."id")
        WHERE "p"."channel" = $1 AND "p"."state" != 'NOW_PLAYING'
      )
      SELECT SUM(i.duration) as waiting FROM (SELECT * FROM "plist" WHERE "isDeleted" = false) "list" JOIN bgmbot.item i ON i.id = "itemId";
    `.trim(), [this.channel, this.id]);

    return Number(queryResult?.waiting ?? 0) || 0;
  }

  public async getAdjacentPlaylistItems(direction: 'previous' | 'next', options: Partial<{ limit: number; skipDeleted: boolean }> = { limit: 100, skipDeleted: false }) {
    const columnNames = Repository.PlaylistItem.metadata.columns.filter(
      (column) => !['slackNotificationIds'].includes(column.databaseName),
    ).map((column) => `"${column.databaseName}"`);
    const addAliasPrefix = (alias: string) => columnNames.map((columnName) => `"${alias}".${columnName}`);

    const items = await getConnection().query(`
      WITH RECURSIVE plist(id) AS (
        SELECT
          ${addAliasPrefix('playlist_item').join(',')}
        FROM bgmbot.playlist_item
        WHERE "playlist_item"."channel" = $1 ${options.skipDeleted ? 'AND "playlist_item"."isDeleted" = false' : ''} AND "playlist_item"."id" = $2
        UNION
        SELECT
          ${addAliasPrefix('p').join(',')}
        FROM bgmbot.playlist_item p
        JOIN plist ON ${direction === 'next' ? `("p"."id" = "plist"."nextPlaylistItemId")` : `("p"."nextPlaylistItemId" = "plist"."id")`}
        WHERE "p"."channel" = $1
      )
      SELECT * FROM "plist" WHERE "id" <> $2 ${options.skipDeleted ? 'AND "isDeleted" = false' : ''} LIMIT $3;
    `.trim(), [this.channel, this.id, options.limit]);

    const playlistItems = (items?.map((item: any) => Repository.PlaylistItem.create(item)) ?? []) as PlaylistItem[];
    if (direction === 'previous') {
      return playlistItems.reverse();
    }
    return playlistItems;
  }

  public async moveBefore(nextPlaylistItemId: number | null) {
    if (this.nextPlaylistItemId === nextPlaylistItemId) {
      console.info(this.nextPlaylistItemId, nextPlaylistItemId);
      return false;
    }

    const targetItem = nextPlaylistItemId === null ? null : (await Repository.PlaylistItem.findOneOrFail(nextPlaylistItemId));

    let [
      [previousOfTarget],
      // [nextOfTarget],
      [previousOfThis],
      [nextOfThis],
    ] = await Promise.all([
      targetItem?.getAdjacentPlaylistItems('previous', { limit: 1 }) ?? [],
      // targetItem.getAdjacentPlaylistItems('next', { limit: 1 }),
      this.getAdjacentPlaylistItems('previous', { limit: 1 }),
      this.getAdjacentPlaylistItems('next', { limit: 1 }),
    ]);

    console.info('previousOfTarget', previousOfTarget?.id);
    console.info('target', targetItem?.id);
    console.info('previousOfThis', previousOfThis?.id);
    console.info('this', this.id);
    console.info('nextOfThis', nextOfThis?.id);

    return getConnection().transaction(async (entityManager) => {
      const resetTargets = [this.id];

      const lastPlaylistItem = await entityManager
        .getOneInTransaction(PlaylistItem, 'id', (qb) => qb.where('channel = :channel AND "nextPlaylistItemId" is NULL', { channel: this.channel }).orderBy('id', 'DESC'), ['id']);

      // unique constaint
      if (previousOfTarget) {
        resetTargets.push(previousOfTarget.id);
      }
      if (previousOfThis) {
        resetTargets.push(previousOfThis.id);
      }
      await entityManager.update(PlaylistItem, { id: In(resetTargets) }, { nextPlaylistItemId: null as any });

      // update
      await entityManager.update(PlaylistItem, { id: this.id }, { nextPlaylistItemId: targetItem?.id ?? null as any });
      if (previousOfTarget) {
        await entityManager.update(PlaylistItem, { id: previousOfTarget.id }, { nextPlaylistItemId: this.id });
      }
      if (previousOfThis && nextOfThis) {
        await entityManager.update(PlaylistItem, { id: previousOfThis.id }, { nextPlaylistItemId: nextOfThis.id });
      }
      if (targetItem?.isFirstItem) {
        await entityManager.update(PlaylistItem, { id: targetItem.id }, { isFirstItem: false });
        await entityManager.update(PlaylistItem, { id: this.id }, { isFirstItem: true });
      } else if (this.isFirstItem && nextOfThis) {
        await entityManager.update(PlaylistItem, { id: this.id }, { isFirstItem: false });
        await entityManager.update(PlaylistItem, { id: nextOfThis.id }, { isFirstItem: true });
      }

      // 끝으로 보낼 때
      if (targetItem === null) {
        if (lastPlaylistItem) {
          console.info('last', lastPlaylistItem.id);
          if (lastPlaylistItem.id) {
            const previousPlaylistItem = await entityManager
              .getOneInTransaction(PlaylistItem, 'id', (qb) =>
                qb
                  .where('channel = :channel', { channel: this.channel })
                  .andWhere('nextPlaylistItemId = :nextPlaylistItemId', { nextPlaylistItemId: lastPlaylistItem.id })
                  .orderBy('id', 'DESC'),
                ['id'],
            );
            if (previousPlaylistItem) {
              const previousItemId = lastPlaylistItem.id;
              console.info('previous', previousItemId);

              await entityManager.update(PlaylistItem, { id: previousItemId }, { nextPlaylistItemId: this.id });
            }
          }

          if (lastPlaylistItem.id !== this.id) {
            await entityManager.update(PlaylistItem, { id: lastPlaylistItem.id }, { nextPlaylistItemId: this.id });
          }
        }
      }

      return true;
    });
  }

  public static async getPlaylistItemBySlackNotificationId(key: keyof IPlaylistItemSlackNotificationIds, notificationId: string) {
    return Repository.PlaylistItem.createQueryBuilder()
      .select()
      .where('"slackNotificationIds"->>:key = :notificationId', { key, notificationId })
      .getOne();
  }

  public static async checkIfFresh(channel: string) {
    const [result] = await Repository.PlaylistItem.createQueryBuilder()
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

  public static async getPlaylist(channel: string, options: Partial<{ previousCount: number; nextCount: number }> = { previousCount: 20, nextCount: 20 }) {
    const isFresh = await this.checkIfFresh(channel);
    if (isFresh) {
      // nextPlaylistId가 없는 것이 첫번째 곡
      const firstPlaylistItem = await Repository.PlaylistItem.findOne({
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
    const nowPlaying = await Repository.PlaylistItem.findOne({ channel, state: PlaylistItemState.NowPlaying });
    if (nowPlaying) {
      target = nowPlaying;
    } else {
      const candidate = await Repository.PlaylistItem.findOne({ channel, state: Not(PlaylistItemState.NowPlaying) });
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

  public static async addPlaylistItemFromLink(link: string, channelKey: string, userId?: string) {
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

    const baseItem = Repository.Item.create({
      videoId: info.video_id,
      link,
      info: { ...info } as any,
      title: info.title,
      duration: seconds,
      thumbnailUrl: info.thumbnail_url || `https://img.youtube.com/vi/${info.video_id}/default.jpg`,
    });

    const item = await getConnection().createQueryBuilder()
      .insert()
      .into(Item)
      .values(baseItem)
      .onConflict('("videoId") DO UPDATE SET "videoId" = EXCLUDED."videoId"')
      .returning('*')
      .execute()
      .then(executeResult => Repository.Item.create(executeResult.generatedMaps[0]));
    const isItemCreated = Number(item.createdAt) === Number(item.updatedAt);

    const playlistItem = await getConnection().transaction(async (entityManager) => {
      const playlistItem = Repository.PlaylistItem.create({
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
      await Repository.PlaylistItem.save(playlistItem);
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
    await Repository.PlaylistItem.save(playlistItem);
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
