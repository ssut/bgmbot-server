export enum RequestType {
  Ping = 'Ping',
  Authenticate = 'Authenticate',
  GetPlaylist = 'GetPlaylist',
  GetPlaylistItemsById = 'GetPlaylistItemsById',
  MovePlaylistItem = 'MovePlaylistItem',
  AddRelatedVideos = 'AddRelatedVideos',
  SetIsPlaying = 'SetIsPlaying',
  ReturnVolume = 'ReturnVolume',
  DeletePlaylistItem = 'DeletePlaylistItem',
  SearchRelatedVideos = 'SearchRelatedVideos',
  AddPlaylistItem = 'AddPlaylistItem',
  BroadcastProgress = 'BroadcastProgress',
  GetAutoCompletionKeywords = 'GetAutoCompletionKeywords',
  Search = 'Search',
}

export enum EventType {
  PlaylistItemCreated = 'PlaylistItemCreated',
  ItemDownloaded = 'ItemDownloaded',
  VolumeRequested = 'VolumeRequested',
  VolumeSetRequested = 'VolumeSetRequested',

  PlaylistUpdated = 'PlaylistUpdated',
  PlayerProgressUpdated = 'PlayerProgressUpdated',
}

export interface IRequest {
  sessionId: string;
  ts: number;
  type: RequestType;
  token: string;
  data: any;
}

export interface IReply {
  ts: number;
  ok: boolean;
  content: any;
}

export interface PlayerProgress {
  playedSeconds: number;
  played: number;
  loadedSeconds: number;
  loaded: number;
}
