import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Env } from '../config/env';

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface GatewayOrder {
  orderId: string;
}

/** A gateway webhook reduced to what we act on. */
export interface WebhookInfo {
  eventId: string;
  type: 'captured' | 'failed' | 'ignored';
  orderId?: string;
  paymentId?: string;
  amountPaise?: number;
  reason?: string;
}

export interface PaymentProvider {
  readonly name: 'fake' | 'razorpay';
  /** Public key the browser needs for Checkout (null when not applicable). */
  readonly publicKeyId: string | null;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
  }): Promise<GatewayOrder>;
  /** Checks the signature the browser got back from Checkout. */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Checks the webhook signature over the exact raw request body. */
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(body: unknown, eventIdHeader: string | undefined): WebhookInfo;
}

const hmac = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Razorpay-shaped webhook payloads (the fake provider uses the same shape). */
function parseRazorpayWebhook(body: unknown, eventIdHeader: string | undefined): WebhookInfo {
  const b = body as {
    event?: string;
    payload?: { payment?: { entity?: Record<string, unknown> } };
  };
  const eventId = eventIdHeader ?? '';
  const p = b?.payload?.payment?.entity;
  const base = {
    eventId,
    orderId: typeof p?.order_id === 'string' ? p.order_id : undefined,
    paymentId: typeof p?.id === 'string' ? p.id : undefined,
    amountPaise: typeof p?.amount === 'number' ? p.amount : undefined,
  };
  if (b?.event === 'payment.captured') return { ...base, type: 'captured' };
  if (b?.event === 'payment.failed') {
    return {
      ...base,
      type: 'failed',
      reason: typeof p?.error_description === 'string' ? p.error_description : undefined,
    };
  }
  return { ...base, type: 'ignored' };
}

/** Simulated gateway for development, tests and staging before real keys exist. */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  readonly publicKeyId = null;
  // Not a real secret: the fake gateway only exists where fake payments are acceptable.
  static readonly SECRET = 'fake-gateway-secret';

  async createOrder(): Promise<GatewayOrder> {
    return { orderId: `fake_order_${randomUUID().replace(/-/g, '').slice(0, 14)}` };
  }

  /** What "the gateway" would sign after a successful checkout. */
  static sign(orderId: string, paymentId: string): string {
    return hmac(FakePaymentProvider.SECRET, `${orderId}|${paymentId}`);
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(FakePaymentProvider.sign(orderId, paymentId), signature);
  }

  static signWebhook(rawBody: Buffer | string): string {
    return hmac(FakePaymentProvider.SECRET, rawBody);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    return !!signature && safeEqualHex(FakePaymentProvider.signWebhook(rawBody), signature);
  }

  parseWebhook = parseRazorpayWebhook;
}

/** Real Razorpay via its REST API (no SDK needed). Verified against Razorpay's documented scheme. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  get publicKeyId(): string {
    return this.keyId;
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
  }): Promise<GatewayOrder> {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Razorpay order creation failed with status ${res.status}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('Razorpay returned no order id');
    return { orderId: data.id };
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(hmac(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    return !!signature && safeEqualHex(hmac(this.webhookSecret, rawBody), signature);
  }

  parseWebhook = parseRazorpayWebhook;
}

export function createPaymentProvider(env: Env): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    return new RazorpayProvider(
      env.RAZORPAY_KEY_ID!,
      env.RAZORPAY_KEY_SECRET!,
      env.RAZORPAY_WEBHOOK_SECRET!,
    );
  }
  return new FakePaymentProvider();
}
