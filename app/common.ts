import { captureException, withScope } from '@sentry/node';
import { User } from './entities/user.entity';
import { PlaylistItem } from './entities/playlist-item.entity';
import { getRepository, Repository as TRepository, createConnection } from 'typeorm';
import Slack from 'slack';
import axios, { AxiosError } from 'axios';
import { createHandyClient } from 'handy-redis';
import Config from './config';
import { Item } from './entities/item.entity';
import { Like } from './entities/like.entity';

export const slack: typeof Slack = new (Slack as any)({ token: Config.Slack.BotUserAccessToken });
export const client = axios.create();
export const redis = createHandyClient();

redis.redis.setMaxListeners(Infinity);

client.defaults.headers.post['content-type'] = 'application/json';
client.interceptors.response.use((resp) => resp, (error: AxiosError) => {
  const { config, response } = error;
  withScope(scope => {
    scope.setFingerprint(['HTTP_REQUEST_FAILED']);

    const url = config.url || '';
    const domain = url.split('://').reverse()[0].split('/')[0];
    scope.setTag('domain', domain);
    scope.setExtra('url', url);
    scope.setExtra('response.data', response?.data);

    captureException(error);
  });

  return Promise.reject(error);
});

interface IRepository {
  Item: TRepository<Item>;
  PlaylistItem: TRepository<PlaylistItem>;
  User: TRepository<User>;
  Like: TRepository<Like>;
}

export const Repository: IRepository = {} as any;

export const initConnection = async () => {
  const connection = await createConnection();

  await connection.query(`
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE INDEX IF NOT EXISTS idx_slack_notification_ids ON bgmbot.playlist_item(("slackNotificationIds"->>'queued'));
  CREATE INDEX IF NOT EXISTS idx_slack_notification_ids_now_playing ON bgmbot.playlist_item(("slackNotificationIds"->>'nowPlaying'));
  CREATE INDEX IF NOT EXISTS idx_title ON bgmbot.item("title");
  `);
};

export const initRepository = () => {
  Repository.Item = getRepository(Item);
  Repository.PlaylistItem = getRepository(PlaylistItem);
  Repository.User = getRepository(User);
  Repository.Like = getRepository(Like);
};
