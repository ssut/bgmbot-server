import Sentry, { init } from '@sentry/node';
import Config from './config';

init({
  dsn: Config.Sentry.Dsn,
  attachStacktrace: true,
});
