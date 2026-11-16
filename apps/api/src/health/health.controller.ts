import { Controller, Get } from '@nestjs/common';
import { BRAND } from '@assessiq/shared';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let database = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unreachable';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: `${BRAND.PRODUCT} API`,
      database,
      time: new Date().toISOString(),
    };
  }
}
