import { Duration } from 'luxon';
import { captureEvent, captureException, Severity, withScope } from '@sentry/node';
import * as _ from 'lodash';
import * as youtubeSearch from 'youtube-search';

import Config from '../config';
import { Item, ItemState } from './../entities/item.entity';
import { generateQueryRegexCondition } from './hangul';
import { getRepository } from 'typeorm';

type YouTubeSearchOptions = youtubeSearch.search.YouTubeSearchOptions;

const youtubeSearchOptions: YouTubeSearchOptions = {
  maxResults: 5,
  type: 'video',
  metadata: {
    duration: true,
  },
};

interface ISearchOptions {
  sources?: ('youtube' | 'item')[];
  maxResults?: number;
  maxDuration?: number;
}

const youtubeSearchAsync = (youtubeSearch as any).default as typeof youtubeSearch.search;
const searchOnYoutube = async (keyword: string, options?: YouTubeSearchOptions) => {
  for (const Key of Config.YouTube.Keys) {
    try {
      return await youtubeSearchAsync(keyword, {
        ...youtubeSearchOptions,
        ...options,
        key: Key,
      })
    } catch (e) {
      console.error(e);
      if (e.response && e.response.data && e.response.data?.error?.code === 403) {
        continue;
      }

      withScope(scope => {
        scope.setFingerprint(['YOUTUBE_SEARCH_FAILED']);
        scope.setTag('youtube', 'search');
        scope.setExtra('keyword', keyword);
        scope.setExtra('options', options);
        scope.setExtra('key', Key);

        captureException(e);
      });
      throw e;
    }
  }
};

export const search = async (keyword: string, options: ISearchOptions = {
  sources: ['youtube'],
  maxResults: 7,
  maxDuration: 500,
}) => {
  const stack = new Error().stack;

  const maxResults = options.maxResults || 7;
  const maxDuration = options.maxDuration || 500;

  const items = [] as Item[];
  const extras = {} as { [key: string]: any };

  for (const source of options.sources ?? ['youtube']) {
    switch (source) {
      case 'youtube': {
        const results = (await searchOnYoutube(keyword, { maxResults }))?.results?.filter(({ kind }) => kind === 'youtube#video')
          .map((result) => {
            const parts = result.duration!.split(':');

            let durationSeconds: number = 0;

            // hh:mm:ss
            if (parts.length === 3) {
              durationSeconds = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
            } else if (parts.length === 2) {
              durationSeconds = Number(parts[0]) * 60 + Number(parts[1]);
            } else if (parts.length === 1) {
              durationSeconds = Number(parts[0]);
            }

            return {
              ...result,
              durationSeconds,
            };
          })
          .filter(({ durationSeconds }) => durationSeconds < maxDuration) ?? [];
        extras.resultsLength = results.length;

        for (const result of results) {
          items.push(getRepository(Item).create({
            videoId: result.id,
            title: result.title,
            link: result.link,
            thumbnailUrl: result.thumbnails.default?.url ?? `https://img.youtube.com/vi/${result.id}/default.jpeg`,
            duration: result.durationSeconds,
            description: result.description,
            channelId: result.channelId,
            channelTitle: result.channelTitle,
          }));
        }
      } break;

      case 'item': {
        const titleConditions = keyword.split(/\s/g).map((k) => generateQueryRegexCondition(k));
        extras.titleConditions = titleConditions;

        const query = getRepository(Item).createQueryBuilder()
          .select()
          .where('state = :state', { state: ItemState.Prepared })
          .andWhere('filename is NOT NULL')
          .andWhere('duration <= :duration', { duration: maxDuration });

        if (titleConditions.length === 0) {
          break;
        }

        for (const [i, titleCondition] of Object.entries(titleConditions)) {
          query.andWhere(`title ~* :title${i}`, { [`title${i}`]: titleCondition });
        }

        const results = await query.limit(maxResults).getMany();
        extras.itemResultsLength = results.length;

        items.push(...results);
      } break;
    }
  }

  const results = _.uniqBy(items, (item) => item.videoId);
  withScope(scope => {
    scope.setFingerprint(['YOUTUBE_SEARCH']);
    scope.setExtra('resultsLink', results.map(({ link }) => link));
    scope.setExtras(extras);
    scope.setExtra('stack', stack);

    const eventId = captureEvent({
      message: `검색 완료 (키워드: ${keyword}, 결과: ${results.length}개)`,
      level: Severity.Log,
    });
    console.info('search completed', eventId);
  });

  return results;
};
