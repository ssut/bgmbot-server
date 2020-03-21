import 'core-js';
import 'source-map-support/register';

if (process.env.NODE_ENV !== 'production') {
  require('tsconfig-paths/register');
}

import { captureException, withScope } from '@sentry/node';
import axios, { AxiosError } from 'axios';
import { createHandyClient } from 'handy-redis';
import Slack from 'slack';
import { createConnection } from 'typeorm';

import Config from './config';
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

export const initConnection = async () => {
  const connection = await createConnection();

  const schemaPrefix = typeof (connection.options as any).schema === 'string' ? `${(connection.options as any).schema}.` : '';

  await connection.query(`
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE INDEX IF NOT EXISTS idx_slack_notification_ids ON ${schemaPrefix}playlist_item(("slackNotificationIds"->>'queued'));
  CREATE INDEX IF NOT EXISTS idx_slack_notification_ids_now_playing ON ${schemaPrefix}playlist_item(("slackNotificationIds"->>'nowPlaying'));
  CREATE INDEX IF NOT EXISTS idx_title ON ${schemaPrefix}item("title");
  `);
};
