import BeeQueue from 'bee-queue';

export const PlaylistTaskQueue = new BeeQueue('playlist');
export const DownloadTaskQueue = new BeeQueue('download', {
  removeOnSuccess: true,
});
export const WordcloudTaskQueue = new BeeQueue('wordcloud', {
  removeOnFailure: true,
  removeOnSuccess: true,
});
export const NormalizeTaskQueue = new BeeQueue('normalize', {
  removeOnFailure: true,
  removeOnSuccess: true,
});

export interface IDownloadTaskPayload {
  itemId: string;
  playlistItemId: number;
}

export interface IWordcloudTaskPayload {
  channel: string;
}

export interface INormalizeTaskPayload {
  itemId: string;
}
