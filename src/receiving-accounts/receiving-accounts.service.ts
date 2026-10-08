import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { ResolveReceivingAccountDto } from './dto/resolve-receiving-account.dto';

type Bank = {
  code:
    string;

  name:
    string;
};

type Market = {
  country:
    'NG';

  name:
    'Nigeria';

  currency:
    'NGN';

  accountNumberMinLength:
    10;

  accountNumberMaxLength:
    10;

  accountNumberFormat:
    'numeric';

  accountNumberLabel:
    'Account number';
};

type PaystackBankResponse = {
  status?:
    boolean;

  data?:
    unknown;

  meta?: {
    next?:
      unknown;
  };
};

type PaystackResolvedAccountResponse = {
  status?:
    boolean;

  data?: {
    account_number?:
      unknown;

    account_name?:
      unknown;
  };
};

type PaystackTransferRecipientResponse = {
  status?:
    boolean;

  data?: {
    active?:
      unknown;

    type?:
      unknown;

    currency?:
      unknown;

    recipient_code?:
      unknown;

    details?: {
      account_number?:
        unknown;

      account_name?:
        unknown;

      bank_code?:
        unknown;

      bank_name?:
        unknown;
    };
  };
};

type StoredVerificationResult = {
  status?:
    string;

  verificationId?:
    string;

  accountName?:
    string;

  bankName?:
    string;

  last4?:
    string;

  country?:
    string;

  currency?:
    string;

  expiresAt?:
    string;
};

type BankCache = {
  expiresAt:
    number;

  banks:
    Bank[];
};

@Injectable()
export class ReceivingAccountsService {
  private readonly secretKey:
    string;

  private bankCache:
    BankCache | null =
    null;

  constructor(
    private readonly config:
      ConfigService,

    private readonly supabase:
      SupabaseService,
  ) {
    this.secretKey =
      this.config
        .get<string>(
          'PAYSTACK_SECRET_KEY',
        )
        ?.trim() ??
      '';
  }

  markets(): {
    markets:
      Market[];
  } {
    return {
      markets: [
        {
          country:
            'NG',

          name:
            'Nigeria',

          currency:
            'NGN',

          accountNumberMinLength:
            10,

          accountNumberMaxLength:
            10,

          accountNumberFormat:
            'numeric',

          accountNumberLabel:
            'Account number',
        },
      ],
    };
  }

  async banks(
    country:
      string,
  ): Promise<{
    banks:
      Bank[];
  }> {
    const cleanCountry =
      country
        .trim()
        .toUpperCase();

    if (
      cleanCountry !==
      'NG'
    ) {
      throw new BadRequestException(
        'This receiving-account market is not supported yet.',
      );
    }

    if (
      this.bankCache &&
      this.bankCache
        .expiresAt >
        Date.now()
    ) {
      return {
        banks:
          this.bankCache
            .banks
            .map(
              (
                bank,
              ) => ({
                ...bank,
              }),
            ),
      };
    }

    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Bank verification is not connected right now.',
      );
    }

    const banks =
      new Map<
        string,
        Bank
      >();

    let next:
      string | null =
      null;

    let pageCount =
      0;

    do {
      pageCount +=
        1;

      if (
        pageCount >
        5
      ) {
        throw new ServiceUnavailableException(
          'The bank list was larger than expected.',
        );
      }

      const url =
        new URL(
          'https://api.paystack.co/bank',
        );

      url.searchParams.set(
        'country',
        'nigeria',
      );

      url.searchParams.set(
        'currency',
        'NGN',
      );

      url.searchParams.set(
        'use_cursor',
        'true',
      );

      url.searchParams.set(
        'perPage',
        '100',
      );

      if (next) {
        url.searchParams.set(
          'next',
          next,
        );
      }

      const response =
        await this.providerFetch(
          url.toString(),
          {
            method:
              'GET',

            headers: {
              Authorization:
                `Bearer ${this.secretKey}`,

              Accept:
                'application/json',
            },
          },
        );

      const body =
        this.parseJson<
          PaystackBankResponse
        >(
          await response.text(),
        );

      if (
        !response.ok ||
        body?.status !==
          true ||
        !Array.isArray(
          body.data,
        )
      ) {
        throw new ServiceUnavailableException(
          'Unable to load supported banks right now.',
        );
      }

      for (
        const candidate of
          body.data
      ) {
        const bank =
          this.readBank(
            candidate,
          );

        if (!bank) {
          continue;
        }

        banks.set(
          bank.code,
          bank,
        );
      }

      next =
        this.cleanString(
          body.meta
            ?.next,
        );
    } while (
      next
    );

    const result =
      [
        ...banks.values(),
      ].sort(
        (
          a,
          b,
        ) =>
          a.name.localeCompare(
            b.name,
            undefined,
            {
              sensitivity:
                'base',
            },
          ),
      );

    if (
      result.length ===
      0
    ) {
      throw new ServiceUnavailableException(
        'No supported Nigerian banks are available right now.',
      );
    }

    this.bankCache = {
      expiresAt:
        Date.now() +
        10 * 60_000,

      banks:
        result,
    };

    return {
      banks:
        result.map(
          (
            bank,
          ) => ({
            ...bank,
          }),
        ),
    };
  }

  async resolve(
    userId:
      string,

    input:
      ResolveReceivingAccountDto,
  ): Promise<{
    verificationId:
      string;

    accountName:
      string;

    bankName:
      string;

    last4:
      string;

    country:
      'NG';

    currency:
      'NGN';

    expiresAt:
      string;
  }> {
    if (
      input.country !==
      'NG'
    ) {
      throw new BadRequestException(
        'This receiving-account market is not supported yet.',
      );
    }

    if (
      input.routingDetails &&
      Object.keys(
        input.routingDetails,
      ).length >
        0
    ) {
      throw new BadRequestException(
        'Routing details are not required for Nigerian bank accounts.',
      );
    }

    if (
      !/^[0-9]{10}$/.test(
        input.accountNumber,
      )
    ) {
      throw new BadRequestException(
        'A valid 10 digit Nigerian account number is required.',
      );
    }

    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Bank verification is not connected right now.',
      );
    }

    const {
      banks,
    } =
      await this.banks(
        'NG',
      );

    const bank =
      banks.find(
        (
          candidate,
        ) =>
          candidate.code ===
          input.bankCode,
      );

    if (!bank) {
      throw new BadRequestException(
        'The selected bank is not supported.',
      );
    }

    const accountName =
      await this.resolveAccountName(
        input.accountNumber,
        bank.code,
      );

    const recipientCode =
      await this.createTransferRecipient(
        {
          accountNumber:
            input.accountNumber,

          accountName,

          bankCode:
            bank.code,
        },
      );

    const last4 =
      input.accountNumber.slice(
        -4,
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'record_receiving_account_verification',
        {
          p_user_id:
            userId,

          p_provider_recipient_code:
            recipientCode,

          p_bank_code:
            bank.code,

          p_bank_name:
            bank.name,

          p_account_name:
            accountName,

          p_last4:
            last4,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'The bank account was verified but could not be prepared for saving.',
      );
    }

    return this.readStoredVerification(
      data as
        StoredVerificationResult,
      accountName,
      bank.name,
      last4,
    );
  }

  private async resolveAccountName(
    accountNumber:
      string,

    bankCode:
      string,
  ) {
    const url =
      new URL(
        'https://api.paystack.co/bank/resolve',
      );

    url.searchParams.set(
      'account_number',
      accountNumber,
    );

    url.searchParams.set(
      'bank_code',
      bankCode,
    );

    const response =
      await this.providerFetch(
        url.toString(),
        {
          method:
            'GET',

          headers: {
            Authorization:
              `Bearer ${this.secretKey}`,

            Accept:
              'application/json',
          },
        },
      );

    const body =
      this.parseJson<
        PaystackResolvedAccountResponse
      >(
        await response.text(),
      );

    if (
      response.status >=
        400 &&
      response.status <
        500 &&
      response.status !==
        429
    ) {
      throw new UnprocessableEntityException(
        'We could not verify this bank account. Check the bank and account number.',
      );
    }

    if (
      !response.ok
    ) {
      throw new ServiceUnavailableException(
        'Bank account verification is temporarily unavailable.',
      );
    }

    if (
      body?.status !==
        true ||
      !body.data
    ) {
      throw new UnprocessableEntityException(
        'We could not verify this bank account. Check the bank and account number.',
      );
    }

    const returnedAccountNumber =
      this.cleanString(
        body.data
          .account_number,
      );

    if (
      returnedAccountNumber !==
      accountNumber
    ) {
      throw new ServiceUnavailableException(
        'The payment provider returned an unexpected bank account.',
      );
    }

    const accountName =
      this.cleanString(
        body.data
          .account_name,
      );

    if (
      !accountName ||
      accountName.length >
        200
    ) {
      throw new ServiceUnavailableException(
        'The verified account holder name could not be loaded safely.',
      );
    }

    return accountName;
  }

  private async createTransferRecipient(
    input: {
      accountNumber:
        string;

      accountName:
        string;

      bankCode:
        string;
    },
  ) {
    const response =
      await this.providerFetch(
        'https://api.paystack.co/transferrecipient',
        {
          method:
            'POST',

          headers: {
            Authorization:
              `Bearer ${this.secretKey}`,

            'Content-Type':
              'application/json',

            Accept:
              'application/json',
          },

          body:
            JSON.stringify({
              type:
                'nuban',

              name:
                input.accountName,

              account_number:
                input.accountNumber,

              bank_code:
                input.bankCode,

              currency:
                'NGN',

              description:
                'MOVA receiving account',
            }),
        },
      );

    const body =
      this.parseJson<
        PaystackTransferRecipientResponse
      >(
        await response.text(),
      );

    if (
      !response.ok ||
      body?.status !==
        true ||
      !body.data
    ) {
      throw new ServiceUnavailableException(
        'The verified bank account could not be prepared for receiving money.',
      );
    }

    const recipientCode =
      this.cleanString(
        body.data
          .recipient_code,
      );

    if (
      !recipientCode ||
      recipientCode.length <
        3 ||
      recipientCode.length >
        200
    ) {
      throw new ServiceUnavailableException(
        'The receiving account provider returned an invalid recipient.',
      );
    }

    if (
      body.data.active ===
        false
    ) {
      throw new ServiceUnavailableException(
        'The receiving account provider returned an inactive recipient.',
      );
    }

    const type =
      this.cleanString(
        body.data.type,
      )
        ?.toLowerCase();

    const currency =
      this.cleanString(
        body.data.currency,
      )
        ?.toUpperCase();

    if (
      type !==
        'nuban' ||
      currency !==
        'NGN'
    ) {
      throw new ServiceUnavailableException(
        'The receiving account provider returned unexpected recipient details.',
      );
    }

    const details =
      body.data
        .details;

    const providerAccountNumber =
      this.cleanString(
        details
          ?.account_number,
      );

    if (
      providerAccountNumber &&
      providerAccountNumber !==
        input.accountNumber
    ) {
      throw new ServiceUnavailableException(
        'The receiving account provider returned an unexpected bank account.',
      );
    }

    const providerBankCode =
      this.cleanString(
        details
          ?.bank_code,
      );

    if (
      providerBankCode &&
      providerBankCode !==
        input.bankCode
    ) {
      throw new ServiceUnavailableException(
        'The receiving account provider returned an unexpected bank.',
      );
    }

    return recipientCode;
  }

  private readStoredVerification(
    result:
      StoredVerificationResult,

    expectedAccountName:
      string,

    expectedBankName:
      string,

    expectedLast4:
      string,
  ) {
    switch (
      result.status
    ) {
      case 'created':
        break;

      case 'not_found':
        throw new ServiceUnavailableException(
          'Your account is not ready to save receiving accounts right now.',
        );

      case 'invalid':
        throw new ServiceUnavailableException(
          'The verified receiving account could not be stored safely.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to prepare the verified receiving account right now.',
        );
    }

    const verificationId =
      result.verificationId;

    const accountName =
      result.accountName;

    const bankName =
      result.bankName;

    const last4 =
      result.last4;

    const country =
      result.country;

    const currency =
      result.currency;

    const expiresAt =
      result.expiresAt;

    if (
      typeof verificationId !==
        'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        verificationId,
      ) ||
      accountName !==
        expectedAccountName ||
      bankName !==
        expectedBankName ||
      last4 !==
        expectedLast4 ||
      country !==
        'NG' ||
      currency !==
        'NGN' ||
      typeof expiresAt !==
        'string' ||
      !Number.isFinite(
        Date.parse(
          expiresAt,
        ),
      ) ||
      Date.parse(
        expiresAt,
      ) <=
        Date.now()
    ) {
      throw new ServiceUnavailableException(
        'The verified receiving account could not be loaded safely.',
      );
    }

    return {
      verificationId,

      accountName,

      bankName,

      last4,

      country:
        'NG' as const,

      currency:
        'NGN' as const,

      expiresAt:
        new Date(
          expiresAt,
        ).toISOString(),
    };
  }

  private readBank(
    value:
      unknown,
  ):
    | Bank
    | null {
    if (
      !value ||
      typeof value !==
        'object' ||
      Array.isArray(
        value,
      )
    ) {
      return null;
    }

    const row =
      value as
        Record<
          string,
          unknown
        >;

    const name =
      this.cleanString(
        row.name,
      );

    const code =
      this.cleanString(
        row.code,
      );

    const currency =
      this.cleanString(
        row.currency,
      )
        ?.toUpperCase();

    const country =
      this.cleanString(
        row.country,
      )
        ?.toLowerCase();

    const type =
      this.cleanString(
        row.type,
      )
        ?.toLowerCase();

    if (
      !name ||
      name.length >
        160 ||
      !code ||
      code.length >
        40 ||
      row.active !==
        true ||
      row.is_deleted ===
        true ||
      currency !==
        'NGN' ||
      country !==
        'nigeria' ||
      type !==
        'nuban'
    ) {
      return null;
    }

    return {
      code,
      name,
    };
  }

  private async providerFetch(
    url:
      string,

    init:
      RequestInit,
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        12_000,
      );

    try {
      return await fetch(
        url,
        {
          ...init,

          signal:
            controller.signal,
        },
      );
    } catch (
      error: unknown
    ) {
      if (
        error instanceof
          Error &&
        error.name ===
          'AbortError'
      ) {
        throw new ServiceUnavailableException(
          'The banking provider request timed out.',
        );
      }

      throw new ServiceUnavailableException(
        'The banking provider is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private cleanString(
    value:
      unknown,
  ) {
    if (
      typeof value !==
        'string'
    ) {
      return null;
    }

    const cleaned =
      value.trim();

    return cleaned ||
      null;
  }

  private parseJson<T>(
    raw:
      string,
  ):
    | T
    | null {
    try {
      return JSON.parse(
        raw,
      ) as T;
    } catch {
      return null;
    }
  }

  private isConfigured() {
    return (
      this.secretKey.startsWith(
        'sk_test_',
      ) ||
      this.secretKey.startsWith(
        'sk_live_',
      )
    );
  }
}