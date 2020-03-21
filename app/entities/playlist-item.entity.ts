import {
  Column,
  CreateDateColumn,
  Entity,
  getConnection,
  In,
  Index,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  getRepository,
} from 'typeorm';

import { Item } from './item.entity';
import { User } from './user.entity';

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
        FROM playlist_item
        WHERE "playlist_item"."channel" = $1 AND "playlist_item"."isDeleted" = false AND "playlist_item"."id" = $2
        UNION
        SELECT
        "p"."id",
        "p"."channel",
        "p"."state",
        "p"."isDeleted",
        "p"."nextPlaylistItemId"
        FROM playlist_item p
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
        FROM playlist_item
        WHERE "playlist_item"."channel" = $1 AND "playlist_item"."isDeleted" = false AND "playlist_item"."id" = $2
        UNION
        SELECT
        "p"."id",
        "p"."channel",
        "p"."state",
        "p"."isDeleted",
        "p"."itemId",
        "p"."nextPlaylistItemId"
        FROM playlist_item p
        JOIN plist ON ("p"."nextPlaylistItemId" = "plist"."id")
        WHERE "p"."channel" = $1 AND "p"."state" != 'NOW_PLAYING'
      )
      SELECT SUM(i.duration) as waiting FROM (SELECT * FROM "plist" WHERE "isDeleted" = false) "list" JOIN item i ON i.id = "itemId";
    `.trim(), [this.channel, this.id]);

    return Number(queryResult?.waiting ?? 0) || 0;
  }

  public async getAdjacentPlaylistItems(direction: 'previous' | 'next', options: Partial<{ limit: number; skipDeleted: boolean }> = { limit: 100, skipDeleted: false }) {
    const columnNames = getRepository(PlaylistItem).metadata.columns.filter(
      (column) => !['slackNotificationIds'].includes(column.databaseName),
    ).map((column) => `"${column.databaseName}"`);
    const addAliasPrefix = (alias: string) => columnNames.map((columnName) => `"${alias}".${columnName}`);

    const items = await getConnection().query(`
      WITH RECURSIVE plist(id) AS (
        SELECT
          ${addAliasPrefix('playlist_item').join(',')}
        FROM playlist_item
        WHERE "playlist_item"."channel" = $1 ${options.skipDeleted ? 'AND "playlist_item"."isDeleted" = false' : ''} AND "playlist_item"."id" = $2
        UNION
        SELECT
          ${addAliasPrefix('p').join(',')}
        FROM playlist_item p
        JOIN plist ON ${direction === 'next' ? `("p"."id" = "plist"."nextPlaylistItemId")` : `("p"."nextPlaylistItemId" = "plist"."id")`}
        WHERE "p"."channel" = $1
      )
      SELECT * FROM "plist" WHERE "id" <> $2 ${options.skipDeleted ? 'AND "isDeleted" = false' : ''} LIMIT $3;
    `.trim(), [this.channel, this.id, options.limit]);

    const playlistItems = (items?.map((item: any) => getRepository(PlaylistItem).create(item)) ?? []) as PlaylistItem[];
    if (direction === 'previous') {
      return playlistItems.reverse();
    }
    return playlistItems;
  }

  public async moveBefore(nextPlaylistItemId: number | null) {
    if (this.nextPlaylistItemId === nextPlaylistItemId) {
      return false;
    }

    const targetItem = nextPlaylistItemId === null ? null : (await getRepository(PlaylistItem).findOneOrFail(nextPlaylistItemId));

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
}
