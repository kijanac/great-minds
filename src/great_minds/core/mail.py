"""Mail delivery infrastructure."""

import logging

from mailersend import Email, EmailBuilder, MailerSendClient

from great_minds.core.settings import Settings

log = logging.getLogger(__name__)


class Mailer:
    def __init__(self, settings: Settings) -> None:
        self.api_key = settings.mailersend_api_key
        self.from_email = settings.mailersend_from_email

    def send(self, to: str, subject: str, body: str) -> None:
        if self.api_key is None or self.from_email is None:
            log.warning(
                "mailersend not configured — logging email: to=%s subject=%s",
                to,
                subject,
            )
            return

        client = MailerSendClient(api_key=self.api_key)
        email = (
            EmailBuilder()
            .from_email(self.from_email)
            .to_many([{"email": to}])
            .subject(subject)
            .text(body)
            .build()
        )
        Email(client).send(email)
