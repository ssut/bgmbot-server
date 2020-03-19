import { Like } from './like.entity';
import { NormalizeTaskQueue, INormalizeTaskPayload } from './../queue';
import { Transform } from 'class-transformer';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as _ from 'lodash';
import { Duration } from 'luxon';
import { Column, CreateDateColumn, Entity, Index, OneToMany, UpdateDateColumn } from 'typeorm';
import { RelatedVideo } from 'ytdl-core-new/dist/models';

import { Repository } from '../common';
import { hash } from '../utils';
import { generateQueryRegexCondition } from '../utils/hangul';
import { PrimaryUUIDColumn } from '../utils/primary-uuid-column';
import { PlaylistItem } from './playlist-item.entity';
import Config from '../config';
import { getInfo } from 'ytdl-core-new';

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
      return Repository.Item.create({
        videoId: relatedVideo.id,
        link: `https://www.youtube.com/watch/${relatedVideo.id}`,
        title: relatedVideo.title,
        thumbnailUrl: (relatedVideo as any).video_thumbnail || '',
        duration: Number(relatedVideo.length_seconds),
      });
    });
  }

  public static async getAutoCompletionTitles(keyword: string, limit = 10) {
    const titleConditions = keyword.split(/\s/g).map((k) => generateQueryRegexCondition(k));

    if (titleConditions.length === 0) {
      return [];
    }

    const query = Repository.Item.createQueryBuilder().select('title');

    for (const [i, titleCondition] of Object.entries(titleConditions)) {
      query.andWhere(`title ~* :title${i}`, { [`title${i}`]: titleCondition });
    }

    const results = await query.limit(limit).execute();
    const titles = (results ?? []).map(({ title }: { title: string }) => title) as string[];

    const items = titles.map((title) => {
      const completions = [] as string[];

      for (const titleRegex of titleConditions) {
        const regex = new RegExp(titleRegex, 'ig');
        const execResult = regex.exec(title);
        if (execResult === null) {
          return null;
        }

        const { index } = execResult;
        let shouldStop = false;
        const completion = title.split(/(?:)/).reduce((accum, current, currentIndex) => { // 스페이스로 자르고
          if (shouldStop) { // 멈추는 조건이면 그만
            return accum;
          } else if (currentIndex < index) { // 일단 시작 인덱스까지는 이 조건
            const currentToEnd = title.substring(currentIndex, index);
            if (/[^a-z가-힣]/ig.test(currentToEnd)) { // 영단어 또는 한글단어가 안 붙어 있으면
              return accum; // 스킵
            }

            return accum + current;  // 아니면 붙여주기
          }

          if (/[^a-z가-힣 ]/ig.test(current)) {
            shouldStop = true;
            return accum;
          }

          // 스페이스 제외 마지막 글자 언어가 현재 언어랑 다르면 stop
          const trimmed = accum.trim();
          if (trimmed.length > 0 && trimmed[trimmed.length - 1]) {
            const lastLang = /[가-힣]/.test(trimmed[trimmed.length - 1]) ? 'ko' : 'en';
            const currentLang = /[가-힣]/.test(current) ? 'ko' : 'en';

            if (lastLang !== currentLang) {
              shouldStop = true;
              return accum;
            }
          }

          return accum + current;
        }, '');

        completions.push(completion);
      }

      if (completions.length > 0) {
        return [...new Set(completions.map(x => x.replace(/ {1,}/g, ' ').trim()))].join(' ').trim();
      }

      return null;
    });

    return [...new Set(items)]
      .filter(x => x !== null && !SKIP_KEYWORDS.includes(x))
      .map((x) => ({ result: x, length: x!.length, diff: x!.length - keyword.length }))
      .sort((a, b) => a.diff - b.diff)
      .map(({ result }) => result);
  }
}
