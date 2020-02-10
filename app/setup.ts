import './utils/typeorm';
import * as typeorm from 'typeorm';
import request from 'ytdl-core-new/dist/client';
import tunnel from 'tunnel';
import * as url from 'url';
import Config from './config';
import { installAsyncStackHooks } from './utils/install-async-state-hook';

if (typeof Config.Proxy.YTDL === 'string' && Config.Proxy.YTDL.length > 0) {
  const proxyUrl = url.parse(Config.Proxy.YTDL);
  const proxy = {
    host: proxyUrl.hostname,
    port: proxyUrl.port || 80,
    proxyAuth: proxyUrl.auth || undefined,
  } as tunnel.ProxyOptions;

  const httpsAgent = tunnel.httpsOverHttp({ proxy });
  const httpAgent = tunnel.httpOverHttp({ proxy });
  request.defaults.httpsAgent = httpsAgent;
  request.defaults.httpAgent = httpAgent;

  console.info('proxy is set for YTDL', proxy);
}

[
  typeorm.Connection,
  typeorm.ConnectionManager,
  typeorm.QueryBuilder,
  typeorm.Repository,
].forEach((x) => installAsyncStackHooks(x));
