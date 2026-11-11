/**
 * Alertas al equipo cuando un job muere.
 * TODO(subtarea 10): implementar EmailNotifier (SMTP del correo de Hostinger) y elegirlo por config.
 */
export interface Notifier {
  alert(subject: string, body: string): Promise<void>;
}

type Logger = { error: (obj: object, msg: string) => void };

export class LogNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  async alert(subject: string, body: string): Promise<void> {
    this.log.error({ alert: true, body }, `ALERTA: ${subject}`);
  }
}
