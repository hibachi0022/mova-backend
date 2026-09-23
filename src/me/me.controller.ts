import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { AccountService } from './account.service';
import { CredentialService } from './credential.service';
import { CredentialChangeDto } from './dto/credential-change.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { SocialSettingsDto } from './dto/social-settings.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
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
  ) {}

  @Patch()
  @Header(
    'Cache-Control',
    'no-store',
  )
  update(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    input: UpdateProfileDto,
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
    request: AuthenticatedRequest,
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
      limit: 10,
      ttl: 60_000,
    },
  })
  updateSocialSettings(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    input: SocialSettingsDto,
  ) {
    return this.socialService.updateSettings(
      request.authUser.id,
      input,
    );
  }

  @Post('credential-changes')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  changeCredentials(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    input: CredentialChangeDto,
  ) {
    return this.credentialService.change(
      request.authUser,
      input,
    );
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit: 3,
      ttl: 60_000,
    },
  })
  deleteAccount(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    input: DeleteAccountDto,
  ) {
    return this.accountService.deleteAccount(
      request.authUser,
      input,
    );
  }
}