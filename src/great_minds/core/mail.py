"""Mail delivery via Resend."""

import logging

import resend

from great_minds.core.settings import Settings

log = logging.getLogger(__name__)


class Mailer:
    def __init__(self, settings: Settings) -> None:
        self.api_key = settings.resend_api_key
        self.from_email = settings.resend_from_email

    def send(self, to: str, subject: str, body: str) -> None:
        if self.api_key is None or self.from_email is None:
            log.warning(
                "resend not configured — logging email: to=%s subject=%s",
                to,
                subject,
            )
            return

        resend.api_key = self.api_key
        resend.Emails.send(
            {
                "from": self.from_email,
                "to": [to],
                "subject": subject,
                "text": body,
            }
        )
