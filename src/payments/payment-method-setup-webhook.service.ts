import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

type PaystackAuthorization = {
  authorization_code?: unknown;
  last4?: unknown;
  exp_month?: unknown;
  exp_year?: unknown;
  channel?: unknown;
  card_type?: unknown;
  bank?: unknown;
  country_code?: unknown;
  brand?: unknown;
  reusable?: unknown;
  signature?: unknown;
};

type PaystackCustomer = {
  email?: unknown;
  customer_code?: unknown;
};

type PaystackVerifyResponse = {
  status?: boolean;
  message?: string;

  data?: {
    id?:
      | string
      | number;

    status?: string;
    reference?: string;

    amount?: number;

    requested_amount?:
      number;

    currency?: string;

    paid_at?:
      | string
      | null;

    channel?: string;

    authorization?:
      PaystackAuthorization;

    customer?:
      PaystackCustomer;
  };
};

type VerifiedTransaction =
  NonNullable<
    PaystackVerifyResponse['data']
  >;

type ReusableCard = {
  customerCode: string;
  email: string;
  authorizationCode: string;
  signature: string;
  network: string;
  last4: string;
  expMonth: number;
  expYear: number;

  bank:
    | string
    | null;

  countryCode:
    | string
    | null;
};

type CompleteSetupResult = {
  status?: string;

  setupId?: string;

  setupStatus?: string;

  paymentMethodId?:
    | string
    | null;

  providerTransactionId?:
    | string
    | null;

  refundStatus?: string;

  providerRefundId?:
    | string
    | null;
};

type BeginRefundResult = {
  status?: string;

  setupId?: string;

  refundStatus?: string;

  providerTransactionId?:
    | string
    | null;

  providerRefundId?:
    | string
    | null;
};

type RecordRefundResult = {
  status?: string;

  setupId?: string;

  refundStatus?: string;

  providerRefundId?:
    | string
    | null;
};

type PaystackRefund = {
  id?: unknown;
  status?: unknown;

  refunded_at?:
    unknown;
};

type PaystackCreateRefundResponse = {
  status?: boolean;
  message?: string;

  data?:
    PaystackRefund;
};

type PaystackListRefundResponse = {
  status?: boolean;
  message?: string;

  data?:
    PaystackRefund[];
};

type NormalizedRefundStatus =
  | 'pending'
  | 'processing'
  | 'needs_attention'
  | 'processed'
  | 'failed';

export type PaymentMethodSetupWebhookResult = {
  received: true;

  status:
    | 'card_setup_completed'
    | 'card_setup_refunded'
    | 'card_setup_failed'
    | 'card_setup_refund_pending'
    | 'ignored';
};

@Injectable()
export class PaymentMethodSetupWebhookService {
  private readonly logger =
    new Logger(
      PaymentMethodSetupWebhookService.name,
    );

  private readonly secretKey:
    string;

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

  isRefundEvent(
    eventName: string,
  ) {
    return [
      'refund.pending',
      'refund.processing',
      'refund.needs-attention',
      'refund.processed',
      'refund.failed',
    ].includes(
      eventName,
    );
  }

  async handleChargeSuccess(
    reference: string,
  ): Promise<
    PaymentMethodSetupWebhookResult
  > {
    if (
      !reference.startsWith(
        'MOVA-CARD-',
      )
    ) {
      return {
        received:
          true,

        status:
          'ignored',
      };
    }

    const verified =
      await this.verifyTransaction(
        reference,
      );

    if (
      verified.status !==
        'success'
    ) {
      throw new ServiceUnavailableException(
        'The card verification payment is not yet verifiable as successful.',
      );
    }

    if (
      verified.reference !==
      reference
    ) {
      throw new ServiceUnavailableException(
        'The verified card setup reference did not match the webhook.',
      );
    }

    const transactionId =
      this.safeTransactionId(
        verified.id,
      );

    const amountMinor =
      this.safeAmount(
        verified.amount,
        'payment amount',
      );

    const requestedAmountMinor =
      this.safeAmount(
        verified.requested_amount,
        'requested payment amount',
      );

    const currency =
      this.safeCurrency(
        verified.currency,
      );

    const channel =
      this.safeChannel(
        verified.channel,
      );

    const paidAt =
      this.safePaidAt(
        verified.paid_at,
      );

    const card =
      this.parseReusableCard(
        verified,
      );

    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'complete_payment_method_setup_from_provider',
        {
          p_provider:
            'paystack',

          p_provider_reference:
            reference,

          p_provider_transaction_id:
            transactionId,

          p_amount_minor:
            amountMinor,

          p_requested_amount_minor:
            requestedAmountMinor,

          p_currency:
            currency,

          p_channel:
            channel,

          p_paid_at:
            paidAt,

          p_provider_customer_code:
            card?.customerCode ??
            '',

          p_provider_email:
            card?.email ??
            '',

          p_provider_authorization_code:
            card?.authorizationCode ??
            '',

          p_provider_signature:
            card?.signature ??
            '',

          p_network:
            card?.network ??
            '',

          p_last4:
            card?.last4 ??
            '',

          p_exp_month:
            card?.expMonth ??
            null,

          p_exp_year:
            card?.expYear ??
            null,

          p_bank:
            card?.bank ??
            null,

          p_country_code:
            card?.countryCode ??
            null,

          p_reusable:
            Boolean(
              card,
            ),
        },
      );

    if (
      error ||
      !data
    ) {
      this.logger.error(
        'Unable to persist verified standalone card setup.',
      );

      throw new ServiceUnavailableException(
        'Unable to complete card verification right now.',
      );
    }

    const result =
      data as
        CompleteSetupResult;

    const setupSucceeded =
      result.status ===
        'completed' ||
      (
        result.status ===
          'existing' &&
        result.setupStatus ===
          'completed'
      );

    switch (
      result.status
    ) {
      case 'completed':
      case 'existing':
      case 'card_unavailable':
      case 'mismatch':
      case 'account_unavailable':
      case 'card_conflict':
        break;

      case 'not_found':
        this.logger.error(
          'A verified MOVA card setup payment did not match a stored setup.',
        );

        throw new ServiceUnavailableException(
          'The verified card setup could not be matched safely.',
        );

      case 'conflict':
        this.logger.error(
          'A verified MOVA card setup payment conflicts with existing provider settlement data.',
        );

        throw new ServiceUnavailableException(
          'The verified card setup requires review.',
        );

      case 'invalid':
        this.logger.error(
          'Verified standalone card setup data was rejected by the database.',
        );

        throw new ServiceUnavailableException(
          'The verified card setup could not be completed safely.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the card setup state.',
        );
    }

    /*
     * Any successfully charged standalone verification transaction
     * must enter the refund workflow, even if the provider did not
     * return a reusable card authorization.
     */
    const refundStatus =
      await this.ensureRefund(
        reference,
      );

    if (
      setupSucceeded
    ) {
      if (
        refundStatus ===
        'processed'
      ) {
        return {
          received:
            true,

          status:
            'card_setup_refunded',
        };
      }

      return {
        received:
          true,

        status:
          'card_setup_completed',
      };
    }

    return {
      received:
        true,

      status:
        'card_setup_failed',
    };
  }

  async handleRefundEvent(
    eventName: string,

    rawData:
      unknown,
  ): Promise<
    PaymentMethodSetupWebhookResult
  > {
    const status =
      this.refundStatusFromEvent(
        eventName,
      );

    if (!status) {
      return {
        received:
          true,

        status:
          'ignored',
      };
    }

    if (
      !rawData ||
      typeof rawData !==
        'object' ||
      Array.isArray(
        rawData,
      )
    ) {
      throw new BadRequestException(
        'Refund webhook data is invalid.',
      );
    }

    const data =
      rawData as
        Record<
          string,
          unknown
        >;

    const reference =
      this.cleanString(
        data.transaction_reference,
      );

    if (
      !reference
    ) {
      throw new BadRequestException(
        'Refund transaction reference is invalid.',
      );
    }

    /*
     * Other Paystack refunds may share the same webhook URL.
     */
    if (
      !reference.startsWith(
        'MOVA-CARD-',
      )
    ) {
      return {
        received:
          true,

        status:
          'ignored',
      };
    }

    const refundedAt =
      this.optionalTimestamp(
        data.refunded_at,
      );

    const recorded =
      await this.recordRefund(
        reference,
        null,
        status,
        refundedAt,
      );

    if (
      recorded ===
        'processed'
    ) {
      return {
        received:
          true,

        status:
          'card_setup_refunded',
      };
    }

    if (
      recorded ===
        'failed' ||
      recorded ===
        'needs_attention'
    ) {
      if (
        recorded ===
        'needs_attention'
      ) {
        this.logger.warn(
          'A MOVA card-verification refund requires customer bank details in Paystack.',
        );
      }

      return {
        received:
          true,

        status:
          'card_setup_failed',
      };
    }

    return {
      received:
        true,

      status:
        'card_setup_refund_pending',
    };
  }

  private async ensureRefund(
    reference: string,
  ): Promise<
    NormalizedRefundStatus
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'begin_payment_method_setup_refund',
        {
          p_provider_reference:
            reference,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to prepare the card verification refund right now.',
      );
    }

    const result =
      data as
        BeginRefundResult;

    switch (
      result.status
    ) {
      case 'ready': {
        const transactionId =
          this.requireTransactionId(
            result.providerTransactionId,
          );

        return this.createRefund(
          reference,
          transactionId,
        );
      }

      case 'existing': {
        const existingStatus =
          this.normalizeRefundStatus(
            result.refundStatus,
          );

        if (
          existingStatus
        ) {
          return existingStatus;
        }

        if (
          result.refundStatus ===
          'initiating'
        ) {
          const transactionId =
            this.requireTransactionId(
              result.providerTransactionId,
            );

          const reconciled =
            await this.reconcileRefund(
              reference,
              transactionId,
            );

          if (
            reconciled
          ) {
            return reconciled;
          }

          /*
           * The previous Create Refund request may have reached Paystack
           * even though MOVA did not receive a response.
           *
           * Never issue a second refund automatically while the outcome
           * is uncertain.
           */
          throw new ServiceUnavailableException(
            'The card verification refund is still being reconciled.',
          );
        }

        throw new ServiceUnavailableException(
          'Unable to determine the card verification refund state.',
        );
      }

      case 'not_available':
        throw new ServiceUnavailableException(
          'The card verification payment is not ready for refund.',
        );

      case 'not_found':
        throw new ServiceUnavailableException(
          'The card verification setup could not be found for refund.',
        );

      case 'invalid':
        throw new ServiceUnavailableException(
          'The card verification refund request is invalid.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the card verification refund state.',
        );
    }
  }

  private async createRefund(
    reference: string,

    transactionId:
      string,
  ): Promise<
    NormalizedRefundStatus
  > {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        12_000,
      );

    let response:
      Response | null =
      null;

    let body:
      | PaystackCreateRefundResponse
      | null =
      null;

    let requestError:
      unknown =
      null;

    try {
      response =
        await fetch(
          'https://api.paystack.co/refund',
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

            /*
             * Intentionally omit "amount".
             *
             * Paystack treats this as a full refund of the transaction.
             */
            body:
              JSON.stringify({
                transaction:
                  transactionId,

                customer_note:
                  'MOVA card verification refund',

                merchant_note:
                  'Automatic refund for MOVA saved-card verification',
              }),

            signal:
              controller.signal,
          },
        );

      const rawResponse =
        await response.text();

      body =
        this.parseJson<
          PaystackCreateRefundResponse
        >(
          rawResponse,
        );
    } catch (
      error: unknown
    ) {
      requestError =
        error;
    } finally {
      clearTimeout(
        timeout,
      );
    }

    /*
     * Before interpreting a failed/uncertain Create Refund request,
     * check whether Paystack already created the refund.
     */
    if (
      requestError ||
      !response ||
      !response.ok ||
      body?.status !==
        true ||
      !body.data
    ) {
      const reconciled =
        await this.reconcileRefund(
          reference,
          transactionId,
        );

      if (
        reconciled
      ) {
        return reconciled;
      }

      if (
        response &&
        response.status >=
          400 &&
        response.status <
          500 &&
        response.status !==
          429
      ) {
        return this.recordRefund(
          reference,
          null,
          'failed',
          null,
        );
      }

      if (
        requestError instanceof
          Error &&
        requestError.name ===
          'AbortError'
      ) {
        throw new ServiceUnavailableException(
          'The card verification refund is still being reconciled after a provider timeout.',
        );
      }

      throw new ServiceUnavailableException(
        'The card verification refund is still being reconciled.',
      );
    }

    const refundId =
      this.safeRefundId(
        body.data.id,
      );

    const refundStatus =
      this.normalizeRefundStatus(
        body.data.status,
      );

    if (
      !refundId ||
      !refundStatus
    ) {
      const reconciled =
        await this.reconcileRefund(
          reference,
          transactionId,
        );

      if (
        reconciled
      ) {
        return reconciled;
      }

      throw new ServiceUnavailableException(
        'Paystack returned an invalid refund response.',
      );
    }

    return this.recordRefund(
      reference,
      refundId,
      refundStatus,
      this.optionalTimestamp(
        body.data
          .refunded_at,
      ),
    );
  }

  private async reconcileRefund(
    reference: string,

    transactionId:
      string,
  ): Promise<
    | NormalizedRefundStatus
    | null
  > {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        12_000,
      );

    try {
      const url =
        new URL(
          'https://api.paystack.co/refund',
        );

      url.searchParams.set(
        'transaction',
        transactionId,
      );

      url.searchParams.set(
        'perPage',
        '50',
      );

      url.searchParams.set(
        'page',
        '1',
      );

      const response =
        await fetch(
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

            signal:
              controller.signal,
          },
        );

      const rawResponse =
        await response.text();

      const body =
        this.parseJson<
          PaystackListRefundResponse
        >(
          rawResponse,
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
          'Unable to reconcile the card verification refund.',
        );
      }

      if (
        body.data.length ===
        0
      ) {
        return null;
      }

      if (
        body.data.length >
        1
      ) {
        this.logger.error(
          `Multiple Paystack refunds were found for standalone card setup transaction ${transactionId}.`,
        );

        throw new ServiceUnavailableException(
          'The card verification refund requires review.',
        );
      }

      const refund =
        body.data[0];

      const refundId =
        this.safeRefundId(
          refund.id,
        );

      const refundStatus =
        this.normalizeRefundStatus(
          refund.status,
        );

      if (
        !refundId ||
        !refundStatus
      ) {
        throw new ServiceUnavailableException(
          'Paystack returned an invalid refund during reconciliation.',
        );
      }

      return this.recordRefund(
        reference,
        refundId,
        refundStatus,
        this.optionalTimestamp(
          refund.refunded_at,
        ),
      );
    } catch (
      error: unknown
    ) {
      if (
        error instanceof
          ServiceUnavailableException
      ) {
        throw error;
      }

      if (
        error instanceof
          Error &&
        error.name ===
          'AbortError'
      ) {
        throw new ServiceUnavailableException(
          'Refund reconciliation timed out.',
        );
      }

      throw new ServiceUnavailableException(
        'Unable to reconcile the card verification refund.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private async recordRefund(
    reference: string,

    refundId:
      | string
      | null,

    refundStatus:
      NormalizedRefundStatus,

    refundedAt:
      | string
      | null,
  ): Promise<
    NormalizedRefundStatus
  > {
    const admin =
      this.supabase.createAdminClient();

    const {
      data,
      error,
    } =
      await admin.rpc(
        'record_payment_method_setup_refund',
        {
          p_provider_reference:
            reference,

          p_provider_refund_id:
            refundId,

          p_refund_status:
            refundStatus,

          p_refunded_at:
            refundedAt,
        },
      );

    if (
      error ||
      !data
    ) {
      throw new ServiceUnavailableException(
        'Unable to record the card verification refund right now.',
      );
    }

    const result =
      data as
        RecordRefundResult;

    switch (
      result.status
    ) {
      case 'updated':
      case 'existing': {
        const stored =
          this.normalizeRefundStatus(
            result.refundStatus,
          );

        if (!stored) {
          throw new ServiceUnavailableException(
            'Unable to determine the stored refund state.',
          );
        }

        return stored;
      }

      case 'not_found':
        throw new ServiceUnavailableException(
          'The card verification setup could not be matched to this refund.',
        );

      case 'not_available':
        throw new ServiceUnavailableException(
          'The card verification payment is not available for refund.',
        );

      case 'conflict':
        this.logger.error(
          'A Paystack refund ID conflicts with the stored MOVA card setup refund.',
        );

        throw new ServiceUnavailableException(
          'The card verification refund requires review.',
        );

      case 'invalid':
        throw new ServiceUnavailableException(
          'The card verification refund data was invalid.',
        );

      default:
        throw new ServiceUnavailableException(
          'Unable to determine the stored refund state.',
        );
    }
  }

  private refundStatusFromEvent(
    eventName: string,
  ):
    | NormalizedRefundStatus
    | null {
    switch (
      eventName
    ) {
      case 'refund.pending':
        return 'pending';

      case 'refund.processing':
        return 'processing';

      case 'refund.needs-attention':
        return 'needs_attention';

      case 'refund.processed':
        return 'processed';

      case 'refund.failed':
        return 'failed';

      default:
        return null;
    }
  }

  private normalizeRefundStatus(
    value:
      unknown,
  ):
    | NormalizedRefundStatus
    | null {
    if (
      typeof value !==
        'string'
    ) {
      return null;
    }

    const cleaned =
      value
        .trim()
        .toLowerCase()
        .replace(
          /-/g,
          '_',
        );

    switch (
      cleaned
    ) {
      case 'pending':
      case 'processing':
      case 'needs_attention':
      case 'processed':
      case 'failed':
        return cleaned;

      default:
        return null;
    }
  }

  private async verifyTransaction(
    reference: string,
  ): Promise<
    VerifiedTransaction
  > {
    if (
      !this.isConfigured()
    ) {
      throw new ServiceUnavailableException(
        'Paystack card verification is not configured.',
      );
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        12_000,
      );

    try {
      const response =
        await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(
            reference,
          )}`,
          {
            method:
              'GET',

            headers: {
              Authorization:
                `Bearer ${this.secretKey}`,

              Accept:
                'application/json',
            },

            signal:
              controller.signal,
          },
        );

      const rawResponse =
        await response.text();

      const body =
        this.parseVerifyResponse(
          rawResponse,
        );

      if (
        !response.ok ||
        body?.status !==
          true ||
        !body.data
      ) {
        throw new ServiceUnavailableException(
          'Card verification is temporarily unavailable.',
        );
      }

      return body.data;
    } catch (
      error: unknown
    ) {
      if (
        error instanceof
          ServiceUnavailableException
      ) {
        throw error;
      }

      if (
        error instanceof
          Error &&
        error.name ===
          'AbortError'
      ) {
        throw new ServiceUnavailableException(
          'Card verification timed out.',
        );
      }

      throw new ServiceUnavailableException(
        'Card verification is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }
  }

  private parseVerifyResponse(
    rawResponse: string,
  ):
    | PaystackVerifyResponse
    | null {
    try {
      /*
       * Preserve Paystack transaction IDs beyond JS safe integer range.
       */
      const safeJson =
        rawResponse.replace(
          /("id"\s*:\s*)(\d+)/,
          '$1"$2"',
        );

      return JSON.parse(
        safeJson,
      ) as
        PaystackVerifyResponse;
    } catch {
      return null;
    }
  }

  private parseReusableCard(
    verified:
      VerifiedTransaction,
  ):
    | ReusableCard
    | null {
    const authorization =
      verified.authorization;

    const customer =
      verified.customer;

    if (
      !authorization ||
      !customer ||
      authorization.reusable !==
        true
    ) {
      return null;
    }

    const channel =
      this.cleanString(
        authorization.channel,
      )
        ?.toLowerCase();

    if (
      channel !==
      'card'
    ) {
      return null;
    }

    const customerCode =
      this.cleanString(
        customer.customer_code,
      );

    const email =
      this.cleanString(
        customer.email,
      )
        ?.toLowerCase();

    const authorizationCode =
      this.cleanString(
        authorization.authorization_code,
      );

    const signature =
      this.cleanString(
        authorization.signature,
      );

    const brand =
      this.cleanString(
        authorization.brand,
      );

    const cardType =
      this.cleanString(
        authorization.card_type,
      );

    const network =
      (
        brand ??
        cardType ??
        ''
      )
        .trim()
        .toLowerCase();

    const last4 =
      this.cleanString(
        authorization.last4,
      );

    const expMonth =
      this.safeSmallInteger(
        authorization.exp_month,
      );

    const expYear =
      this.safeSmallInteger(
        authorization.exp_year,
      );

    const bank =
      this.optionalLimitedString(
        authorization.bank,
        120,
      );

    const countryCode =
      this.optionalCountryCode(
        authorization.country_code,
      );

    if (
      !customerCode ||
      customerCode.length >
        120 ||
      !email ||
      !this.isReasonableEmail(
        email,
      ) ||
      !authorizationCode ||
      authorizationCode.length >
        200 ||
      !signature ||
      signature.length >
        200 ||
      network.length <
        1 ||
      network.length >
        40 ||
      !last4 ||
      !/^[0-9]{4}$/.test(
        last4,
      ) ||
      expMonth ===
        null ||
      expMonth <
        1 ||
      expMonth >
        12 ||
      expYear ===
        null ||
      expYear <
        2020 ||
      expYear >
        2200
    ) {
      return null;
    }

    return {
      customerCode,

      email,

      authorizationCode,

      signature,

      network,

      last4,

      expMonth,

      expYear,

      bank,

      countryCode,
    };
  }

  private safeTransactionId(
    value:
      | string
      | number
      | undefined,
  ) {
    if (
      typeof value ===
        'string' &&
      /^\d{1,30}$/.test(
        value,
      )
    ) {
      return value;
    }

    if (
      typeof value ===
        'number' &&
      Number.isSafeInteger(
        value,
      ) &&
      value >
        0
    ) {
      return String(
        value,
      );
    }

    throw new ServiceUnavailableException(
      'Paystack returned an invalid transaction ID.',
    );
  }

  private requireTransactionId(
    value:
      | string
      | null
      | undefined,
  ) {
    if (
      typeof value !==
        'string' ||
      !/^\d{1,30}$/.test(
        value,
      )
    ) {
      throw new ServiceUnavailableException(
        'The stored Paystack transaction ID is invalid.',
      );
    }

    return value;
  }

  private safeRefundId(
    value:
      unknown,
  ) {
    if (
      typeof value ===
        'string' &&
      /^\d{1,30}$/.test(
        value,
      )
    ) {
      return value;
    }

    if (
      typeof value ===
        'number' &&
      Number.isSafeInteger(
        value,
      ) &&
      value >
        0
    ) {
      return String(
        value,
      );
    }

    return null;
  }

  private safeAmount(
    value:
      | number
      | undefined,

    label: string,
  ) {
    if (
      !Number.isSafeInteger(
        value,
      ) ||
      (value ?? 0) <=
        0
    ) {
      throw new ServiceUnavailableException(
        `Paystack returned an invalid ${label}.`,
      );
    }

    return value as
      number;
  }

  private safeCurrency(
    value:
      | string
      | undefined,
  ) {
    const currency =
      value
        ?.trim()
        .toUpperCase() ??
      '';

    if (
      !/^[A-Z]{3}$/.test(
        currency,
      )
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payment currency.',
      );
    }

    return currency;
  }

  private safeChannel(
    value:
      | string
      | undefined,
  ) {
    const channel =
      value
        ?.trim()
        .toLowerCase() ??
      '';

    if (
      channel.length <
        1 ||
      channel.length >
        40
    ) {
      throw new ServiceUnavailableException(
        'Paystack returned an invalid payment channel.',
      );
    }

    return channel;
  }

  private safePaidAt(
    value:
      | string
      | null
      | undefined,
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
        'Paystack returned an invalid payment timestamp.',
      );
    }

    return new Date(
      value,
    ).toISOString();
  }

  private optionalTimestamp(
    value:
      unknown,
  ) {
    if (
      typeof value !==
        'string'
    ) {
      return null;
    }

    if (
      !Number.isFinite(
        Date.parse(
          value,
        ),
      )
    ) {
      return null;
    }

    return new Date(
      value,
    ).toISOString();
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

  private optionalLimitedString(
    value:
      unknown,

    maxLength:
      number,
  ) {
    const cleaned =
      this.cleanString(
        value,
      );

    if (!cleaned) {
      return null;
    }

    if (
      cleaned.length >
      maxLength
    ) {
      return null;
    }

    return cleaned;
  }

  private optionalCountryCode(
    value:
      unknown,
  ) {
    const cleaned =
      this.cleanString(
        value,
      )
        ?.toUpperCase();

    if (!cleaned) {
      return null;
    }

    if (
      !/^[A-Z]{2}$/.test(
        cleaned,
      )
    ) {
      return null;
    }

    return cleaned;
  }

  private safeSmallInteger(
    value:
      unknown,
  ) {
    if (
      typeof value ===
        'number'
    ) {
      return Number.isSafeInteger(
        value,
      )
        ? value
        : null;
    }

    if (
      typeof value ===
        'string' &&
      /^\d{1,4}$/.test(
        value.trim(),
      )
    ) {
      const parsed =
        Number(
          value,
        );

      return Number.isSafeInteger(
        parsed,
      )
        ? parsed
        : null;
    }

    return null;
  }

  private isReasonableEmail(
    email:
      string,
  ) {
    return (
      email.length >=
        3 &&
      email.length <=
        320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        email,
      )
    );
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