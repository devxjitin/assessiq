import { Controller, Get } from '@nestjs/common';
import { BRAND, PRICING } from '@assessiq/shared';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: `${BRAND.PRODUCT} API`,
      time: new Date().toISOString(),
      // Handy to confirm the shared package is wired up correctly.
      joinFeePaise: PRICING.EXAM_JOIN_PAISE,
    };
  }
}
