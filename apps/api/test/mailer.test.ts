// Тесты Mailer: log-транспорт, SMTP через nodemailer, ошибки, шаблоны писем.
import { describe, expect, it } from "bun:test";
import { Effect, Logger } from "effect";
import nodemailer from "nodemailer";
import {
  isLogTransportAllowed,
  LOG_TRANSPORT,
  MailError,
  makeMailer,
} from "../src/mail/Mailer";
import { loginCodeMail } from "../src/mail/templates";

/** Перехватывает лог-сообщения вместо их вывода, для проверки log-транспорта. */
const captureLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>((options) => {
    const message = Array.isArray(options.message)
      ? options.message
          .map((part) =>
            typeof part === "string" ? part : JSON.stringify(part),
          )
          .join(" ")
      : String(options.message);
    lines.push(message);
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("makeMailer", () => {
  it("log transport writes the letter to the log and never fails", async () => {
    const mailer = makeMailer({
      smtpUrl: LOG_TRANSPORT,
      from: "GameCrate <no-reply@example.com>",
    });
    const { lines, layer } = captureLogs();

    await Effect.runPromise(
      mailer
        .send({
          to: "ivan@example.com",
          subject: "Код для входа в GameCrate",
          text: "123456",
          html: "<p>123456</p>",
        })
        .pipe(Effect.provide(layer)),
    );

    const logged = lines.join(" ");
    expect(logged).toContain("ivan@example.com");
    expect(logged).toContain("Код для входа в GameCrate");
  });

  it("smtp transport passes from/to/subject to nodemailer", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    let captured: Record<string, unknown> | undefined;
    const originalSendMail = transport.sendMail.bind(transport);
    // Шпион: запоминает аргумент sendMail, но реально вызывает исходный метод.
    transport.sendMail = ((mailOptions: Record<string, unknown>) => {
      captured = mailOptions;
      return originalSendMail(mailOptions as never);
    }) as typeof transport.sendMail;

    const mailer = makeMailer({
      smtpUrl: "smtps://u:p@mail.example:465",
      from: "GameCrate <no-reply@example.com>",
      transport,
    });

    await Effect.runPromise(
      mailer.send({
        to: "ivan@example.com",
        subject: "Код для входа в GameCrate",
        text: "123456",
        html: "<p>123456</p>",
      }),
    );

    expect(captured?.from).toBe("GameCrate <no-reply@example.com>");
    expect(captured?.to).toBe("ivan@example.com");
    expect(captured?.subject).toBe("Код для входа в GameCrate");
  });

  it("smtp failure becomes MailError", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof transport.sendMail;

    const mailer = makeMailer({
      smtpUrl: "smtps://u:p@mail.example:465",
      from: "GameCrate <no-reply@example.com>",
      transport,
    });

    const result = await Effect.runPromise(
      mailer
        .send({
          to: "ivan@example.com",
          subject: "Код для входа в GameCrate",
          text: "123456",
          html: "<p>123456</p>",
        })
        .pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toBeInstanceOf(MailError);
    expect((result.failure as MailError).reason).toContain("ECONNREFUSED");
  });

  it("log transport is rejected outside localhost", () => {
    expect(isLogTransportAllowed("log://", "https://game.brofrong.ru")).toBe(
      false,
    );
    expect(isLogTransportAllowed("log://", "http://localhost:3000")).toBe(true);
    expect(
      isLogTransportAllowed(
        "smtps://u:p@mail.example:465",
        "https://game.brofrong.ru",
      ),
    ).toBe(true);
  });

  it("login code mail contains the code and the ttl", () => {
    const mail = loginCodeMail("123456");
    expect(mail.subject).toBe("Код для входа в GameCrate");
    expect(mail.text).toContain("123456");
    expect(mail.text).toContain("10 минут");
    expect(mail.html).toContain("123456");
  });
});
