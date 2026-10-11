import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { CreateTransferQuoteDto } from './dto/create-transfer-quote.dto';
import { TransferCheckoutDto } from './dto/transfer-checkout.dto';
import { TransferCheckoutService } from './transfer-checkout.service';
import { TransferPayoutService } from './transfer-payout.service';
import { TransfersService } from './transfers.service';

@Controller(
  'transfers',
)
@UseGuards(
  AuthGuard,
)
export class TransfersController {
  constructor(
    private readonly transfers:
      TransfersService,

    private readonly checkout:
      TransferCheckoutService,

    private readonly payouts:
      TransferPayoutService,
  ) {}

  @Post(
    'quotes',
  )
  @HttpCode(
    HttpStatus.OK,
  )
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit:
        20,
      ttl:
        60_000,
    },
  })
  createQuote(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      CreateTransferQuoteDto,
  ) {
    return this.transfers.createQuote(
      request.authUser.id,
      input,
    );
  }

  @Post(
    ':paymentIntentId/reconcile-payout',
  )
  @HttpCode(
    HttpStatus.OK,
  )
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit:
        10,
      ttl:
        60_000,
    },
  })
  reconcilePayout(
    @Req()
    request:
      AuthenticatedRequest,

    @Param(
      'paymentIntentId',
      new ParseUUIDPipe({
        version:
          '4',
      }),
    )
    paymentIntentId:
      string,
  ) {
    return this.payouts.reconcileForUser(
      request.authUser.id,
      paymentIntentId,
    );
  }

  @Post(
    'checkout',
  )
  @HttpCode(
    HttpStatus.OK,
  )
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit:
        5,
      ttl:
        60_000,
    },
  })
  transferCheckout(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      TransferCheckoutDto,

    @Headers(
      'idempotency-key',
    )
    idempotencyKey:
      | string
      | undefined,
  ) {
    return this.checkout.checkout(
      request.authUser.id,
      input.quoteId,
      idempotencyKey,
    );
  }
}