import 'dotenv/config';

import * as path from 'path';
import * as qs from 'qs';
import type { ClientOpts } from 'redis';

const { env } = process;

export default class Config {
  public static readonly Sentry = Object.freeze({
    Dsn: env.SENTRY_DSN!,
  });

  public static readonly Jwt = Object.freeze({
    Secret: env.JWT_SECRET!,
  });

  public static readonly Frontend = Object.freeze({
    URL: env.FRONTEND_URL!,

    AllowedHosts: env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',') : [
      'front.dev.airfly.io',
      'bgm.airfly.io',
      'localhost:3000',
    ],
  });

  public static readonly Redis = Object.freeze({
    host: env.REDIS_HOST! || 'localhost',
    port: Number(env.REDIS_PORT) || 6379,
    password: env.REDIS_PASSWORD,
    db: Number(env.REDIS_DB) || 0,
    tls: env.REDIS_USE_TLS ? {
      servername: env.REDIS_TLS_SERVERNAME,
      rejectUnauthorized: !env.REDIS_TLS_TRUST_ALL,
    } : undefined,
  } as ClientOpts);

  public static readonly Proxy = Object.freeze({
    YTDL: env.YTDL_PROXY,
  });

  public static readonly Slack = Object.freeze({
    ClientId: env.SLACK_CLIENT_ID!,
    ClientSecret: env.SLACK_CLIENT_SECRET!,
    BotUserAccessToken: env.SLACK_BOT_USER_ACCESS_TOKEN!,
    BotUserId: env.SLACK_BOT_USER_ID!,
  });

  public static readonly YouTube = Object.freeze({
    Keys: env.YOUTUBE_KEYS?.split(',') ?? [],
  });

  public static readonly DownloadPath = env.DOWNLOAD_PATH || path.join(__dirname, '../downloads/');
  public static readonly Encoder = Object.freeze({
    useNormalize: env.ENCODER_USE_NORMALIZE! === '1' ? true : false,
    ffmpegNormalize: env.ENCODER_FFMPEG_NORMALIZE! || '/usr/local/bin/ffmpeg-normalize',
  });

  public static readonly Channels = Object
    .keys(env)
    .filter((key) => key.startsWith('CHANNELS_'))
    .reduce((obj, key) => {
      const channelKey = key.replace('CHANNELS_', '');

      const value = env[key]!;
      obj[channelKey] = Object.freeze(qs.parse(value));

      return obj;
    }, {} as {
      [key: string]: {
        id: string;
        name: string;
        alias: string;
        superuser: string;
      };
    });
}
