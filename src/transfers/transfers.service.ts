import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateTransferQuoteDto } from './dto/create-transfer-quote.dto';

type PrepareTransferQuoteResult = {
  status?:
    string;

  quoteId?:
    string;

  recipientId?:
    string;

  paymentMethodId?:
    string;

  amountMinor?:
    number | string;

  feeMinor?:
    number | string;

  totalMinor?:
    number | string;

  currency?:
    string;

  expiresAt?:
    string;
};

export type TransferQuote = {
  id:
    string;

  recipientId:
    string;

  paymentMethodId:
    string;

  amountMinor:
    number;

  feeMinor:
    number;

  totalMinor:
    number;

  currency:
    'NGN';

  expiresAt:
    string;
};

@Injectable()
export class TransfersService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async createQuote(
    senderUserId:
      string,

    input:
      CreateTransferQuoteDto,
  ): Promise<
    TransferQuote
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'prepare_friend_transfer_quote',
        {
          p_sender_user_id:
            senderUserId,

          p_recipient_user_id:
            input.recipientId,

          p_payment_method_id:
            input.paymentMethodId,

          p_amount_minor:
            input.amountMinor,

          p_currency:
            input.currency,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to prepare the transfer quote right now.',
      );
    }

    const result =
      data as
        PrepareTransferQuoteResult;

    switch (
      result.status
    ) {
      case 'created':
        return this.readQuote(
          result,
          input,
        );

      case 'not_found':
        throw new NotFoundException(
          'The transfer recipient could not be found.',
        );

      case 'not_friends':
        throw new ConflictException(
          'You can only send money to an accepted friend.',
        );

      case 'blocked':
        throw new ForbiddenException(
          'Money transfers are unavailable between these accounts.',
        );

      case 'payment_method_not_found':
        throw new NotFoundException(
          'Saved payment method not found.',
        );

      case 'payment_method_unavailable':
        throw new ConflictException(
          'This saved payment method is no longer available.',
        );

      case 'payment_method_expired':
        throw new ConflictException(
          'This saved card has expired. Use another payment method.',
        );

      case 'recipient_no_receiving_account':
        throw new ConflictException(
          'This friend has not set up a receiving account yet.',
        );

      case 'invalid':
        throw new BadRequestException(
          'Unable to prepare this transfer quote.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the transfer quote state.',
        );
    }
  }

  private readQuote(
    result:
      PrepareTransferQuoteResult,

    input:
      CreateTransferQuoteDto,
  ): TransferQuote {
    const id =
      this.requiredUuid(
        result.quoteId,
      );

    if (
      result.recipientId !==
        input.recipientId ||
      result.paymentMethodId !==
        input.paymentMethodId
    ) {
      throw new ServiceUnavailableException(
        'The transfer quote did not match the requested parties.',
      );
    }

    const amountMinor =
      this.safeMinorAmount(
        result.amountMinor,
        'amount',
        false,
      );

    const feeMinor =
      this.safeMinorAmount(
        result.feeMinor,
        'fee',
        true,
      );

    const totalMinor =
      this.safeMinorAmount(
        result.totalMinor,
        'total',
        false,
      );

    if (
      amountMinor !==
        input.amountMinor ||
      totalMinor !==
        amountMinor +
          feeMinor
    ) {
      throw new ServiceUnavailableException(
        'The transfer quote amount could not be loaded safely.',
      );
    }

    const currency =
      result.currency
        ?.trim()
        .toUpperCase();

    if (
      currency !==
        'NGN' ||
      currency !==
        input.currency
    ) {
      throw new ServiceUnavailableException(
        'The transfer quote currency could not be loaded safely.',
      );
    }

    const expiresAt =
      result.expiresAt;

    if (
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
        'The transfer quote expiration could not be loaded safely.',
      );
    }

    return {
      id,

      recipientId:
        input.recipientId,

      paymentMethodId:
        input.paymentMethodId,

      amountMinor,

      feeMinor,

      totalMinor,

      currency:
        'NGN',

      expiresAt:
        new Date(
          expiresAt,
        ).toISOString(),
    };
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
        'The transfer quote could not be loaded safely.',
      );
    }

    return value;
  }

  private safeMinorAmount(
    value:
      | number
      | string
      | undefined,

    label:
      string,

    allowZero:
      boolean,
  ) {
    const amount =
      typeof value ===
        'string'
        ? Number(
            value,
          )
        : value;

    if (
      !Number.isSafeInteger(
        amount,
      ) ||
      amount ===
        undefined ||
      (
        allowZero
          ? amount < 0
          : amount <= 0
      )
    ) {
      throw new ServiceUnavailableException(
        `The transfer quote ${label} could not be loaded safely.`,
      );
    }

    return amount;
  }
}