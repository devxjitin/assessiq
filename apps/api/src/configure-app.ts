import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ENV, Env } from './config/env';

/** HTTP setup shared by the real server and the end-to-end tests. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.WEB_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();
}
