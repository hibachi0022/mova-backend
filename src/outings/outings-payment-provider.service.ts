import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OutingPaymentMethodId,
} from './dto/outing-checkout.dto';

export type OutingPaymentChoice = {
  id:
    OutingPaymentMethodId;
  label: string;
  available: boolean;
  reason?: string;
};

export type ProviderCheckoutInput = {
  intentId: string;
  outingId: string;
  email: string;
  amountMinor: number;
  currency: string;
  methodId:
    OutingPaymentMethodId;
  expiresAt: string;
};

export type ProviderCheckoutResult = {
  provider: 'paystack';
  providerCheckoutId:
    string;
  providerReference:
    string;
  checkoutUrl: string;
  expiresAt: string;
};

type PaystackChannel =
  | 'card'
  | 'bank_transfer'
  | 'apple_pay';

type PaystackInitializeResponse = {
  status?: boolean;
  message?: string;
  data?: {
    authorization_url?:
      string;
    access_code?:
      string;
    reference?:
      string;
  };
};

const METHOD_LABELS:
Record<
  OutingPaymentMethodId,
  string
> = {
  nfc:
    'NFC PAYMENT',
  apple_pay:
    'Apple Pay',
  google_pay:
    'Google Pay',
  paypal:
    'PayPal',
  bank_transfer:
    'Bank transfer',
  card:
    'Card',
};

const PAYSTACK_CHANNELS:
Partial<
  Record<
    OutingPaymentMethodId,
    PaystackChannel
  >
> = {
  apple_pay:
    'apple_pay',
  bank_transfer:
    'bank_transfer',
  card:
    'card',
};

@Injectable()
export class OutingsPaymentProviderService {
  private readonly logger =
    new Logger(
      OutingsPaymentProviderService.name,
    );

  private readonly secretKey:
    string;

  private readonly enabledMethods:
    Set<
      OutingPaymentMethodId
    >;

  private readonly enabledCurrencies:
    Set<string>;

  constructor(
    private readonly config:
      ConfigService,
  ) {
    this.secretKey =
      this.config
        .get<string>(
          'PAYSTACK_SECRET_KEY',
        )
        ?.trim() ??
      '';

    /*
     * Card is the conservative
     * default once Paystack is
     * connected.
     *
     * Additional methods are enabled
     * explicitly after confirming the
     * merchant account supports them.
     */
    this.enabledMethods =
      new Set(
        this.parseMethods(
          this.config.get<string>(
            'PAYSTACK_OUTING_METHODS',
          ) ??
            'card',
        ),
      );

    /*
     * MOVA's first payment version
     * currently targets NGN.
     */
    this.enabledCurrencies =
      new Set(
        this.parseCurrencies(
          this.config.get<string>(
            'PAYSTACK_OUTING_CURRENCIES',
          ) ??
            'NGN',
        ),
      );
  }

  choices(input: {
    currency: string;
    amountMinor: number;
    hasSelectedPayer:
      boolean;
  }): {
    methods:
      OutingPaymentChoice[];
  } {
    const methodIds:
      OutingPaymentMethodId[] =
      [
        'nfc',
        'apple_pay',
        'google_pay',
        'paypal',
        'bank_transfer',
        'card',
      ];

    const methods =
      methodIds.map(
        (
          methodId,
        ): OutingPaymentChoice => {
          if (
            input.amountMinor <=
            0
          ) {
            return {
              id:
                methodId,
              label:
                METHOD_LABELS[
                  methodId
                ],
              available:
                false,
              reason:
                'This outing has no bill to pay.',
            };
          }

          if (
            !input.hasSelectedPayer
          ) {
            return {
              id:
                methodId,
              label:
                METHOD_LABELS[
                  methodId
                ],
              available:
                false,
              reason:
                'Pick the payer before starting payment.',
            };
          }

          const availability =
            this.availability(
              methodId,
              input.currency,
            );

          return {
            id:
              methodId,
            label:
              METHOD_LABELS[
                methodId
              ],
            available:
              availability.available,
            ...(availability.reason
              ? {
                  reason:
                    availability.reason,
                }
              : {}),
          };
        },
      );

    return {
      methods,
    };
  }

  availability(
    methodId:
      OutingPaymentMethodId,
    currency: string,
  ): {
    available: boolean;
    reason?: string;
  } {
    const channel =
      PAYSTACK_CHANNELS[
        methodId
      ];

    if (!channel) {
      return {
        available:
          false,
        reason:
          `${METHOD_LABELS[methodId]} is not connected to the current payment provider yet.`,
      };
    }

    if (
      !this.isConfigured()
    ) {
      return {
        available:
          false,
        reason:
          'Secure outing payments are not connected yet.',
      };
    }

    if (
      !this.enabledCurrencies.has(
        currency.toUpperCase(),
      )
    ) {
      return {
        available:
          false,
        reason:
          `Payments in ${currency.toUpperCase()} are not enabled yet.`,
      };
    }

    if (
      !this.enabledMethods.has(
        methodId,
      )
    ) {
      return {
        available:
          false,
        reason:
          `${METHOD_LABELS[methodId]} is not enabled for MOVA yet.`,
      };
    }

    return {
      available:
        true,
    };
  }

  async initializeCheckout(
    input:
      ProviderCheckoutInput,
  ): Promise<
    ProviderCheckoutResult
  > {
    const availability =
      this.availability(
        input.methodId,
        input.currency,
      );

    if (
      !availability.available
    ) {
      throw new ServiceUnavailableException(
        availability.reason ??
          'This payment method is unavailable.',
      );
    }

    const channel =
      PAYSTACK_CHANNELS[
        input.methodId
      ];

    if (!channel) {
      throw new ServiceUnavailableException(
        'This payment method is unavailable.',
      );
    }

    const reference =
      `MOVA-${input.intentId.replace(
        /-/g,
        '',
      )}`;

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
          'https://api.paystack.co/transaction/initialize',
          {
            method:
              'POST',
            headers: {
              Authorization:
                `Bearer ${this.secretKey}`,
              'Content-Type':
                'application/json',
            },
            body:
              JSON.stringify({
                email:
                  input.email,
                amount:
                  String(
                    input.amountMinor,
                  ),
                currency:
                  input.currency,
                reference,
                channels: [
                  channel,
                ],
                metadata:
                  JSON.stringify(
                    {
                      movaIntentId:
                        input.intentId,
                      movaOutingId:
                        input.outingId,
                    },
                  ),
              }),
            signal:
              controller.signal,
          },
        );

      let body:
        | PaystackInitializeResponse
        | null =
        null;

      try {
        body =
          (await response.json()) as
            PaystackInitializeResponse;
      } catch {
        body =
          null;
      }

      if (
        !response.ok ||
        body?.status !==
          true ||
        typeof body.data
          ?.authorization_url !==
          'string' ||
        typeof body.data
          ?.access_code !==
          'string' ||
        typeof body.data
          ?.reference !==
          'string'
      ) {
        this.logger.warn(
          `Paystack transaction initialization failed with HTTP ${response.status}.`,
        );

        throw new ServiceUnavailableException(
          'Secure checkout is temporarily unavailable.',
        );
      }

      const checkoutUrl =
        this.validateCheckoutUrl(
          body.data
            .authorization_url,
        );

      return {
        provider:
          'paystack',
        providerCheckoutId:
          body.data
            .access_code,
        providerReference:
          body.data.reference,
        checkoutUrl,
        expiresAt:
          input.expiresAt,
      };
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
          'Secure checkout timed out. Please try again.',
        );
      }

      this.logger.warn(
        'Unable to reach Paystack transaction initialization.',
      );

      throw new ServiceUnavailableException(
        'Secure checkout is temporarily unavailable.',
      );
    } finally {
      clearTimeout(
        timeout,
      );
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

  private validateCheckoutUrl(
    rawUrl: string,
  ) {
    try {
      const url =
        new URL(
          rawUrl,
        );

      if (
        url.protocol !==
          'https:' ||
        url.username ||
        url.password
      ) {
        throw new Error();
      }

      return url.toString();
    } catch {
      throw new ServiceUnavailableException(
        'The payment provider returned an invalid checkout link.',
      );
    }
  }

  private parseMethods(
    input: string,
  ): OutingPaymentMethodId[] {
    const allowed =
      new Set<
        OutingPaymentMethodId
      >([
        'nfc',
        'apple_pay',
        'google_pay',
        'paypal',
        'bank_transfer',
        'card',
      ]);

    const methods =
      input
        .split(',')
        .map(
          (value) =>
            value
              .trim()
              .toLowerCase(),
        )
        .filter(
          (
            value,
          ): value is
            OutingPaymentMethodId =>
            allowed.has(
              value as
                OutingPaymentMethodId,
            ),
        );

    return [
      ...new Set(
        methods,
      ),
    ];
  }

  private parseCurrencies(
    input: string,
  ) {
    return [
      ...new Set(
        input
          .split(',')
          .map(
            (value) =>
              value
                .trim()
                .toUpperCase(),
          )
          .filter(
            (value) =>
              /^[A-Z]{3}$/.test(
                value,
              ),
          ),
      ),
    ];
  }
}