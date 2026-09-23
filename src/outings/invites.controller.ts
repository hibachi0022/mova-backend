import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  Transform,
} from 'class-transformer';
import {
  Matches,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { JoinOutingDto } from './dto/join-outing.dto';
import { OutingsService } from './outings.service';

class InviteCodeParams {
  @Transform(
    ({ value }) =>
      typeof value === 'string'
        ? value
            .trim()
            .toUpperCase()
        : value,
  )
  @Matches(
    /^[A-F0-9]{10}$/,
  )
  code!: string;
}

@Controller('invites')
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(
    private readonly outings:
      OutingsService,
  ) {}

  @Get(':code')
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit: 30,
      ttl: 60_000,
    },
  })
  lookup(
    @Param()
    params:
      InviteCodeParams,
  ) {
    return this.outings.lookupInvite(
      params.code,
    );
  }

  @Post(':code/join')
  @HttpCode(
    HttpStatus.OK,
  )
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
    },
  })
  join(
    @Req()
    request:
      AuthenticatedRequest,
    @Param()
    params:
      InviteCodeParams,
    @Body()
    _input:
      JoinOutingDto,
  ) {
    return this.outings.joinInvite(
      request.authUser.id,
      params.code,
    );
  }
}