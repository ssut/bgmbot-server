import * as crypto from 'crypto';
import Config from './config';

export const hash = (text: string) => crypto.createHash('sha512').update(text).digest().toString('hex');

export const toFilename = (title: string) => title.replace(/[^가-힣a-z-_]/ig, '').replace(/ /g, '-');

export const getChannelByChannelId = (channelId: string) => {
  const channel = Object.entries(Config.Channels).find(([, { id }]) => channelId === id);
  if (!channel) {
    return null;
  }

  return {
    key: channel[0],
    info: channel[1],
  };
};

export const getChannel = (channelKey: string) => (Config.Channels as any)[channelKey] as typeof Config.Channels['bgmbot'];
