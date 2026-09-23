import {
  Body,
  Controller,
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
import { CredentialService } from './credential.service';
import { CredentialChangeDto } from './dto/credential-change.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly profileService:
      ProfileService,
    private readonly credentialService:
      CredentialService,
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
}