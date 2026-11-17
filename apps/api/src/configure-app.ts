import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { text } from 'express';
import helmet from 'helmet';
import { ENV, Env } from './config/env';

/** HTTP setup shared by the real server and the end-to-end tests. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  app.use(helmet());
  app.use(cookieParser());
  // AWS SNS posts its JSON as text/plain. Keep the raw bytes for the notice handler.
  app.use(
    text({
      type: 'text/plain',
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.enableCors({
    origin: env.WEB_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();
}
