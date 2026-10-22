// Отправка писем: SMTP через nodemailer, `log://` — лог вместо письма (только localhost).
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import nodemailer, { type Transporter } from "nodemailer";
import { AppConfig } from "../config";

/** Письмо: получатель, тема, текстовая и HTML-версия (без картинок и внешних ссылок). */
export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Отправка письма не удалась (SMTP недоступен, отказ сервера и т.п.). */
export class MailError extends Schema.TaggedError<MailError>()("MailError", {
  reason: Schema.String,
}) {}

/** Сервис отправки почты (коды входа, подтверждение смены e-mail и т.п.). */
export class Mailer extends Context.Service<
  Mailer,
  { readonly send: (mail: Mail) => Effect.Effect<void, MailError> }
>()("@cg/api/Mailer") {
  static readonly layer: Layer.Layer<Mailer, MailerConfigError, AppConfig> =
    Layer.effect(
      Mailer,
      Effect.gen(function* () {
        const config = yield* AppConfig;
        const smtpUrl = Redacted.value(config.smtpUrl);
        if (!isLogTransportAllowed(smtpUrl, config.publicUrl))
          return yield* Effect.fail(
            new MailerConfigError({
              reason: `SMTP_URL=${LOG_TRANSPORT} запрещён вне localhost (PUBLIC_URL=${config.publicUrl})`,
            }),
          );
        return makeMailer({ smtpUrl, from: config.mailFrom });
      }),
    );
}

/** `SMTP_URL`, означающий «писать письма в лог» вместо реальной отправки. */
export const LOG_TRANSPORT = "log://";

/**
 * `log://` разрешён только для локальной разработки: любой другой `smtpUrl`
 * — всегда ок, а `log://` — только если `publicUrl` смотрит на localhost;
 * иначе письма (коды входа и т.п.) в проде просто не дойдут до пользователя.
 */
export const isLogTransportAllowed = (
  smtpUrl: string,
  publicUrl: string,
): boolean => {
  if (smtpUrl !== LOG_TRANSPORT) return true;
  const hostname = new URL(publicUrl).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
};

/** Слой `Mailer` отказался подниматься: `log://` запрещён вне localhost. */
export class MailerConfigError extends Schema.TaggedError<MailerConfigError>()(
  "MailerConfigError",
  { reason: Schema.String },
) {}

/**
 * Собрать сервис `Mailer`: `smtpUrl === LOG_TRANSPORT` — пишет письмо в лог
 * (`Effect.logInfo`) и никогда не падает; иначе отправляет через nodemailer
 * (готовый `transport` — для тестов, иначе строится из `smtpUrl`).
 */
export const makeMailer = (options: {
  readonly smtpUrl: string;
  readonly from: string;
  readonly transport?: Transporter;
}): Mailer["Service"] => {
  const send = (mail: Mail): Effect.Effect<void, MailError> => {
    if (options.smtpUrl === LOG_TRANSPORT)
      return Effect.logInfo("mail", {
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });

    const transport =
      options.transport ?? nodemailer.createTransport(options.smtpUrl);
    return Effect.tryPromise({
      try: () =>
        transport.sendMail({
          from: options.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }),
      catch: (cause) => new MailError({ reason: String(cause) }),
    }).pipe(Effect.asVoid);
  };

  return Mailer.of({ send });
};
