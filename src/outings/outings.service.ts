import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { AddOutingGuestDto } from './dto/add-outing-guest.dto';
import { CreateOutingDto } from './dto/create-outing.dto';

const OUTING_SELECT =
  'id, created_by_user_id, title, location, starts_at, currency, amount_minor, selected_member_id, status, created_at' as const;

const OUTING_MEMBER_SELECT =
  'id, outing_id, user_id, guest_display_name, role, opted_in, joined_at, removed_at' as const;

type OutingRow = {
  id: string;
  created_by_user_id:
    | string
    | null;
  title: string;
  location: string;
  starts_at: string;
  currency: string;
  amount_minor:
    | number
    | string;
  selected_member_id:
    | string
    | null;
  status: string;
  created_at: string;
};

type OutingMemberRow = {
  id: string;
  outing_id: string;
  user_id:
    | string
    | null;
  guest_display_name:
    | string
    | null;
  role: string;
  opted_in: boolean;
  joined_at: string;
  removed_at:
    | string
    | null;
};

type ProfileRow = {
  user_id: string;
  display_name: string;
};

type MembershipLookupRow = {
  outing_id: string;
  joined_at: string;
};

type OutingRpcResult = {
  status?: string;
  outingId?: string;
  memberId?: string;
  codeId?: string;
  expiresAt?: string;
  optedIn?: boolean;
};

export type OutingMemberResponse = {
  id: string;
  displayName: string;
  optedIn: boolean;
};

export type OutingResponse = {
  id: string;
  title: string;
  location: string;
  startsAt: string;
  currency: string;
  amountMinor: number;
  members:
    OutingMemberResponse[];
  selectedMemberId?: string;
};

export type OutingInviteResponse = {
  code: string;
  expiresAt: string;
  joinUrl: string;
};

@Injectable()
export class OutingsService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async create(
    userId: string,
    input: CreateOutingDto,
  ): Promise<OutingResponse> {
    const startsAt =
      Date.parse(
        input.startsAt,
      );

    if (
      !Number.isFinite(
        startsAt,
      ) ||
      startsAt <=
        Date.now()
    ) {
      throw new BadRequestException(
        'Choose a future date and time for the outing.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('outings')
      .insert({
        created_by_user_id:
          userId,
        title:
          input.title,
        location:
          input.location,
        starts_at:
          input.startsAt,
        currency:
          input.currency,
        amount_minor:
          input.amountMinor,
      })
      .select(
        OUTING_SELECT,
      )
      .single();

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to create the outing right now.',
      );
    }

    const outings =
      await this.hydrateOutings(
        [
          data as OutingRow,
        ],
      );

    const outing =
      outings[0];

    if (!outing) {
      throw new ServiceUnavailableException(
        'The outing was created but could not be loaded.',
      );
    }

    return outing;
  }

  async list(
    userId: string,
  ): Promise<{
    outings: OutingResponse[];
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data:
        membershipData,
      error:
        membershipError,
    } = await admin
      .from(
        'outing_members',
      )
      .select(
        'outing_id, joined_at',
      )
      .eq(
        'user_id',
        userId,
      )
      .is(
        'removed_at',
        null,
      )
      .order(
        'joined_at',
        {
          ascending:
            false,
        },
      );

    if (membershipError) {
      throw new ServiceUnavailableException(
        'Unable to load your outings right now.',
      );
    }

    const memberships =
      (
        membershipData ??
        []
      ) as MembershipLookupRow[];

    const outingIds =
      [
        ...new Set(
          memberships.map(
            (membership) =>
              membership.outing_id,
          ),
        ),
      ];

    if (
      outingIds.length ===
      0
    ) {
      return {
        outings: [],
      };
    }

    const {
      data,
      error,
    } = await admin
      .from('outings')
      .select(
        OUTING_SELECT,
      )
      .in(
        'id',
        outingIds,
      )
      .order(
        'starts_at',
        {
          ascending:
            true,
        },
      );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load your outings right now.',
      );
    }

    const outings =
      await this.hydrateOutings(
        (
          data ??
          []
        ) as OutingRow[],
      );

    return {
      outings,
    };
  }

  async get(
    userId: string,
    outingId: string,
  ): Promise<OutingResponse> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data:
        membership,
      error:
        membershipError,
    } = await admin
      .from(
        'outing_members',
      )
      .select('id')
      .eq(
        'outing_id',
        outingId,
      )
      .eq(
        'user_id',
        userId,
      )
      .is(
        'removed_at',
        null,
      )
      .maybeSingle();

    if (membershipError) {
      throw new ServiceUnavailableException(
        'Unable to load this outing right now.',
      );
    }

    if (!membership) {
      throw new NotFoundException(
        'Outing not found.',
      );
    }

    return this.loadOutingById(
      outingId,
    );
  }

  async addGuest(
    actorId: string,
    outingId: string,
    input: AddOutingGuestDto,
  ): Promise<OutingResponse> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'add_outing_guest',
      {
        p_actor_id:
          actorId,
        p_outing_id:
          outingId,
        p_display_name:
          input.displayName,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to add this guest right now.',
      );
    }

    const result =
      data as OutingRpcResult;

    switch (
      result.status
    ) {
      case 'added':
        return this.get(
          actorId,
          outingId,
        );

      case 'invalid':
        throw new BadRequestException(
          'Enter a valid guest name.',
        );

      case 'not_found':
        throw new NotFoundException(
          'Outing not found.',
        );

      case 'forbidden':
        throw new ForbiddenException(
          'You do not have permission to add guests to this outing.',
        );

      case 'inactive':
        throw new ConflictException(
          'Guests cannot be added to this outing right now.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to add this guest right now.',
        );
    }
  }

  async createInvite(
    actorId: string,
    outingId: string,
  ): Promise<OutingInviteResponse> {
    /*
     * Five random bytes represented as
     * uppercase hexadecimal gives a
     * user-friendly 10-character code.
     *
     * Example:
     * A41D8073F2
     */
    const code =
      randomBytes(5)
        .toString('hex')
        .toUpperCase();

    const codeHash =
      this.hashInviteCode(
        code,
      );

    const expiresAt =
      new Date(
        Date.now() +
          24 *
            60 *
            60 *
            1000,
      ).toISOString();

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'create_outing_join_code',
      {
        p_actor_id:
          actorId,
        p_outing_id:
          outingId,
        p_code_hash:
          codeHash,
        p_code_hint:
          code.slice(-4),
        p_expires_at:
          expiresAt,
        p_max_uses:
          100,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to generate an invitation right now.',
      );
    }

    const result =
      data as OutingRpcResult;

    switch (
      result.status
    ) {
      case 'created':
        return {
          code,
          expiresAt:
            typeof result.expiresAt ===
            'string'
              ? result.expiresAt
              : expiresAt,
          joinUrl:
            `mova://join?code=${encodeURIComponent(
              code,
            )}`,
        };

      case 'not_found':
        throw new NotFoundException(
          'Outing not found.',
        );

      case 'forbidden':
        throw new ForbiddenException(
          'You do not have permission to create invitations for this outing.',
        );

      case 'inactive':
        throw new ConflictException(
          'Invitations cannot be created for this outing right now.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to create this invitation.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to generate an invitation right now.',
        );
    }
  }

  async lookupInvite(
    code: string,
  ): Promise<OutingResponse> {
    const normalized =
      this.normalizeInviteCode(
        code,
      );

    if (
      !/^[A-F0-9]{10}$/.test(
        normalized,
      )
    ) {
      throw new NotFoundException(
        'Invitation not found or expired.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'lookup_outing_join_code',
      {
        p_code_hash:
          this.hashInviteCode(
            normalized,
          ),
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to look up this invitation right now.',
      );
    }

    const result =
      data as OutingRpcResult;

    if (
      result.status !==
        'ready' ||
      typeof result.outingId !==
        'string'
    ) {
      throw new NotFoundException(
        'Invitation not found or expired.',
      );
    }

    /*
     * A valid invitation code acts as
     * permission to preview the outing.
     *
     * Membership is still required for
     * normal GET /outings/:id access.
     */
    return this.loadOutingById(
      result.outingId,
    );
  }

  async joinInvite(
    userId: string,
    code: string,
  ): Promise<OutingResponse> {
    const normalized =
      this.normalizeInviteCode(
        code,
      );

    if (
      !/^[A-F0-9]{10}$/.test(
        normalized,
      )
    ) {
      throw new NotFoundException(
        'Invitation not found or expired.',
      );
    }

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'join_outing_with_code',
      {
        p_code_hash:
          this.hashInviteCode(
            normalized,
          ),
        p_user_id:
          userId,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to join this outing right now.',
      );
    }

    const result =
      data as OutingRpcResult;

    switch (
      result.status
    ) {
      case 'joined':
      case 'already_member':
        if (
          typeof result.outingId !==
          'string'
        ) {
          throw new ServiceUnavailableException(
            'The outing membership could not be loaded.',
          );
        }

        return this.get(
          userId,
          result.outingId,
        );

      case 'blocked':
        /*
         * Do not reveal which user
         * created the block.
         */
        throw new ConflictException(
          'Unable to join this outing with this invitation.',
        );

      case 'inactive':
        throw new ConflictException(
          'This outing is not accepting new members.',
        );

      case 'invalid':
        throw new NotFoundException(
          'Invitation not found or expired.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to join this outing right now.',
        );
    }
  }

  async setConsent(
    userId: string,
    outingId: string,
    optedIn: boolean,
  ): Promise<OutingResponse> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin.rpc(
      'set_outing_member_consent',
      {
        p_user_id:
          userId,
        p_outing_id:
          outingId,
        p_opted_in:
          optedIn,
      },
    );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to update payer-selection consent right now.',
      );
    }

    const result =
      data as OutingRpcResult;

    switch (
      result.status
    ) {
      case 'updated':
        return this.get(
          userId,
          outingId,
        );

      case 'not_found':
        throw new NotFoundException(
          'Outing membership not found.',
        );

      case 'not_available':
        throw new ConflictException(
          'Payer selection is not available for this outing.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to update payer-selection consent.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to update payer-selection consent right now.',
        );
    }
  }

  private normalizeInviteCode(
    code: string,
  ) {
    return code
      .trim()
      .toUpperCase();
  }

  private hashInviteCode(
    code: string,
  ) {
    return createHash(
      'sha256',
    )
      .update(
        this.normalizeInviteCode(
          code,
        ),
        'utf8',
      )
      .digest('hex');
  }

  private async loadOutingById(
    outingId: string,
  ): Promise<OutingResponse> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } = await admin
      .from('outings')
      .select(
        OUTING_SELECT,
      )
      .eq(
        'id',
        outingId,
      )
      .maybeSingle();

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load this outing right now.',
      );
    }

    if (!data) {
      throw new NotFoundException(
        'Outing not found.',
      );
    }

    const outings =
      await this.hydrateOutings(
        [
          data as OutingRow,
        ],
      );

    const outing =
      outings[0];

    if (!outing) {
      throw new NotFoundException(
        'Outing not found.',
      );
    }

    return outing;
  }

  private async hydrateOutings(
    rows: OutingRow[],
  ): Promise<
    OutingResponse[]
  > {
    if (
      rows.length ===
      0
    ) {
      return [];
    }

    const admin =
      this.supabase.createAdminClient();

    const outingIds =
      rows.map(
        (row) =>
          row.id,
      );

    const {
      data:
        memberData,
      error:
        memberError,
    } = await admin
      .from(
        'outing_members',
      )
      .select(
        OUTING_MEMBER_SELECT,
      )
      .in(
        'outing_id',
        outingIds,
      )
      .is(
        'removed_at',
        null,
      )
      .order(
        'joined_at',
        {
          ascending:
            true,
        },
      );

    if (memberError) {
      throw new ServiceUnavailableException(
        'Unable to load outing members right now.',
      );
    }

    const members =
      (
        memberData ??
        []
      ) as OutingMemberRow[];

    const profileIds =
      [
        ...new Set(
          members
            .map(
              (member) =>
                member.user_id,
            )
            .filter(
              (
                id,
              ): id is string =>
                id !== null,
            ),
        ),
      ];

    const profiles =
      new Map<
        string,
        ProfileRow
      >();

    if (
      profileIds.length >
      0
    ) {
      const {
        data:
          profileData,
        error:
          profileError,
      } = await admin
        .from('profiles')
        .select(
          'user_id, display_name',
        )
        .in(
          'user_id',
          profileIds,
        );

      if (
        profileError
      ) {
        throw new ServiceUnavailableException(
          'Unable to load outing members right now.',
        );
      }

      for (
        const profile of
          (
            profileData ??
            []
          ) as ProfileRow[]
      ) {
        profiles.set(
          profile.user_id,
          profile,
        );
      }
    }

    const membersByOuting =
      new Map<
        string,
        OutingMemberResponse[]
      >();

    for (
      const member of
        members
    ) {
      let displayName:
        | string
        | undefined;

      if (
        member.user_id
      ) {
        displayName =
          profiles.get(
            member.user_id,
          )?.display_name;
      } else {
        displayName =
          member.guest_display_name ??
          undefined;
      }

      if (!displayName) {
        throw new ServiceUnavailableException(
          'An outing member profile could not be loaded.',
        );
      }

      const existing =
        membersByOuting.get(
          member.outing_id,
        ) ?? [];

      existing.push({
        id:
          member.id,
        displayName,
        optedIn:
          member.opted_in,
      });

      membersByOuting.set(
        member.outing_id,
        existing,
      );
    }

    return rows.map(
      (row) => {
        const amountMinor =
          typeof row.amount_minor ===
          'string'
            ? Number(
                row.amount_minor,
              )
            : row.amount_minor;

        if (
          !Number.isSafeInteger(
            amountMinor,
          ) ||
          amountMinor < 0
        ) {
          throw new ServiceUnavailableException(
            'The outing amount could not be loaded safely.',
          );
        }

        return {
          id:
            row.id,
          title:
            row.title,
          location:
            row.location,
          startsAt:
            row.starts_at,
          currency:
            row.currency,
          amountMinor,
          members:
            membersByOuting.get(
              row.id,
            ) ?? [],
          ...(row.selected_member_id
            ? {
                selectedMemberId:
                  row.selected_member_id,
              }
            : {}),
        };
      },
    );
  }
}