import { Transform } from 'class-transformer';
import * as _ from 'lodash';
import { Duration } from 'luxon';
import { Column, CreateDateColumn, Entity, getRepository, Index, OneToMany, UpdateDateColumn } from 'typeorm';
import { getInfo } from 'ytdl-core-new';
import { RelatedVideo } from 'ytdl-core-new/dist/models';

import Config from '../config';
import { hash } from '../utils';
import { PrimaryUUIDColumn } from '../utils/primary-uuid-column';
import { INormalizeTaskPayload, NormalizeTaskQueue } from './../queue';
import { Like } from './like.entity';
import { PlaylistItem } from './playlist-item.entity';

export enum ItemState {
  JustAdded = 'JUST_ADDED',
  Downloading = 'DOWNLOADING',
  Prepared = 'PREPARED',
}

const SKIP_KEYWORDS = [
  '가사',
  '첨부',
];

@Entity()
export class Item {
  @PrimaryUUIDColumn()
  public id!: string;

  @Index()
  @Column({ enum: ItemState, default: ItemState.JustAdded })
  public state!: ItemState;

  @Index({ unique: true })
  @Column()
  public link!: string;

  @Index({ unique: true })
  @Column({ nullable: true })
  public videoId!: string;

  @Column({ nullable: true })
  public title!: string;

  @Column({ nullable: true })
  public duration!: number;

  @Column({ default: '' })
  public description!: string;

  @Transform((value) => _.pick(value, ['length_seconds']))
  @Column({ type: 'json', nullable: false, default: '{}' })
  public info!: any;

  @Column({ nullable: true })
  public thumbnailUrl!: string;

  @Column({ nullable: true })
  public channelId!: string;

  @Column({ default: '' })
  public channelTitle!: string;

  @Column({ nullable: true })
  public filename!: string;

  @Column({ default: false })
  public hasNormalized!: boolean;

  @OneToMany(type => PlaylistItem, playlistItem => playlistItem.id)
  public playlistItems!: PlaylistItem[];

  @OneToMany(type => Like, like => like.item)
  public likes!: Like[];

  public get linkHash() {
    return hash(this.link);
  }

  @Column({ nullable: true })
  public downloadStartedAt!: Date;

  @Column({ nullable: true })
  public downloadEndedAt!: Date;

  @CreateDateColumn()
  public createdAt!: Date;

  @UpdateDateColumn()
  public updatedAt!: Date;

  public get relatedVideos(): RelatedVideo[] {
    return this.info.related_videos ?? [];
  }

  public get durationFromInfo() {
    return Number(this.info?.length_seconds) || undefined as number | undefined;
  }

  public get durationString() {
    const duration = this.duration ?? this.durationFromInfo;
    if (!duration) {
      return '';
    }

    return Duration.fromMillis(duration * 1000).toFormat('mm:ss');
  }

  public async ensureNormalized(waitForFinish = false) {
    if (!Config.Encoder.useNormalize) {
      return;
    }

    if (this.hasNormalized) {
      return;
    }

    const jobs = await Promise.all([
      NormalizeTaskQueue.getJobs('waiting', { start: 0, end: 500 }),
      NormalizeTaskQueue.getJobs('active', { start: 0, end: 500 }),
    ]).then(x => x.flatMap(y => y));
    if (!jobs.find((job) => (job.data as INormalizeTaskPayload)?.itemId === this.id)) {
      const normalizeJob = NormalizeTaskQueue.createJob<INormalizeTaskPayload>({
        itemId: this.id,
      });
      await normalizeJob.save();

      let waitPromise: Promise<void> | null = null;
      if (waitForFinish) {
        waitPromise = new Promise<any>((resolve) => {
          normalizeJob.on('succeeded', resolve);
          normalizeJob.on('failed', resolve);
        });
      }

      await normalizeJob.save();
      if (waitPromise) {
        await waitPromise;
      }
    }

    return;
  }

  public async updateInfo() {
    this.info = await getInfo(this.videoId);
  }

  public getRelatedVideosAsItem(count = 1, pickingAlgorithm: 'random' | 'serial' = 'serial', excludingVideoIdCandidates: string[] = []) {
    const allRelatedVideos = this.relatedVideos
      .filter(({ id, length_seconds }) => id && !isNaN(Number(length_seconds)) && Number(length_seconds) < 500);
    const candidates = allRelatedVideos
      .filter(({ id }) => !excludingVideoIdCandidates.includes(id!));

    const relatedVideos = pickingAlgorithm === 'serial' ? candidates.splice(0, count) : _.sampleSize(candidates, count);

    return relatedVideos
      .map(relatedVideo => {
      return getRepository(Item).create({
        videoId: relatedVideo.id,
        link: `https://www.youtube.com/watch/${relatedVideo.id}`,
        title: relatedVideo.title,
        thumbnailUrl: (relatedVideo as any).video_thumbnail || '',
        duration: Number(relatedVideo.length_seconds),
      });
    });
  }
}
