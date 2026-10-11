import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
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