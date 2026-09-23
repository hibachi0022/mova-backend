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
  IsUUID,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { CreateOutingDto } from './dto/create-outing.dto';
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
      limit: 10,
      ttl: 60_000,
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
}