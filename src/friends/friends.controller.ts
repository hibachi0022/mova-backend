import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsUUID } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { RespondFriendRequestDto } from './dto/respond-friend-request.dto';
import { SearchFriendsDto } from './dto/search-friends.dto';
import { SendFriendRequestDto } from './dto/send-friend-request.dto';
import { FriendsService } from './friends.service';

class RequestIdParams {
  @IsUUID()
  id!: string;
}

class UserIdParams {
  @IsUUID()
  userId!: string;
}

@Controller('friends')
@UseGuards(AuthGuard)
export class FriendsController {
  constructor(
    private readonly friends: FriendsService,
  ) {}

  @Get()
  @Header(
    'Cache-Control',
    'no-store',
  )
  list(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.friends.listFriends(
      request.authUser.id,
    );
  }

  @Get('requests')
  @Header(
    'Cache-Control',
    'no-store',
  )
  requests(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.friends.listRequests(
      request.authUser.id,
    );
  }

  @Get('search')
  @Header(
    'Cache-Control',
    'no-store',
  )
  @Throttle({
    default: {
      limit: 20,
      ttl: 60_000,
    },
  })
  search(
    @Req()
    request: AuthenticatedRequest,
    @Query()
    query: SearchFriendsDto,
  ) {
    return this.friends.search(
      request.authUser.id,
      query.q,
    );
  }

  @Post('requests')
  @HttpCode(HttpStatus.OK)
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
  sendRequest(
    @Req()
    request: AuthenticatedRequest,
    @Body()
    input: SendFriendRequestDto,
  ) {
    return this.friends.sendRequest(
      request.authUser.id,
      input.recipientId,
    );
  }

  @Post('requests/:id/respond')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  respond(
    @Req()
    request: AuthenticatedRequest,
    @Param()
    params: RequestIdParams,
    @Body()
    input: RespondFriendRequestDto,
  ) {
    return this.friends.respondRequest(
      request.authUser.id,
      params.id,
      input.accept,
    );
  }

  @Delete('requests/:id')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  cancel(
    @Req()
    request: AuthenticatedRequest,
    @Param()
    params: RequestIdParams,
  ) {
    return this.friends.cancelRequest(
      request.authUser.id,
      params.id,
    );
  }

  @Post(':userId/block')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  block(
    @Req()
    request: AuthenticatedRequest,
    @Param()
    params: UserIdParams,
  ) {
    return this.friends.blockUser(
      request.authUser.id,
      params.userId,
    );
  }

  @Delete(':userId/block')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  unblock(
    @Req()
    request: AuthenticatedRequest,
    @Param()
    params: UserIdParams,
  ) {
    return this.friends.unblockUser(
      request.authUser.id,
      params.userId,
    );
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store',
  )
  removeFriend(
    @Req()
    request: AuthenticatedRequest,
    @Param()
    params: UserIdParams,
  ) {
    return this.friends.removeFriend(
      request.authUser.id,
      params.userId,
    );
  }
}