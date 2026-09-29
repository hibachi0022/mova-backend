import {
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  SkipThrottle,
} from '@nestjs/throttler';
import type {
  Request,
} from 'express';
import {
  PaystackWebhookService,
} from './paystack-webhook.service';

type RawBodyRequest =
  Request & {
    rawBody?: Buffer;
  };

@Controller(
  'payments/paystack',
)
@SkipThrottle()
export class PaystackWebhookController {
  constructor(
    private readonly webhooks:
      PaystackWebhookService,
  ) {}

  @Post('webhook')
  @HttpCode(
    HttpStatus.OK,
  )
  @Header(
    'Cache-Control',
    'no-store',
  )
  handle(
    @Req()
    request:
      RawBodyRequest,

    @Headers(
      'x-paystack-signature',
    )
    signature:
      | string
      | undefined,
  ) {
    return this.webhooks.handle(
      request.rawBody,
      signature,
    );
  }
}