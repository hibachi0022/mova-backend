import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  /*
   * rawBody is required for Paystack webhook signature verification.
   *
   * Paystack signs the exact HTTP request body. Re-serializing parsed
   * JSON is not guaranteed to reproduce the same byte sequence.
   */
  const app = await NestFactory.create(
    AppModule,
    {
      rawBody: true,
    },
  );

  app.setGlobalPrefix(
    'api/v1',
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: {
        target: false,
        value: false,
      },
    }),
  );

  await app.listen(
    process.env.PORT ??
      4001,
  );
}

void bootstrap();