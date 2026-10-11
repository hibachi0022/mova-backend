import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const PAYMENT_SELECT =
  'id, sender_user_id, recipient_user_id, payment_method_id, receiving_account_id, principal_amount_minor, fee_amount_minor, charge_amount_minor, currency, status, provider, provider_reference, provider_transaction_id, provider_amount_minor, provider_requested_amount_minor, provider_channel, provider_paid_at, provider_verified_at, completed_at, failure_reason, created_at, updated_at' as const;

const PAYOUT_SELECT =
  'id, payment_intent_id, status, provider, provider_reference, provider_transfer_code, provider_transfer_id, provider_status, initiated_at, completed_at, failed_at, reversed_at, failure_reason, created_at, updated_at' as const;

type MoneyStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'reversed';

type PaymentRow = {
  id: string;
  sender_user_id: string;
  recipient_user_id: string;
  payment_method_id: string;
  receiving_account_id: string;
  principal_amount_minor: number | string;
  fee_amount_minor: number | string;
  charge_amount_minor: number | string;
  currency: string;
  status: string;
  provider: string | null;
  provider_reference: string | null;
  provider_transaction_id: string | null;
  provider_amount_minor: number | string | null;
  provider_requested_amount_minor: number | string | null;
  provider_channel: string | null;
  provider_paid_at: string | null;
  provider_verified_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type PayoutRow = {
  id: string;
  payment_intent_id: string;
  status: string;
  provider: string;
  provider_reference: string | null;
  provider_transfer_code: string | null;
  provider_transfer_id: string | null;
  provider_status: string | null;
  initiated_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  reversed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
  user_id: string;
  display_name: string;
};

type PaymentMethodRow = {
  id: string;
  network: string;
  last4: string;
};

type ReceivingAccountRow = {
  id: string;
  bank_name: string;
  account_name: string;
  last4: string;
};

export type MoneyTransaction = {
  id: string;

  kind: 'transfer';

  amountMinor: number;

  currency: string;

  status: MoneyStatus;

  counterparty: string;

  createdAt: string;

  reference: string;

  description: string;

  direction:
    | 'in'
    | 'out';

  receivingAccountLabel: string;

  paymentStatus: MoneyStatus;

  payoutStatus?: MoneyStatus;

  feeMinor?: number;

  totalMinor?: number;

  chargedAmountMinor?: number;

  providerFeeMinor?: number;

  paymentMethodLabel?: string;

  events: Array<{
    id: string;
    label: string;
    status: MoneyStatus;
    occurredAt?: string;
    description?: string;
  }>;
};

@Injectable()
export class MoneyActivityService {
  constructor(
    private readonly supabase:
      SupabaseService,
  ) {}

  async list(
    userId: string,
    input: {
      kind?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    const kind =
      this.parseKind(
        input.kind,
      );

    const limit =
      this.parseLimit(
        input.limit,
      );

    const offset =
      this.parseCursor(
        input.cursor,
      );

    if (
      kind !== 'all' &&
      kind !== 'transfer'
    ) {
      return {
        transactions: [],
        nextCursor: null,
        summary: [],
      };
    }

    const admin =
      this.supabase.createAdminClient();

    const fetchLimit =
      Math.min(
        offset +
          limit +
          1,
        500,
      );

    const [
      outgoingResult,
      incomingResult,
    ] =
      await Promise.all([
        admin
          .from(
            'friend_transfer_payment_intents',
          )
          .select(
            PAYMENT_SELECT,
          )
          .eq(
            'sender_user_id',
            userId,
          )
          .order(
            'created_at',
            {
              ascending:
                false,
            },
          )
          .limit(
            fetchLimit,
          ),

        admin
          .from(
            'friend_transfer_payment_intents',
          )
          .select(
            PAYMENT_SELECT,
          )
          .eq(
            'recipient_user_id',
            userId,
          )
          .eq(
            'status',
            'completed',
          )
          .order(
            'created_at',
            {
              ascending:
                false,
            },
          )
          .limit(
            fetchLimit,
          ),
      ]);

    if (
      outgoingResult.error ||
      incomingResult.error
    ) {
      throw new ServiceUnavailableException(
        'Unable to load money activity right now.',
      );
    }

    const allRows = [
      ...(
        outgoingResult.data ??
        []
      ),
      ...(
        incomingResult.data ??
        []
      ),
    ] as PaymentRow[];

    const unique =
      new Map<
        string,
        PaymentRow
      >();

    for (
      const row of allRows
    ) {
      unique.set(
        row.id,
        row,
      );
    }

    const ordered =
      [
        ...unique.values(),
      ].sort(
        (
          a,
          b,
        ) =>
          Date.parse(
            b.created_at,
          ) -
          Date.parse(
            a.created_at,
          ),
      );

    const page =
      ordered.slice(
        offset,
        offset +
          limit,
      );

    const hasMore =
      ordered.length >
      offset +
        limit;

    const transactions =
      await this.hydrate(
        userId,
        page,
      );

    return {
      transactions,

      nextCursor:
        hasMore
          ? String(
              offset +
                limit,
            )
          : null,

      summary: [],
    };
  }

  async get(
    userId: string,
    transactionId: string,
  ): Promise<{
    transaction:
      MoneyTransaction;
  }> {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin
        .from(
          'friend_transfer_payment_intents',
        )
        .select(
          PAYMENT_SELECT,
        )
        .eq(
          'id',
          transactionId,
        )
        .maybeSingle();

    if (error) {
      throw new ServiceUnavailableException(
        'Unable to load this transfer right now.',
      );
    }

    if (!data) {
      throw new NotFoundException(
        'Transfer not found.',
      );
    }

    const row =
      data as PaymentRow;

    const outgoing =
      row.sender_user_id ===
      userId;

    const incoming =
      row.recipient_user_id ===
      userId;

    if (
      !outgoing &&
      !(
        incoming &&
        row.status ===
          'completed'
      )
    ) {
      throw new NotFoundException(
        'Transfer not found.',
      );
    }

    const [
      transaction,
    ] =
      await this.hydrate(
        userId,
        [
          row,
        ],
      );

    if (!transaction) {
      throw new ServiceUnavailableException(
        'Unable to load this transfer safely.',
      );
    }

    return {
      transaction,
    };
  }

  private async hydrate(
    userId: string,
    rows: PaymentRow[],
  ): Promise<
    MoneyTransaction[]
  > {
    if (
      rows.length ===
      0
    ) {
      return [];
    }

    const admin =
      this.supabase.createAdminClient();

    const paymentIds =
      rows.map(
        (
          row,
        ) =>
          row.id,
      );

    const counterpartyIds =
      [
        ...new Set(
          rows.map(
            (
              row,
            ) =>
              row.sender_user_id ===
              userId
                ? row.recipient_user_id
                : row.sender_user_id,
          ),
        ),
      ];

    const paymentMethodIds =
      [
        ...new Set(
          rows
            .filter(
              (
                row,
              ) =>
                row.sender_user_id ===
                userId,
            )
            .map(
              (
                row,
              ) =>
                row.payment_method_id,
            ),
        ),
      ];

    const receivingAccountIds =
      [
        ...new Set(
          rows.map(
            (
              row,
            ) =>
              row.receiving_account_id,
          ),
        ),
      ];

    const {
      data:
        payoutData,
      error:
        payoutError,
    } =
      await admin
        .from(
          'friend_transfer_payouts',
        )
        .select(
          PAYOUT_SELECT,
        )
        .in(
          'payment_intent_id',
          paymentIds,
        );

    if (payoutError) {
      throw new ServiceUnavailableException(
        'Unable to load transfer payout status right now.',
      );
    }

    const {
      data:
        profileData,
      error:
        profileError,
    } =
      await admin
        .from(
          'profiles',
        )
        .select(
          'user_id, display_name',
        )
        .in(
          'user_id',
          counterpartyIds,
        );

    if (profileError) {
      throw new ServiceUnavailableException(
        'Unable to load transfer participants right now.',
      );
    }

    let paymentMethodData:
      PaymentMethodRow[] =
      [];

    if (
      paymentMethodIds.length >
      0
    ) {
      const result =
        await admin
          .from(
            'payment_methods',
          )
          .select(
            'id, network, last4',
          )
          .in(
            'id',
            paymentMethodIds,
          );

      if (result.error) {
        throw new ServiceUnavailableException(
          'Unable to load transfer payment details right now.',
        );
      }

      paymentMethodData =
        (
          result.data ??
          []
        ) as PaymentMethodRow[];
    }

    const {
      data:
        receivingAccountData,
      error:
        receivingAccountError,
    } =
      await admin
        .from(
          'receiving_accounts',
        )
        .select(
          'id, bank_name, account_name, last4',
        )
        .in(
          'id',
          receivingAccountIds,
        );

    if (
      receivingAccountError
    ) {
      throw new ServiceUnavailableException(
        'Unable to load transfer receiving account details right now.',
      );
    }

    const payouts =
      new Map(
        (
          (
            payoutData ??
            []
          ) as PayoutRow[]
        ).map(
          (
            payout,
          ) => [
            payout.payment_intent_id,
            payout,
          ],
        ),
      );

    const profiles =
      new Map(
        (
          (
            profileData ??
            []
          ) as ProfileRow[]
        ).map(
          (
            profile,
          ) => [
            profile.user_id,
            profile,
          ],
        ),
      );

    const methods =
      new Map(
        paymentMethodData.map(
          (
            method,
          ) => [
            method.id,
            method,
          ],
        ),
      );

    const accounts =
      new Map(
        (
          (
            receivingAccountData ??
            []
          ) as
            ReceivingAccountRow[]
        ).map(
          (
            account,
          ) => [
            account.id,
            account,
          ],
        ),
      );

    return rows.map(
      (
        row,
      ) =>
        this.toTransaction(
          userId,
          row,
          payouts.get(
            row.id,
          ),
          profiles,
          methods,
          accounts,
        ),
    );
  }

  private toTransaction(
    userId: string,
    row: PaymentRow,
    payout:
      | PayoutRow
      | undefined,
    profiles:
      Map<
        string,
        ProfileRow
      >,
    methods:
      Map<
        string,
        PaymentMethodRow
      >,
    accounts:
      Map<
        string,
        ReceivingAccountRow
      >,
  ): MoneyTransaction {
    const outgoing =
      row.sender_user_id ===
      userId;

    const counterpartyId =
      outgoing
        ? row.recipient_user_id
        : row.sender_user_id;

    const counterparty =
      profiles.get(
        counterpartyId,
      );

    if (!counterparty) {
      throw new ServiceUnavailableException(
        'A transfer participant could not be loaded safely.',
      );
    }

    const account =
      accounts.get(
        row.receiving_account_id,
      );

    if (
      !account ||
      !/^[0-9]{4}$/.test(
        account.last4,
      )
    ) {
      throw new ServiceUnavailableException(
        'A transfer receiving account could not be loaded safely.',
      );
    }

    const principal =
      this.safeMinorAmount(
        row.principal_amount_minor,
        'amount',
      );

    const movaFee =
      this.safeMinorAmount(
        row.fee_amount_minor,
        'fee',
        true,
      );

    const total =
      this.safeMinorAmount(
        row.charge_amount_minor,
        'total',
      );

    if (
      total !==
      principal +
        movaFee
    ) {
      throw new ServiceUnavailableException(
        'A transfer amount could not be loaded safely.',
      );
    }

    const currency =
      row.currency
        ?.trim()
        .toUpperCase();

    if (
      currency !==
      'NGN'
    ) {
      throw new ServiceUnavailableException(
        'A transfer currency could not be loaded safely.',
      );
    }

    const paymentStatus =
      this.paymentStatus(
        row.status,
      );

    const payoutStatus =
      payout
        ? this.payoutStatus(
            payout.status,
          )
        : row.status ===
              'completed'
          ? 'processing'
          : undefined;

    const status =
      this.overallStatus(
        paymentStatus,
        payoutStatus,
      );

    const receivingAccountLabel =
      `${account.bank_name} •••• ${account.last4}`;

    const transaction:
      MoneyTransaction = {
      id:
        row.id,

      kind:
        'transfer',

      amountMinor:
        principal,

      currency,

      status,

      counterparty:
        counterparty.display_name,

      createdAt:
        this.safeDate(
          row.created_at,
          'creation date',
        ),

      reference:
        row.id,

      description:
        outgoing
          ? `Sent to ${counterparty.display_name}`
          : `Received from ${counterparty.display_name}`,

      direction:
        outgoing
          ? 'out'
          : 'in',

      receivingAccountLabel,

      paymentStatus,

      payoutStatus,

      events:
        this.events(
          outgoing,
          row,
          payout,
          paymentStatus,
          payoutStatus,
          receivingAccountLabel,
        ),
    };

    if (
      outgoing
    ) {
      const method =
        methods.get(
          row.payment_method_id,
        );

      if (
        !method ||
        !/^[0-9]{4}$/.test(
          method.last4,
        )
      ) {
        throw new ServiceUnavailableException(
          'A transfer payment method could not be loaded safely.',
        );
      }

      const charged =
        row.provider_amount_minor ===
          null
          ? total
          : this.safeMinorAmount(
              row.provider_amount_minor,
              'provider charge',
            );

      const requested =
        row.provider_requested_amount_minor ===
          null
          ? total
          : this.safeMinorAmount(
              row.provider_requested_amount_minor,
              'provider requested amount',
            );

      transaction.feeMinor =
        movaFee;

      transaction.totalMinor =
        total;

      transaction.chargedAmountMinor =
        charged;

      transaction.providerFeeMinor =
        Math.max(
          0,
          charged -
            requested,
        );

      transaction.paymentMethodLabel =
        `${method.network.toUpperCase()} •••• ${method.last4}`;
    }

    return transaction;
  }

  private events(
    outgoing: boolean,
    payment: PaymentRow,
    payout:
      | PayoutRow
      | undefined,
    paymentStatus:
      MoneyStatus,
    payoutStatus:
      | MoneyStatus
      | undefined,
    receivingAccountLabel:
      string,
  ) {
    const events:
      MoneyTransaction['events'] =
      [
        {
          id:
            `${payment.id}:created`,

          label:
            'Transfer created',

          status:
            'completed',

          occurredAt:
            this.safeDate(
              payment.created_at,
              'creation date',
            ),
        },
      ];

    events.push({
      id:
        `${payment.id}:payment`,

      label:
        outgoing
          ? 'Card payment'
          : 'Sender payment',

      status:
        paymentStatus,

      occurredAt:
        this.optionalDate(
          payment.provider_paid_at ??
          payment.completed_at,
        ),

      description:
        paymentStatus ===
          'completed'
          ? 'Payment confirmed.'
          : paymentStatus ===
                'failed'
            ? 'Payment was not completed.'
            : 'Payment confirmation is in progress.',
    });

    if (
      payoutStatus
    ) {
      events.push({
        id:
          `${payment.id}:payout`,

        label:
          'Recipient payout',

        status:
          payoutStatus,

        occurredAt:
          this.optionalDate(
            payout?.completed_at ??
            payout?.reversed_at ??
            payout?.failed_at ??
            payout?.initiated_at,
          ),

        description:
          payoutStatus ===
            'completed'
            ? `Sent to ${receivingAccountLabel}.`
            : payoutStatus ===
                  'reversed'
              ? 'The recipient payout was reversed.'
              : payoutStatus ===
                    'failed'
                ? 'The recipient payout was not completed.'
                : `Payout to ${receivingAccountLabel} is processing.`,
      });
    }

    return events;
  }

  private paymentStatus(
    status: string,
  ): MoneyStatus {
    switch (status) {
      case 'created':
        return 'pending';

      case 'processing':
        return 'processing';

      case 'completed':
        return 'completed';

      case 'failed':
      case 'expired':
      case 'cancelled':
        return 'failed';

      default:
        throw new ServiceUnavailableException(
          'A transfer payment status could not be loaded safely.',
        );
    }
  }

  private payoutStatus(
    status: string,
  ): MoneyStatus {
    switch (status) {
      case 'created':
        return 'pending';

      case 'initiating':
      case 'pending':
      case 'otp_required':
      case 'reconciliation_required':
        return 'processing';

      case 'success':
        return 'completed';

      case 'reversed':
        return 'reversed';

      case 'failed':
      case 'blocked':
      case 'abandoned':
      case 'rejected':
        return 'failed';

      default:
        throw new ServiceUnavailableException(
          'A transfer payout status could not be loaded safely.',
        );
    }
  }

  private overallStatus(
    payment:
      MoneyStatus,
    payout:
      | MoneyStatus
      | undefined,
  ): MoneyStatus {
    if (
      payment ===
      'failed'
    ) {
      return 'failed';
    }

    if (
      payment !==
      'completed'
    ) {
      return payment;
    }

    return (
      payout ??
      'processing'
    );
  }

  private safeMinorAmount(
    value:
      | number
      | string
      | null
      | undefined,
    label: string,
    allowZero =
      false,
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
        null ||
      amount ===
        undefined ||
      (
        allowZero
          ? amount < 0
          : amount <= 0
      )
    ) {
      throw new ServiceUnavailableException(
        `A transfer ${label} could not be loaded safely.`,
      );
    }

    return amount;
  }

  private safeDate(
    value: string,
    label: string,
  ) {
    const timestamp =
      Date.parse(
        value,
      );

    if (
      !Number.isFinite(
        timestamp,
      )
    ) {
      throw new ServiceUnavailableException(
        `A transfer ${label} could not be loaded safely.`,
      );
    }

    return new Date(
      timestamp,
    ).toISOString();
  }

  private optionalDate(
    value:
      | string
      | null
      | undefined,
  ) {
    if (!value) {
      return undefined;
    }

    const timestamp =
      Date.parse(
        value,
      );

    if (
      !Number.isFinite(
        timestamp,
      )
    ) {
      return undefined;
    }

    return new Date(
      timestamp,
    ).toISOString();
  }

  private parseKind(
    value:
      | string
      | undefined,
  ) {
    const kind =
      (
        value ??
        'all'
      )
        .trim()
        .toLowerCase();

    const allowed =
      new Set([
        'all',
        'transfer',
        'payment',
        'reimbursement',
        'payout',
        'refund',
        'fee',
      ]);

    if (
      !allowed.has(
        kind,
      )
    ) {
      throw new BadRequestException(
        'Invalid money activity type.',
      );
    }

    return kind;
  }

  private parseLimit(
    value:
      | string
      | undefined,
  ) {
    if (!value) {
      return 25;
    }

    if (
      !/^\d+$/.test(
        value,
      )
    ) {
      throw new BadRequestException(
        'Invalid money activity limit.',
      );
    }

    const limit =
      Number(
        value,
      );

    if (
      !Number.isSafeInteger(
        limit,
      ) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new BadRequestException(
        'Money activity limit must be between 1 and 50.',
      );
    }

    return limit;
  }

  private parseCursor(
    value:
      | string
      | undefined,
  ) {
    if (!value) {
      return 0;
    }

    if (
      !/^\d+$/.test(
        value,
      )
    ) {
      throw new BadRequestException(
        'Invalid money activity cursor.',
      );
    }

    const cursor =
      Number(
        value,
      );

    if (
      !Number.isSafeInteger(
        cursor,
      ) ||
      cursor < 0 ||
      cursor > 450
    ) {
      throw new BadRequestException(
        'Invalid money activity cursor.',
      );
    }

    return cursor;
  }
}