import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { SaveReceivingAccountDto } from './dto/save-receiving-account.dto';

const RECEIVING_ACCOUNT_SELECT =
  'id, bank_name, account_name, last4, country, currency, initials, is_default, created_at, updated_at' as const;

type ReceivingAccountRow = {
  id:
    string;

  bank_name:
    string;

  account_name:
    string;

  last4:
    string;

  country:
    string;

  currency:
    string;

  initials:
    string | null;

  is_default:
    boolean;

  created_at:
    string;

  updated_at:
    string;
};

type SaveReceivingAccountResult = {
  status?:
    string;

  accountId?:
    string;

  bankName?:
    string;

  accountName?:
    string;

  last4?:
    string;

  country?:
    string;

  currency?:
    string;

  initials?:
    string | null;

  isDefault?:
    boolean;
};

type ReceivingAccountManagementResult = {
  status?:
    string;

  accountId?:
    string;

  replacementDefaultId?:
    string | null;
};

export type ReceivingAccount = {
  id:
    string;

  bankName:
    string;

  accountName:
    string;

  last4:
    string;

  country:
    string;

  currency:
    string;

  initials?:
    string;

  isDefault:
    boolean;
};

@Injectable()
export class ReceivingAccountsManagementService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async list(
    userId:
      string,
  ): Promise<{
    accounts:
      ReceivingAccount[];
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin
        .from(
          'receiving_accounts',
        )
        .select(
          RECEIVING_ACCOUNT_SELECT,
        )
        .eq(
          'user_id',
          userId,
        )
        .is(
          'disabled_at',
          null,
        );

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load receiving accounts right now.',
      );
    }

    const accounts =
      (
        data ??
        []
      )
        .map(
          (
            row,
          ) =>
            this.readDatabaseAccount(
              row as
                ReceivingAccountRow,
            ),
        )
        .sort(
          (
            a,
            b,
          ) => {
            if (
              a.account
                .isDefault !==
              b.account
                .isDefault
            ) {
              return a.account
                .isDefault
                ? -1
                : 1;
            }

            return (
              Date.parse(
                b.updatedAt,
              ) -
              Date.parse(
                a.updatedAt,
              )
            );
          },
        )
        .map(
          (
            item,
          ) =>
            item.account,
        );

    return {
      accounts,
    };
  }

  async save(
    userId:
      string,

    input:
      SaveReceivingAccountDto,

    idempotencyKey:
      | string
      | undefined,
  ): Promise<{
    account:
      ReceivingAccount;
  }> {
    const cleanKey =
      this.validateIdempotencyKey(
        idempotencyKey,
      );

    const initials =
      input.initials
        ?.trim()
        .toUpperCase() ||
      null;

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'save_receiving_account',
        {
          p_user_id:
            userId,

          p_verification_id:
            input.verificationId,

          p_idempotency_key_hash:
            this.hashIdempotencyKey(
              cleanKey,
            ),

          p_initials:
            initials,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to save the receiving account right now.',
      );
    }

    const result =
      data as
        SaveReceivingAccountResult;

    switch (
      result.status
    ) {
      case 'saved':
      case 'existing':
        return {
          account:
            this.readRpcAccount(
              result,
            ),
        };

      case 'idempotency_conflict':
        throw new ConflictException(
          'This receiving-account save request was already used differently.',
        );

      case 'expired':
        throw new ConflictException(
          'This bank account confirmation expired. Verify the account again.',
        );

      case 'not_available':
        throw new ConflictException(
          'This bank account confirmation is no longer available.',
        );

      case 'not_found':
        throw new NotFoundException(
          'Bank account confirmation not found.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to save this receiving account.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the receiving-account save result.',
        );
    }
  }

  async setDefault(
    userId:
      string,

    receivingAccountId:
      string,
  ): Promise<{
    status:
      'updated';

    accountId:
      string;
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'set_default_receiving_account',
        {
          p_user_id:
            userId,

          p_receiving_account_id:
            receivingAccountId,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to update the default receiving account right now.',
      );
    }

    const result =
      data as
        ReceivingAccountManagementResult;

    switch (
      result.status
    ) {
      case 'updated':
      case 'existing':
        return {
          status:
            'updated',

          accountId:
            receivingAccountId,
        };

      case 'not_found':
        throw new NotFoundException(
          'Receiving account not found.',
        );

      case 'unavailable':
        throw new ConflictException(
          'This receiving account is no longer available.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to update this receiving account.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to update the default receiving account right now.',
        );
    }
  }

  async remove(
    userId:
      string,

    receivingAccountId:
      string,
  ): Promise<{
    status:
      'removed';

    accountId:
      string;

    replacementDefaultId?:
      string;
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'disable_receiving_account',
        {
          p_user_id:
            userId,

          p_receiving_account_id:
            receivingAccountId,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to remove the receiving account right now.',
      );
    }

    const result =
      data as
        ReceivingAccountManagementResult;

    switch (
      result.status
    ) {
      case 'disabled':
      case 'existing': {
        const replacementDefaultId =
          this.optionalUuid(
            result.replacementDefaultId,
          );

        return {
          status:
            'removed',

          accountId:
            receivingAccountId,

          ...(replacementDefaultId
            ? {
                replacementDefaultId,
              }
            : {}),
        };
      }

      case 'not_found':
        throw new NotFoundException(
          'Receiving account not found.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to remove this receiving account.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to remove the receiving account right now.',
        );
    }
  }

  private readDatabaseAccount(
    row:
      ReceivingAccountRow,
  ): {
    account:
      ReceivingAccount;

    updatedAt:
      string;
  } {
    const id =
      this.requiredUuid(
        row.id,
      );

    const bankName =
      this.requiredText(
        row.bank_name,
        160,
      );

    const accountName =
      this.requiredText(
        row.account_name,
        200,
      );

    if (
      !/^[0-9]{4}$/.test(
        row.last4,
      ) ||
      row.country !==
        'NG' ||
      row.currency !==
        'NGN' ||
      typeof row.is_default !==
        'boolean'
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    const initials =
      this.optionalInitials(
        row.initials,
      );

    const createdAt =
      this.requiredTimestamp(
        row.created_at,
      );

    const updatedAt =
      this.requiredTimestamp(
        row.updated_at,
      );

    /*
     * Validate both timestamps even though the public response does not
     * expose them. They are used for deterministic ordering.
     */
    void createdAt;

    return {
      account: {
        id,

        bankName,

        accountName,

        last4:
          row.last4,

        country:
          'NG',

        currency:
          'NGN',

        ...(initials
          ? {
              initials,
            }
          : {}),

        isDefault:
          row.is_default,
      },

      updatedAt,
    };
  }

  private readRpcAccount(
    result:
      SaveReceivingAccountResult,
  ): ReceivingAccount {
    const id =
      this.requiredUuid(
        result.accountId,
      );

    const bankName =
      this.requiredText(
        result.bankName,
        160,
      );

    const accountName =
      this.requiredText(
        result.accountName,
        200,
      );

    if (
      typeof result.last4 !==
        'string' ||
      !/^[0-9]{4}$/.test(
        result.last4,
      ) ||
      result.country !==
        'NG' ||
      result.currency !==
        'NGN' ||
      typeof result.isDefault !==
        'boolean'
    ) {
      throw new ServiceUnavailableException(
        'The saved receiving account could not be loaded safely.',
      );
    }

    const initials =
      this.optionalInitials(
        result.initials,
      );

    return {
      id,

      bankName,

      accountName,

      last4:
        result.last4,

      country:
        'NG',

      currency:
        'NGN',

      ...(initials
        ? {
            initials,
          }
        : {}),

      isDefault:
        result.isDefault,
    };
  }

  private validateIdempotencyKey(
    value:
      | string
      | undefined,
  ) {
    const cleaned =
      value?.trim() ??
      '';

    if (
      !/^[A-Za-z0-9._:-]{8,200}$/.test(
        cleaned,
      )
    ) {
      throw new BadRequestException(
        'A valid Idempotency-Key header is required.',
      );
    }

    return cleaned;
  }

  private hashIdempotencyKey(
    value:
      string,
  ) {
    return createHash(
      'sha256',
    )
      .update(
        value,
        'utf8',
      )
      .digest(
        'hex',
      );
  }

  private requiredUuid(
    value:
      unknown,
  ) {
    if (
      typeof value !==
        'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    return value;
  }

  private optionalUuid(
    value:
      unknown,
  ) {
    if (
      value ===
        null ||
      value ===
        undefined
    ) {
      return null;
    }

    return this.requiredUuid(
      value,
    );
  }

  private requiredText(
    value:
      unknown,

    maxLength:
      number,
  ) {
    if (
      typeof value !==
        'string'
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    const cleaned =
      value.trim();

    if (
      cleaned.length <
        1 ||
      cleaned.length >
        maxLength
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    return cleaned;
  }

  private optionalInitials(
    value:
      unknown,
  ) {
    if (
      value ===
        null ||
      value ===
        undefined ||
      value ===
        ''
    ) {
      return null;
    }

    if (
      typeof value !==
        'string'
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    const cleaned =
      value
        .trim()
        .toUpperCase();

    if (
      cleaned.length <
        1 ||
      cleaned.length >
        6 ||
      !/^\p{L}+$/u.test(
        cleaned,
      )
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    return cleaned;
  }

  private requiredTimestamp(
    value:
      unknown,
  ) {
    if (
      typeof value !==
        'string' ||
      !Number.isFinite(
        Date.parse(
          value,
        ),
      )
    ) {
      throw new ServiceUnavailableException(
        'A receiving account could not be loaded safely.',
      );
    }

    return new Date(
      value,
    ).toISOString();
  }
}