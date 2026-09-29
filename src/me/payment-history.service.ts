import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const PAYMENT_HISTORY_SELECT =
  'id, outing_id, payer_user_id, amount_minor, currency, method_id, provider, provider_reference, provider_transaction_id, provider_amount_minor, provider_requested_amount_minor, provider_currency, provider_channel, provider_paid_at, completed_at' as const;

const OUTING_HISTORY_SELECT =
  'id, title, location, starts_at' as const;

type MembershipRow = {
  outing_id: string;
};

type PaymentRow = {
  id: string;
  outing_id: string;

  payer_user_id:
    | string
    | null;

  amount_minor:
    | number
    | string;

  currency: string;

  method_id: string;

  provider:
    | string
    | null;

  provider_reference:
    | string
    | null;

  provider_transaction_id:
    | string
    | null;

  provider_amount_minor:
    | number
    | string
    | null;

  provider_requested_amount_minor:
    | number
    | string
    | null;

  provider_currency:
    | string
    | null;

  provider_channel:
    | string
    | null;

  provider_paid_at:
    | string
    | null;

  completed_at:
    | string
    | null;
};

type OutingRow = {
  id: string;
  title: string;
  location: string;
  starts_at: string;
};

export type PaymentHistoryItem = {
  receiptId: string;

  outing: {
    id: string;
    title: string;
    location: string;
    startsAt: string;
  };

  requestedAmountMinor: number;

  chargedAmountMinor: number;

  feeAmountMinor: number;

  currency: string;

  methodId: string;

  provider: string;

  providerReference: string;

  providerTransactionId:
    | string
    | null;

  providerChannel:
    | string
    | null;

  paidAt: string;

  isPayer: boolean;
};

@Injectable()
export class PaymentHistoryService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async list(
    userId: string,
  ): Promise<{
    payments:
      PaymentHistoryItem[];
  }> {
    const admin =
      this.supabase.createAdminClient();

    /*
     * Only expose payment history for outings the caller is currently
     * an active registered member of.
     *
     * This matches the same access rule used by the receipt endpoint.
     */
    const {
      data:
        membershipData,
      error:
        membershipError,
    } =
      await admin
        .from(
          'outing_members',
        )
        .select(
          'outing_id',
        )
        .eq(
          'user_id',
          userId,
        )
        .is(
          'removed_at',
          null,
        );

    if (
      membershipError
    ) {
      throw new ServiceUnavailableException(
        'Unable to load payment history right now.',
      );
    }

    const outingIds =
      [
        ...new Set(
          (
            (
              membershipData ??
              []
            ) as
              MembershipRow[]
          ).map(
            (
              row,
            ) =>
              row.outing_id,
          ),
        ),
      ];

    if (
      outingIds.length ===
      0
    ) {
      return {
        payments:
          [],
      };
    }

    /*
     * The database guarantees at most one completed payment per outing.
     */
    const {
      data:
        paymentData,
      error:
        paymentError,
    } =
      await admin
        .from(
          'outing_payment_intents',
        )
        .select(
          PAYMENT_HISTORY_SELECT,
        )
        .in(
          'outing_id',
          outingIds,
        )
        .eq(
          'status',
          'completed',
        )
        .order(
          'completed_at',
          {
            ascending:
              false,
          },
        )
        .limit(
          100,
        );

    if (
      paymentError
    ) {
      throw new ServiceUnavailableException(
        'Unable to load payment history right now.',
      );
    }

    const payments =
      (
        paymentData ??
        []
      ) as
        PaymentRow[];

    if (
      payments.length ===
      0
    ) {
      return {
        payments:
          [],
      };
    }

    const completedOutingIds =
      [
        ...new Set(
          payments.map(
            (
              payment,
            ) =>
              payment.outing_id,
          ),
        ),
      ];

    const {
      data:
        outingData,
      error:
        outingError,
    } =
      await admin
        .from(
          'outings',
        )
        .select(
          OUTING_HISTORY_SELECT,
        )
        .in(
          'id',
          completedOutingIds,
        );

    if (
      outingError
    ) {
      throw new ServiceUnavailableException(
        'Unable to load payment history right now.',
      );
    }

    const outings =
      new Map(
        (
          (
            outingData ??
            []
          ) as
            OutingRow[]
        ).map(
          (
            outing,
          ) => [
            outing.id,
            outing,
          ],
        ),
      );

    const history =
      payments.map(
        (
          payment,
        ):
          PaymentHistoryItem => {
          const outing =
            outings.get(
              payment.outing_id,
            );

          if (
            !outing
          ) {
            throw new ServiceUnavailableException(
              'A payment history record could not be loaded safely.',
            );
          }

          const requestedAmountMinor =
            this.safeMinorAmount(
              payment
                .provider_requested_amount_minor ??
                payment.amount_minor,
              'requested amount',
            );

          const chargedAmountMinor =
            this.safeMinorAmount(
              payment
                .provider_amount_minor ??
                payment.amount_minor,
              'charged amount',
            );

          const currency =
            (
              payment.provider_currency ??
              payment.currency
            )
              .trim()
              .toUpperCase();

          if (
            !/^[A-Z]{3}$/.test(
              currency,
            )
          ) {
            throw new ServiceUnavailableException(
              'A payment history currency could not be loaded safely.',
            );
          }

          if (
            !payment.provider ||
            !payment.provider_reference
          ) {
            throw new ServiceUnavailableException(
              'A completed payment provider record is incomplete.',
            );
          }

          const paidAt =
            payment.provider_paid_at ??
            payment.completed_at;

          if (
            !paidAt ||
            !Number.isFinite(
              Date.parse(
                paidAt,
              ),
            )
          ) {
            throw new ServiceUnavailableException(
              'A payment history date could not be loaded safely.',
            );
          }

          if (
            !Number.isFinite(
              Date.parse(
                outing.starts_at,
              ),
            )
          ) {
            throw new ServiceUnavailableException(
              'An outing date could not be loaded safely.',
            );
          }

          return {
            receiptId:
              payment.id,

            outing: {
              id:
                outing.id,

              title:
                outing.title,

              location:
                outing.location,

              startsAt:
                new Date(
                  outing.starts_at,
                ).toISOString(),
            },

            requestedAmountMinor,

            chargedAmountMinor,

            feeAmountMinor:
              Math.max(
                0,
                chargedAmountMinor -
                  requestedAmountMinor,
              ),

            currency,

            methodId:
              payment.method_id,

            provider:
              payment.provider,

            providerReference:
              payment.provider_reference,

            providerTransactionId:
              payment.provider_transaction_id,

            providerChannel:
              payment.provider_channel,

            paidAt:
              new Date(
                paidAt,
              ).toISOString(),

            isPayer:
              payment.payer_user_id ===
              userId,
          };
        },
      );

    return {
      payments:
        history,
    };
  }

  private safeMinorAmount(
    value:
      | number
      | string
      | null
      | undefined,

    label: string,
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
      (amount ?? 0) <=
        0
    ) {
      throw new ServiceUnavailableException(
        `The payment history ${label} could not be loaded safely.`,
      );
    }

    return amount as number;
  }
}