import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ResolveReceivingAccountDto } from '../receiving-accounts/dto/resolve-receiving-account.dto';
import { SaveReceivingAccountDto } from '../receiving-accounts/dto/save-receiving-account.dto';
import { ReceivingAccountsManagementService } from '../receiving-accounts/receiving-accounts-management.service';
import { ReceivingAccountsService } from '../receiving-accounts/receiving-accounts.service';
import { AccountService } from './account.service';
import { CredentialService } from './credential.service';
import { CredentialChangeDto } from './dto/credential-change.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { SocialSettingsDto } from './dto/social-settings.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { PaymentHistoryService } from './payment-history.service';
import { PaymentMethodSetupStatusService } from './payment-method-setup-status.service';
import { PaymentMethodSetupService } from './payment-method-setup.service';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentRecipientsService } from './payment-recipients.service';
import { ProfileService } from './profile.service';
import { SocialService } from './social.service';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly profileService:
      ProfileService,

    private readonly credentialService:
      CredentialService,

    private readonly accountService:
      AccountService,

    private readonly socialService:
      SocialService,

    private readonly paymentRecipientsService:
      PaymentRecipientsService,

    private readonly paymentHistoryService:
      PaymentHistoryService,

    private readonly paymentMethodsService:
      PaymentMethodsService,

    private readonly paymentMethodSetupService:
      PaymentMethodSetupService,

    private readonly paymentMethodSetupStatusService:
      PaymentMethodSetupStatusService,

    private readonly receivingAccountsService:
      ReceivingAccountsService,

    private readonly receivingAccountsManagementService:
      ReceivingAccountsManagementService,
  ) {}

  @Patch()
  @Header(
    'Cache-Control',
    'no-store',
  )
  update(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      UpdateProfileDto,
  ) {
    return this.profileService.updateUser(
      request.authUser,
      input,
    );
  }

  @Get('social-settings')
  @Header(
    'Cache-Control',
    'no-store',
  )
  socialSettings(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.socialService.getSettings(
      request.authUser.id,
    );
  }

  @Patch('social-settings')
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
  updateSocialSettings(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      SocialSettingsDto,
  ) {
    return this.socialService.updateSettings(
      request.authUser.id,
      input,
    );
  }

  @Get('payment-methods')
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
  paymentMethods(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.paymentMethodsService.list(
      request.authUser.id,
    );
  }

  @Post(
    'payment-methods/setup',
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
  setupPaymentMethod(
    @Req()
    request:
      AuthenticatedRequest,

    @Headers(
      'idempotency-key',
    )
    idempotencyKey:
      | string
      | undefined,
  ) {
    return this.paymentMethodSetupService.create(
      request.authUser.id,
      request.authUser.email,
      idempotencyKey,
    );
  }

  @Get(
    'payment-methods/setup/status',
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
  paymentMethodSetupStatus(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.paymentMethodSetupStatusService.getLatest(
      request.authUser.id,
    );
  }

  @Patch(
    'payment-methods/:id/default',
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
  setDefaultPaymentMethod(
    @Req()
    request:
      AuthenticatedRequest,

    @Param(
      'id',
      new ParseUUIDPipe({
        version:
          '4',
      }),
    )
    paymentMethodId:
      string,
  ) {
    return this.paymentMethodsService.setDefault(
      request.authUser.id,
      paymentMethodId,
    );
  }

  @Delete(
    'payment-methods/:id',
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
  removePaymentMethod(
    @Req()
    request:
      AuthenticatedRequest,

    @Param(
      'id',
      new ParseUUIDPipe({
        version:
          '4',
      }),
    )
    paymentMethodId:
      string,
  ) {
    return this.paymentMethodsService.remove(
      request.authUser.id,
      paymentMethodId,
    );
  }

  @Get(
    'receiving-accounts',
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
  receivingAccounts(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.receivingAccountsManagementService.list(
      request.authUser.id,
    );
  }

  @Post(
    'receiving-accounts',
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
  saveReceivingAccount(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      SaveReceivingAccountDto,

    @Headers(
      'idempotency-key',
    )
    idempotencyKey:
      | string
      | undefined,
  ) {
    return this.receivingAccountsManagementService.save(
      request.authUser.id,
      input,
      idempotencyKey,
    );
  }

  @Put(
    'receiving-accounts/:id/default',
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
  setDefaultReceivingAccount(
    @Req()
    request:
      AuthenticatedRequest,

    @Param(
      'id',
      new ParseUUIDPipe({
        version:
          '4',
      }),
    )
    receivingAccountId:
      string,
  ) {
    return this.receivingAccountsManagementService.setDefault(
      request.authUser.id,
      receivingAccountId,
    );
  }

  @Delete(
    'receiving-accounts/:id',
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
  removeReceivingAccount(
    @Req()
    request:
      AuthenticatedRequest,

    @Param(
      'id',
      new ParseUUIDPipe({
        version:
          '4',
      }),
    )
    receivingAccountId:
      string,
  ) {
    return this.receivingAccountsManagementService.remove(
      request.authUser.id,
      receivingAccountId,
    );
  }

  @Post(
    'receiving-accounts/resolve',
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
  resolveReceivingAccount(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      ResolveReceivingAccountDto,
  ) {
    return this.receivingAccountsService.resolve(
      request.authUser.id,
      input,
    );
  }

  @Get('payment-recipients')
  @Header(
    'Cache-Control',
    'no-store',
  )
  paymentRecipients(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.paymentRecipientsService.listRecipients(
      request.authUser.id,
    );
  }

  @Get('payment-history')
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
  paymentHistory(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.paymentHistoryService.list(
      request.authUser.id,
    );
  }

  @Post('credential-changes')
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
  changeCredentials(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      CredentialChangeDto,
  ) {
    return this.credentialService.change(
      request.authUser,
      input,
    );
  }

  @Delete()
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
        3,
      ttl:
        60_000,
    },
  })
  deleteAccount(
    @Req()
    request:
      AuthenticatedRequest,

    @Body()
    input:
      DeleteAccountDto,
  ) {
    return this.accountService.deleteAccount(
      request.authUser,
      input,
    );
  }
}