import {
  Controller,
  Get,
  Header,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { BanksQueryDto } from './dto/banks-query.dto';
import { ReceivingAccountsService } from './receiving-accounts.service';

@Controller(
  'receiving-accounts',
)
@UseGuards(
  AuthGuard,
)
export class ReceivingAccountsController {
  constructor(
    private readonly receivingAccounts:
      ReceivingAccountsService,
  ) {}

  @Get(
    'markets',
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
  markets() {
    return this.receivingAccounts.markets();
  }

  @Get(
    'banks',
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
  banks(
    @Query()
    query:
      BanksQueryDto,
  ) {
    return this.receivingAccounts.banks(
      query.country,
    );
  }
}