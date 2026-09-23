import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsUUID,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { AddOutingGuestDto } from './dto/add-outing-guest.dto';
import { CreateOutingDto } from './dto/create-outing.dto';
import { OutingCheckoutDto } from './dto/outing-checkout.dto';
import { OutingMemberConsentDto } from './dto/outing-member-consent.dto';
import { OutingsPaymentsService } from './outings-payments.service';
import { OutingsRouletteService } from './outings-roulette.service';
import { OutingsService } from './outings.service';

class OutingIdParams {
  @IsUUID()
  id!: string;
}

@Controller('outings')
@UseGuards(AuthGuard)
export class OutingsController {
  constructor(
    private readonly outings:
      OutingsService,

    private readonly roulette:
      OutingsRouletteService,

    private readonly payments:
      OutingsPaymentsService,
  ) {}

  @Get()
  @Header(
    'Cache-Control',
    'no-store',
  )
  list(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.outings.list(
      request.authUser.id,
    );
  }

  @Get(':id')
  @Header(
    'Cache-Control',
    'no-store',
  )
  get(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
  ) {
    return this.outings.get(
      request.authUser.id,
      params.id,
    );
  }

  @Post()
  @HttpCode(
    HttpStatus.CREATED,
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
  create(
    @Req()
    request:
      AuthenticatedRequest,
    @Body()
    input:
      CreateOutingDto,
  ) {
    return this.outings.create(
      request.authUser.id,
      input,
    );
  }

  @Post(':id/members')
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
  addGuest(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
    @Body()
    input:
      AddOutingGuestDto,
  ) {
    return this.outings.addGuest(
      request.authUser.id,
      params.id,
      input,
    );
  }

  @Post(':id/invites')
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
  invite(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
  ) {
    return this.outings.createInvite(
      request.authUser.id,
      params.id,
    );
  }

  @Post(
    ':id/members/me/consent',
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
  consent(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
    @Body()
    input:
      OutingMemberConsentDto,
  ) {
    return this.outings.setConsent(
      request.authUser.id,
      params.id,
      input.optedIn,
    );
  }

  @Post(':id/roulette')
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
  spinRoulette(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
  ) {
    return this.roulette.spin(
      request.authUser.id,
      params.id,
    );
  }

  @Get(
    ':id/payment-options',
  )
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit:
        30,
      ttl:
        60_000,
    },
  })
  paymentOptions(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
  ) {
    return this.payments.options(
      request.authUser.id,
      params.id,
    );
  }

  @Post(':id/checkout')
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
  checkout(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      OutingIdParams,
    @Body()
    input:
      OutingCheckoutDto,
    @Headers(
      'idempotency-key',
    )
    idempotencyKey:
      | string
      | undefined,
  ) {
    return this.payments.checkout(
      request.authUser.id,
      request.authUser.email,
      params.id,
      input,
      idempotencyKey,
    );
  }
}